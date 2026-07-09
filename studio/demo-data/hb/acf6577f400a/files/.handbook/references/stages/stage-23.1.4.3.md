# App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations  `stage-23.1.4.3`

This stage is a behind-the-scenes safety net for the app server’s extension system. It tests the places where the server lets outside add-ons, tools, and local commands become part of a conversation. The plugin tests cover the full plugin life cycle: listing, reading details and skills, installing, sharing, uninstalling, and syncing with local or remote catalogs. The marketplace tests check adding, removing, and upgrading collections of plugins. App listing checks that connector apps and fake tool servers appear correctly.

Other tests check discovery features. Hooks tests make sure startup or project actions can be listed, trusted, enabled, or disabled. Skills tests confirm that instruction packs from users, workspaces, plugins, or executor choices are found without the wrong one taking over. MCP tests cover outside tool servers: their status, tools, resources, permission questions, and thread-specific visibility.

The remaining tests exercise tool execution. They check shell commands, packaged zsh commands, fuzzy file search, image generation, sleep, and web search. Together, these tests make sure extensions behave like well-labeled tools in a workshop: visible when allowed, hidden when not, and safe to use.

## Files in this stage

### Plugin catalog and lifecycle
These suites cover discovering plugins and marketplaces, reading plugin details, installing and removing plugins, sharing them, and upgrading or deleting marketplace-backed content.

### `app-server/tests/suite/v2/plugin_list.rs`

`test` · `test run`

This test file acts like a careful shopper checking every aisle of the plugin system. It starts temporary app-server instances, creates fake home folders and workspaces, writes small marketplace and plugin manifest files, and uses a fake HTTP server to stand in for ChatGPT backend services. Then it sends JSON-RPC requests such as `plugin/list` and `plugin/installed` and checks the exact response.

The tests cover both local plugins stored on disk and remote plugins returned by backend API calls. They verify that bad marketplace files do not poison good ones, that installed and enabled state comes from the right config, that plugin interface details like icons and prompts are converted correctly, and that remote plugin catalogs are cached and refreshed. They also test feature gates: if plugins, remote plugins, workspace directory plugins, or sharing are disabled, the app server must avoid returning or even fetching those plugins.

The helper functions at the bottom are the test workshop. They write config files, build fake marketplaces, mount mock HTTP routes, create tiny compressed plugin bundles, and wait for asynchronous background work to finish. Without this suite, regressions in plugin discovery, sharing, remote catalog behavior, or bundle syncing could silently change what users see in the plugin UI.

#### Function details

##### `write_plugins_enabled_config`  (lines 49–56)

```
fn write_plugins_enabled_config(codex_home: &std::path::Path) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config file that turns the plugin feature on. Tests use it when they want the app server to discover plugins without adding remote-server settings.

**Data flow**: It receives a Codex home directory path, writes `config.toml` inside it with `[features] plugins = true`, and returns whether the file write succeeded.

**Call relations**: Many local-marketplace tests call this during setup before starting `TestAppServer`, so later `plugin/list` requests exercise plugin discovery instead of being blocked by the feature flag.

*Call graph*: called by 7 (plugin_list_accepts_legacy_string_default_prompt, plugin_list_accepts_omitted_cwds, plugin_list_keeps_valid_marketplaces_when_another_marketplace_fails_to_load, plugin_list_returns_plugin_interface_with_absolute_asset_paths, plugin_list_returns_share_context_for_shared_local_plugin, plugin_list_skips_invalid_marketplace_file_and_reports_error, plugin_list_uses_alternate_discoverable_manifest_and_keeps_undiscoverable_plugins); 2 external calls (join, write).


##### `write_plugins_enabled_config_with_base_url`  (lines 58–72)

```
fn write_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a config file that enables plugins and points backend API calls at a test server. Tests use it when the app server needs to call mocked ChatGPT endpoints.

**Data flow**: It takes a Codex home path and a base URL, writes both the URL and plugin feature flag into `config.toml`, and reports any file-writing error.

**Call relations**: Remote and workspace-setting tests call this before mounting wiremock routes, so app-server requests are sent to the fake server instead of the real network.

*Call graph*: called by 8 (plugin_list_does_not_query_openai_curated_remote_collection_by_default, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag, plugin_list_includes_openai_curated_remote_collection_when_requested, plugin_list_propagates_explicit_openai_curated_remote_collection_errors, plugin_list_returns_empty_when_workspace_codex_plugins_disabled, plugin_list_reuses_cached_workspace_codex_plugins_setting, plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth); 3 external calls (join, format!, write).


##### `plugin_list_skips_invalid_marketplace_file_and_reports_error`  (lines 75–130)

```
async fn plugin_list_skips_invalid_marketplace_file_and_reports_error() -> Result<()>
```

**Purpose**: Checks that one malformed local marketplace file is not returned as a real marketplace, but is still reported as a load error. This protects users from a broken JSON file silently looking like an empty marketplace.

**Data flow**: The test creates a workspace with an invalid `marketplace.json`, starts the server, sends `plugin/list`, and checks that the response omits that marketplace while including one error pointing at the bad file.

**Call relations**: The async test harness runs it directly. It uses the plugin-enabled config helper, starts `TestAppServer`, sends a plugin-list request, and converts the JSON-RPC response into a typed plugin-list response for assertions.

*Call graph*: calls 3 internal fn (new_with_env, write_plugins_enabled_config, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_installed_includes_installed_plugins_and_explicit_install_suggestions`  (lines 133–183)

```
async fn plugin_installed_includes_installed_plugins_and_explicit_install_suggestions() -> Result<()>
```

**Purpose**: Verifies that `plugin/installed` shows already installed plugins and also includes explicitly suggested plugins that are not installed yet. This supports UI flows that recommend a plugin alongside the user's current installs.

**Data flow**: The test creates a curated marketplace, marks one plugin installed and enabled, asks for an install suggestion by name, and checks that both the installed plugin and suggested plugin appear with correct installed/enabled flags.

**Call relations**: The test harness calls it. It relies on helpers that write a curated marketplace and installed-plugin cache, then sends a `plugin/installed` request through `TestAppServer`.

*Call graph*: calls 3 internal fn (new, write_installed_plugin, write_openai_curated_marketplace); 7 external calls (new, Integer, to_response, assert_eq!, write, timeout, vec!).


##### `plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled`  (lines 186–285)

```
async fn plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Checks conflict resolution when the same curated plugin exists locally and remotely. If remote plugins are enabled and a remote version is installed, the response should prefer the remote marketplace entry rather than duplicating it locally.

**Data flow**: The test creates local curated plugins, marks them enabled, mocks remote installed plugins including one with the same name, sends `plugin/installed`, and checks that the conflicting plugin moves to the remote marketplace while non-conflicting local plugins remain local.

**Call relations**: The test harness runs it. It combines local cache helpers, mocked remote installed-plugin routes, and the response conversion helper to verify the server's merge behavior.

*Call graph*: calls 8 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, remote_installed_plugin_body, write_installed_plugin, write_openai_curated_marketplace); 12 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, json!, to_string (+2 more)).


##### `plugin_installed_ignores_local_cache_without_catalog`  (lines 288–321)

```
async fn plugin_installed_ignores_local_cache_without_catalog() -> Result<()>
```

**Purpose**: Ensures cached plugin files alone do not make a plugin appear installed if there is no marketplace catalog describing it. This avoids showing stray or stale cache folders as valid plugins.

**Data flow**: The test writes an installed-plugin cache folder and config entry but no marketplace, sends `plugin/installed`, and expects no marketplaces and no load errors.

**Call relations**: The test harness calls it. It uses `write_installed_plugin` for setup, then checks the app server's installed-plugin response.

*Call graph*: calls 2 internal fn (new, write_installed_plugin); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


##### `plugin_list_rejects_relative_cwds`  (lines 324–347)

```
async fn plugin_list_rejects_relative_cwds() -> Result<()>
```

**Purpose**: Checks that `plugin/list` rejects relative current-working-directory paths. The server requires absolute paths so it knows exactly which workspace is being described.

**Data flow**: The test sends a raw request with `cwds` set to `relative-root`, waits for an error response, and verifies it is an invalid-request error.

**Call relations**: The test harness runs it directly. Unlike most tests, it sends a raw JSON-RPC request to test request validation before normal plugin-list handling.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, json!, timeout).


##### `plugin_list_keeps_valid_marketplaces_when_another_marketplace_fails_to_load`  (lines 350–469)

```
async fn plugin_list_keeps_valid_marketplaces_when_another_marketplace_fails_to_load() -> Result<()>
```

**Purpose**: Verifies that one broken marketplace file does not prevent another valid marketplace from being listed. This makes plugin discovery resilient across multiple workspaces.

**Data flow**: The test creates one valid workspace marketplace and one invalid JSON file, sends both workspace paths in `plugin/list`, and checks that the valid plugin is returned while the bad file is recorded as a load error.

**Call relations**: The test harness calls it. It uses config-writing and path-conversion helpers, then asserts the full typed marketplace response.

*Call graph*: calls 3 internal fn (new_with_env, write_plugins_enabled_config, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_returns_empty_when_workspace_codex_plugins_disabled`  (lines 472–553)

```
async fn plugin_list_returns_empty_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Checks that an account-level backend setting can disable workspace Codex plugins. When that setting is off, local workspace marketplaces should not be returned.

**Data flow**: The test writes a local marketplace, mocks the account settings endpoint to return `enable_plugins: false`, sends `plugin/list`, and expects an entirely empty response.

**Call relations**: The test harness runs it. It uses the base-URL config helper, ChatGPT auth fixture, and a mock HTTP route for account settings.

*Call graph*: calls 3 internal fn (new, new_without_managed_config_with_env, write_plugins_enabled_config_with_base_url); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, create_dir_all (+6 more)).


##### `plugin_list_reuses_cached_workspace_codex_plugins_setting`  (lines 556–641)

```
async fn plugin_list_reuses_cached_workspace_codex_plugins_setting() -> Result<()>
```

**Purpose**: Ensures the app server caches the backend setting that allows workspace plugins. This prevents repeated plugin-list calls from making the same account-settings network request.

**Data flow**: The test mocks account settings as enabled, sends two `plugin/list` requests, checks both list the local marketplace, and then waits until exactly one settings request has been recorded.

**Call relations**: The test harness calls it. It uses `wait_for_workspace_settings_request_count`, which in turn uses the shared request-count polling helper.

*Call graph*: calls 4 internal fn (new, new_without_managed_config_with_env, wait_for_workspace_settings_request_count, write_plugins_enabled_config_with_base_url); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, create_dir_all (+6 more)).


##### `plugin_list_uses_alternate_discoverable_manifest_and_keeps_undiscoverable_plugins`  (lines 644–786)

```
async fn plugin_list_uses_alternate_discoverable_manifest_and_keeps_undiscoverable_plugins() -> Result<()>
```

**Purpose**: Checks support for an alternate plugin discovery format using `.claude-plugin` paths. It also confirms missing plugin manifests do not remove marketplace entries.

**Data flow**: The test writes an alternate marketplace file and one alternate plugin manifest, sends `plugin/list`, and expects both the valid plugin with interface data and the missing plugin without interface data.

**Call relations**: The test harness runs it. It uses the basic plugin-enabled config helper and then verifies the app server's fallback discovery rules.

*Call graph*: calls 3 internal fn (new_with_env, write_plugins_enabled_config, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_accepts_omitted_cwds`  (lines 789–833)

```
async fn plugin_list_accepts_omitted_cwds() -> Result<()>
```

**Purpose**: Checks that `plugin/list` still works when the request does not include workspace directories. This matters for clients that want global or home-based plugins only.

**Data flow**: The test creates a home marketplace, omits `cwds` in the request, and only verifies that the response can be parsed successfully.

**Call relations**: The test harness calls it. It uses `write_plugins_enabled_config` and starts the server with HOME-like environment variables pointing at the temporary Codex home.

*Call graph*: calls 2 internal fn (new_with_env, write_plugins_enabled_config); 6 external calls (new, Integer, to_response, create_dir_all, write, timeout).


##### `plugin_list_returns_share_context_for_shared_local_plugin`  (lines 836–906)

```
async fn plugin_list_returns_share_context_for_shared_local_plugin() -> Result<()>
```

**Purpose**: Verifies that a local plugin linked to a remote shared plugin includes sharing context in the list response. This lets a UI show that a local plugin corresponds to a remote shared record.

**Data flow**: The test writes a local plugin with version data, writes a mapping from remote plugin ID to local path, sends `plugin/list`, and checks the returned plugin has local version and share context fields.

**Call relations**: The test harness runs it. It uses `write_plugin_share_local_path_mapping` to create the sharing metadata consumed by the app server.

*Call graph*: calls 4 internal fn (new, write_plugin_share_local_path_mapping, write_plugins_enabled_config, try_from); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_includes_install_and_enabled_state_from_config`  (lines 909–1041)

```
async fn plugin_list_includes_install_and_enabled_state_from_config() -> Result<()>
```

**Purpose**: Checks that plugin summaries correctly show whether each plugin is installed and enabled. This is what lets users distinguish installed, disabled, and available plugins.

**Data flow**: The test creates three marketplace plugins, caches two as installed, writes config enabling one and disabling another, then checks the returned marketplace entries have the expected flags and policies.

**Call relations**: The test harness calls it. It combines installed-cache helpers, manual marketplace JSON, and the app-server `plugin/list` request path.

*Call graph*: calls 2 internal fn (new, write_installed_plugin); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_uses_home_config_for_enabled_state`  (lines 1044–1145)

```
async fn plugin_list_uses_home_config_for_enabled_state() -> Result<()>
```

**Purpose**: Confirms that home-level plugin config decides enabled state even when a trusted workspace has its own config saying otherwise. This prevents workspace config from unexpectedly disabling a user's shared home plugin.

**Data flow**: The test writes a home marketplace and enabled config, writes a workspace config disabling the same plugin, marks the workspace trusted, then checks the plugin remains enabled in the response.

**Call relations**: The test harness runs it. It uses project trust setup plus `TestAppServer` to verify config precedence during plugin listing.

*Call graph*: calls 3 internal fn (new_with_env, write_installed_plugin, set_project_trust_level); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_returns_plugin_interface_with_absolute_asset_paths`  (lines 1148–1279)

```
async fn plugin_list_returns_plugin_interface_with_absolute_asset_paths() -> Result<()>
```

**Purpose**: Checks that plugin interface metadata is returned with local asset paths made absolute. This means clients can directly load icons, logos, and screenshots.

**Data flow**: The test writes a plugin manifest with interface text, URLs, prompts, and relative asset paths, sends `plugin/list`, and verifies the response preserves metadata while converting asset paths to absolute paths.

**Call relations**: The test harness calls it. It relies on the local marketplace setup and tests the app server's manifest parsing and path resolution.

*Call graph*: calls 2 internal fn (new, write_plugins_enabled_config); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_accepts_legacy_string_default_prompt`  (lines 1282–1346)

```
async fn plugin_list_accepts_legacy_string_default_prompt() -> Result<()>
```

**Purpose**: Ensures older plugin manifests that store `defaultPrompt` as one string are still accepted. The server should normalize it to the newer list-of-prompts shape.

**Data flow**: The test writes a manifest with a string default prompt, lists plugins, and checks the response contains a one-item prompt list.

**Call relations**: The test harness runs it. It shares the same local marketplace flow as newer interface tests, but focuses on backward compatibility.

*Call graph*: calls 2 internal fn (new, write_plugins_enabled_config); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_returns_installed_git_source_interface_from_cache`  (lines 1349–1464)

```
async fn plugin_list_returns_installed_git_source_interface_from_cache() -> Result<()>
```

**Purpose**: Checks that an installed plugin from a Git source can still show interface metadata from its local cache even if the remote Git repository is unavailable. This keeps installed plugin details visible offline.

**Data flow**: The test creates a marketplace entry pointing to a missing Git repository, writes cached plugin manifest files under Codex home, sends `plugin/list`, and verifies the plugin is installed/enabled with interface asset paths from the cache.

**Call relations**: The test harness calls it. It uses only local disk setup and the app server's Git-source cache lookup behavior.

*Call graph*: calls 1 internal fn (new); 11 external calls (new, Integer, to_response, assert_eq!, format!, canonicalize, create_dir_all, write, timeout, from_directory_path (+1 more)).


##### `app_server_startup_sync_downloads_remote_installed_plugin_bundles`  (lines 1467–1532)

```
async fn app_server_startup_sync_downloads_remote_installed_plugin_bundles() -> Result<()>
```

**Purpose**: Verifies that startup background tasks download remote installed plugin bundles. Without this, installed remote plugins could appear in config but lack local files needed to run.

**Data flow**: The test mocks remote installed plugins and a compressed bundle download, starts the app server with startup plugin tasks enabled, waits for files to appear, and checks the plugin manifest, app manifest, and skill file were installed.

**Call relations**: The test harness runs it. It uses bundle-building and mock-route helpers, then `wait_for_path_exists` to observe asynchronous download completion.

*Call graph*: calls 10 internal fn (new, new_with_env_and_plugin_startup_tasks, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_bundle, remote_installed_plugin_body_with_app_manifest, remote_plugin_bundle_tar_gz_bytes, wait_for_path_exists, write_remote_plugin_catalog_config); 10 external calls (start, new, write_chatgpt_auth, assert!, assert_eq!, format!, from_str, json!, read_to_string, timeout).


##### `plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles`  (lines 1535–1638)

```
async fn plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles() -> Result<()>
```

**Purpose**: Checks that plugin listing can trigger remote bundle synchronization: upgrading installed plugins and deleting stale cache entries. This keeps the local plugin cache aligned with the backend.

**Data flow**: The test creates old and stale cached plugin versions, mocks a newer remote installed plugin and bundle, sends `plugin/list`, then waits for the new version to exist and old/stale paths to disappear.

**Call relations**: The test harness calls it. It combines remote list and installed mocks with path-wait helpers to verify background cache maintenance.

*Call graph*: calls 13 internal fn (new, new_with_env, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_list, remote_installed_plugin_body_with_app_manifest, remote_plugin_bundle_tar_gz_bytes, wait_for_path_exists (+3 more)); 12 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, from_str, json! (+2 more)).


##### `plugin_list_includes_remote_marketplaces_when_remote_plugin_enabled`  (lines 1641–1870)

```
async fn plugin_list_includes_remote_marketplaces_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Verifies that enabling remote plugins adds the OpenAI curated remote marketplace to `plugin/list`. It also checks installed state, interface fields, keywords, availability, and catalog caching.

**Data flow**: The test mocks global and workspace remote plugin list endpoints plus installed endpoints, sends `plugin/list`, checks the returned remote marketplace and plugin details, and reads the on-disk cached catalog.

**Call relations**: The test harness runs it. It uses direct wiremock setup rather than the smaller mount helpers so it can assert request headers and query behavior in detail.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 18 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+8 more)).


##### `plugin_list_uses_cached_global_remote_catalog_and_refreshes_it`  (lines 1873–1968)

```
async fn plugin_list_uses_cached_global_remote_catalog_and_refreshes_it() -> Result<()>
```

**Purpose**: Checks the remote catalog cache behavior: serve the cached global catalog immediately, then refresh it in the background. This gives fast responses without letting the cache stay stale forever.

**Data flow**: The test first warms the cache with one remote plugin, then changes the mock backend to return a different plugin, sends another list request, and verifies the response still uses the old cache while the disk cache updates to the new plugin ID.

**Call relations**: The test harness calls it. It uses `remote_plugin_list_body`, `mount_remote_plugin_list`, request-count polling, and cached-catalog polling helpers.

*Call graph*: calls 10 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_list, remote_plugin_list_body, wait_for_cached_remote_catalog_plugin_ids, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 8 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout).


##### `plugin_list_includes_openai_curated_remote_collection_when_requested`  (lines 1971–2073)

```
async fn plugin_list_includes_openai_curated_remote_collection_when_requested() -> Result<()>
```

**Purpose**: Checks that an explicit request for the vertical OpenAI curated collection fetches and returns that remote collection. This is separate from the default remote marketplace behavior.

**Data flow**: The test mocks the collection endpoint, sends `plugin/list` with the vertical marketplace kind, and checks that the remote marketplace contains the expected plugin and that the request included the collection query.

**Call relations**: The test harness runs it. It uses the collection-specific mount helper plus installed-plugin mocks.

*Call graph*: calls 7 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_openai_curated_remote_collection_plugin_list, mount_remote_installed_plugins, write_plugins_enabled_config_with_base_url); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, timeout, vec!).


##### `plugin_list_propagates_explicit_openai_curated_remote_collection_errors`  (lines 2076–2129)

```
async fn plugin_list_propagates_explicit_openai_curated_remote_collection_errors() -> Result<()>
```

**Purpose**: Ensures that if a client explicitly asks for the remote curated collection and the backend fails, the server returns an error instead of silently hiding the problem.

**Data flow**: The test mocks the collection endpoint to return HTTP 500, sends a vertical collection request, and checks for an internal JSON-RPC error message mentioning the failed catalog listing.

**Call relations**: The test harness calls it. It uses the base-URL config helper, auth setup, and remote installed-plugin mocks before exercising the error path.

*Call graph*: calls 6 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, write_plugins_enabled_config_with_base_url); 15 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, timeout (+5 more)).


##### `plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth`  (lines 2132–2166)

```
async fn plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth() -> Result<()>
```

**Purpose**: Checks that API-key authentication does not fetch ChatGPT remote curated collections. This prevents calling ChatGPT-only plugin APIs with the wrong kind of credential.

**Data flow**: The test logs in with an API key, asks for the vertical marketplace kind, expects no marketplaces, and verifies no plugin-list request reached the mock server.

**Call relations**: The test harness runs it. It uses `wait_for_remote_plugin_request_count` to prove the network call was not made.

*Call graph*: calls 4 internal fn (new, wait_for_remote_plugin_request_count, write_plugins_enabled_config_with_base_url, default); 9 external calls (start, new, Integer, to_response, assert!, login_with_api_key, format!, timeout, vec!).


##### `plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled`  (lines 2169–2221)

```
async fn plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Verifies that API-key users still get the local API-curated marketplace when remote plugin support is enabled. The server should not try ChatGPT remote catalogs for this auth mode.

**Data flow**: The test writes an API-curated marketplace and API-key credentials, sends `plugin/list`, checks the local marketplace appears, and confirms no remote plugin-list calls happened.

**Call relations**: The test harness calls it. It uses `write_openai_api_curated_marketplace`, remote-plugin config, and request-count polling.

*Call graph*: calls 5 internal fn (new, wait_for_remote_plugin_request_count, write_openai_api_curated_marketplace, write_remote_plugin_catalog_config, default); 9 external calls (start, new, Integer, to_response, assert!, assert_eq!, login_with_api_key, format!, timeout).


##### `plugin_list_does_not_query_openai_curated_remote_collection_by_default`  (lines 2224–2274)

```
async fn plugin_list_does_not_query_openai_curated_remote_collection_by_default() -> Result<()>
```

**Purpose**: Checks that the vertical OpenAI curated collection is not fetched unless explicitly requested. This avoids unnecessary network calls and unexpected marketplace entries.

**Data flow**: The test enables plugins with ChatGPT auth, sends a default `plugin/list`, and verifies no marketplace named `openai-curated-remote` came from the vertical collection and no collection query was recorded.

**Call relations**: The test harness runs it. It uses the base-URL config helper and inspects recorded wiremock requests after the list response.

*Call graph*: calls 3 internal fn (new, new, write_plugins_enabled_config_with_base_url); 8 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, timeout).


##### `plugin_list_vertical_kind_noops_when_remote_plugin_enabled`  (lines 2277–2327)

```
async fn plugin_list_vertical_kind_noops_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Checks a subtle feature-flag interaction: when the newer remote-plugin feature is enabled, asking for the older vertical kind should not fetch the vertical collection. This prevents duplicate or conflicting remote sources.

**Data flow**: The test enables remote plugins, asks for the vertical marketplace kind, and verifies no vertical collection marketplace or collection query appears.

**Call relations**: The test harness calls it. It relies on remote-plugin catalog config and recorded mock-server requests.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, timeout, vec!).


##### `plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit`  (lines 2330–2372)

```
async fn plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit() -> Result<()>
```

**Purpose**: Ensures that an explicit marketplace-kind filter is respected. If the client asks only for local marketplaces, the server should not automatically add the global remote marketplace.

**Data flow**: The test enables remote plugins, requests only the local kind, checks no remote marketplace appears, and verifies no remote list call was made.

**Call relations**: The test harness runs it. It uses `wait_for_remote_plugin_request_count` to prove the filtered request avoided the remote backend.

*Call graph*: calls 4 internal fn (new, new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, timeout, vec!).


##### `plugin_installed_includes_remote_shared_with_me_plugins`  (lines 2375–2474)

```
async fn plugin_installed_includes_remote_shared_with_me_plugins() -> Result<()>
```

**Purpose**: Checks that `plugin/installed` includes remote workspace plugins shared with the user when plugin sharing is enabled. This lets users see shared private or unlisted plugins they have installed.

**Data flow**: The test mocks global and workspace installed plugin endpoints, including private and unlisted workspace plugins, sends `plugin/installed`, and expects a `workspace-shared-with-me` marketplace with correct installed/enabled flags.

**Call relations**: The test harness calls it. It uses remote body builders and waits until both GLOBAL and WORKSPACE installed endpoints were queried.

*Call graph*: calls 7 internal fn (new, new, mount_empty_user_installed_plugins, mount_remote_installed_plugins, remote_installed_plugin_body, wait_for_remote_installed_scope_request, workspace_remote_plugin_page_body); 11 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, to_string, write (+1 more)).


##### `plugin_installed_includes_workspace_directory_without_plugin_sharing`  (lines 2477–2561)

```
async fn plugin_installed_includes_workspace_directory_without_plugin_sharing() -> Result<()>
```

**Purpose**: Verifies that listed workspace-directory plugins can appear in installed results even when sharing is disabled. Private shared plugins should be excluded in that mode.

**Data flow**: The test mocks installed workspace plugins with one listed and one private plugin, sends `plugin/installed`, and checks only the listed workspace-directory plugin is returned.

**Call relations**: The test harness runs it. It uses `workspace_remote_plugin_page_body` and installed-route helpers to model backend responses.

*Call graph*: calls 7 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, wait_for_remote_installed_scope_request, workspace_remote_plugin_page_body); 11 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, to_string, write (+1 more)).


##### `plugin_installed_includes_created_by_me_when_remote_plugins_enabled`  (lines 2564–2652)

```
async fn plugin_installed_includes_created_by_me_when_remote_plugins_enabled() -> Result<()>
```

**Purpose**: Checks that remote plugins created by the current user appear in installed results when remote plugins are enabled. It also verifies their bundles can be downloaded into the correct cache area.

**Data flow**: The test mocks empty global/workspace installs, a USER installed plugin with a bundle URL, sends `plugin/installed`, checks the created-by-me marketplace, and waits for the downloaded manifest file.

**Call relations**: The test harness calls it. It uses `user_remote_plugin_page_body`, bundle helpers, and installed-scope polling.

*Call graph*: calls 9 internal fn (new, new_with_env, empty_remote_installed_plugins_body, mount_remote_installed_plugins, mount_remote_plugin_bundle, remote_plugin_bundle_tar_gz_bytes, user_remote_plugin_page_body, wait_for_path_exists, wait_for_remote_installed_scope_request); 12 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, json!, to_string (+2 more)).


##### `plugin_installed_starts_remote_installed_bundle_sync`  (lines 2655–2731)

```
async fn plugin_installed_starts_remote_installed_bundle_sync() -> Result<()>
```

**Purpose**: Verifies that calling `plugin/installed` starts background syncing for installed remote plugin bundles. Users should not need a separate command to fetch files for installed remote plugins.

**Data flow**: The test mocks an installed remote plugin with a bundle URL, sends `plugin/installed`, checks the response, and waits for the bundle's plugin manifest to appear on disk.

**Call relations**: The test harness runs it. It uses remote installed mocks, bundle generation, and `wait_for_path_exists` to observe the asynchronous sync.

*Call graph*: calls 10 internal fn (new, new_with_env, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_bundle, remote_installed_plugin_body, remote_plugin_bundle_tar_gz_bytes, wait_for_path_exists, wait_for_remote_installed_scope_request); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, write, timeout).


##### `plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag`  (lines 2734–2819)

```
async fn plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag() -> Result<()>
```

**Purpose**: Checks that the workspace-directory marketplace kind can be fetched even when the broader remote-plugin flag is off. This allows a narrower remote feature to work independently.

**Data flow**: The test mocks workspace plugin list and installed endpoints, asks for the workspace-directory kind, and verifies one installed workspace plugin is returned without any global-scope calls.

**Call relations**: The test harness calls it. It uses `mount_remote_plugin_list`, `mount_remote_installed_plugins`, and request inspection to confirm the correct backend scope.

*Call graph*: calls 7 internal fn (new, new, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_list, workspace_remote_plugin_page_body, write_plugins_enabled_config_with_base_url); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, timeout, vec!).


##### `plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace`  (lines 2822–2955)

```
async fn plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace() -> Result<()>
```

**Purpose**: Verifies that the created-by-me remote marketplace fetches USER-scoped plugins and follows pagination. This ensures users see all plugins they created, not just the first page.

**Data flow**: The test mocks two USER list pages and USER installed state, sends `plugin/list` for the created-by-me kind, and checks both plugins appear with correct installed/enabled state.

**Call relations**: The test harness runs it. It sets custom wiremock routes for page tokens and confirms no non-USER list requests were made.

*Call graph*: calls 5 internal fn (new, new, empty_remote_installed_plugins_body, mount_remote_installed_plugins, user_remote_plugin_page_body); 19 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+9 more)).


##### `plugin_list_fetches_shared_with_me_kind`  (lines 2958–3152)

```
async fn plugin_list_fetches_shared_with_me_kind() -> Result<()>
```

**Purpose**: Checks the shared-with-me marketplace kind, including private shared plugins and unlisted installed plugins. This verifies the response carries enough sharing details for a UI to explain where a plugin came from.

**Data flow**: The test mocks shared workspace plugins and installed workspace plugins, sends `plugin/list` for shared-with-me, and checks private and unlisted marketplaces, plugin IDs, installed flags, and share-context metadata.

**Call relations**: The test harness calls it. It uses shared-workspace and installed-route helpers, then waits for installed-scope calls while confirming no ordinary plugin-list call was made.

*Call graph*: calls 10 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_shared_workspace_plugins, wait_for_remote_installed_scope_request, wait_for_remote_plugin_request_count, workspace_remote_plugin_page_body, write_plugins_enabled_config_with_base_url); 11 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, to_string, timeout (+1 more)).


##### `plugin_list_omits_shared_with_me_kind_when_plugin_sharing_disabled`  (lines 3155–3211)

```
async fn plugin_list_omits_shared_with_me_kind_when_plugin_sharing_disabled() -> Result<()>
```

**Purpose**: Ensures the shared-with-me kind returns nothing when plugin sharing is disabled. The server should also avoid calling the sharing endpoint.

**Data flow**: The test writes config with `plugin_sharing = false`, requests shared-with-me, expects an empty response, and verifies zero calls to the shared plugins endpoint.

**Call relations**: The test harness runs it. It uses the generic remote request-count helper to prove the feature gate stopped the network call.

*Call graph*: calls 3 internal fn (new, new, wait_for_remote_plugin_request_count); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, write, timeout, vec!).


##### `plugin_list_omits_created_by_me_when_remote_plugins_disabled`  (lines 3214–3266)

```
async fn plugin_list_omits_created_by_me_when_remote_plugins_disabled() -> Result<()>
```

**Purpose**: Checks that created-by-me remote plugins are omitted when remote plugins are disabled, even if sharing is enabled. This keeps feature flags consistent.

**Data flow**: The test writes config with remote plugins disabled, requests the created-by-me kind, expects an empty response, and verifies no remote list call happened.

**Call relations**: The test harness calls it. It relies on `wait_for_remote_plugin_request_count` after the response.

*Call graph*: calls 3 internal fn (new, new, wait_for_remote_plugin_request_count); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, write, timeout, vec!).


##### `plugin_list_marks_remote_plugin_disabled_by_admin`  (lines 3269–3401)

```
async fn plugin_list_marks_remote_plugin_disabled_by_admin() -> Result<()>
```

**Purpose**: Verifies that a remote plugin disabled by an administrator is marked as unavailable for that reason, while still showing installed and enabled state from the backend. This lets clients show the right warning.

**Data flow**: The test mocks remote list and installed endpoints with status `DISABLED_BY_ADMIN`, sends `plugin/list`, and checks the plugin availability field is `DisabledByAdmin`.

**Call relations**: The test harness runs it. It uses remote-plugin catalog config and direct wiremock setup for both list and installed endpoints.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+4 more)).


##### `plugin_list_does_not_fetch_remote_marketplaces_when_plugins_disabled`  (lines 3404–3449)

```
async fn plugin_list_does_not_fetch_remote_marketplaces_when_plugins_disabled() -> Result<()>
```

**Purpose**: Checks that the master plugin feature flag overrides remote-plugin settings. If plugins are disabled, the server should return no plugins and avoid remote calls.

**Data flow**: The test writes config with `plugins = false` and `remote_plugin = true`, sends `plugin/list`, expects an empty marketplace list, and verifies no remote list requests occurred.

**Call relations**: The test harness calls it. It uses request-count polling to confirm the server stopped before network access.

*Call graph*: calls 3 internal fn (new, new, wait_for_remote_plugin_request_count); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, write, timeout).


##### `plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth`  (lines 3452–3487)

```
async fn plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth() -> Result<()>
```

**Purpose**: Verifies that featured plugin IDs can be fetched without ChatGPT authentication. This supports public featured-plugin metadata alongside local curated marketplaces.

**Data flow**: The test writes plugin sync config and a curated marketplace, mocks `/plugins/featured`, sends `plugin/list`, and checks the returned featured ID list.

**Call relations**: The test harness runs it. It uses `write_plugin_sync_config` and a direct mock route for the featured endpoint.

*Call graph*: calls 3 internal fn (new, write_openai_curated_marketplace, write_plugin_sync_config); 12 external calls (given, start, new, new, Integer, to_response, assert_eq!, format!, timeout, method (+2 more)).


##### `plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request`  (lines 3490–3527)

```
async fn plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request() -> Result<()>
```

**Purpose**: Checks that startup tasks can warm the featured-plugin cache before the first `plugin/list` request. The first response should then use the warmed data.

**Data flow**: The test starts the app server with plugin startup tasks, waits for one featured request, sends `plugin/list`, and checks the featured plugin IDs in the response.

**Call relations**: The test harness calls it. It uses `wait_for_featured_plugin_request_count`, which delegates to the generic remote request-count helper.

*Call graph*: calls 4 internal fn (new_with_plugin_startup_tasks, wait_for_featured_plugin_request_count, write_openai_curated_marketplace, write_plugin_sync_config); 12 external calls (given, start, new, new, Integer, to_response, assert_eq!, format!, timeout, method (+2 more)).


##### `wait_for_featured_plugin_request_count`  (lines 3529–3534)

```
async fn wait_for_featured_plugin_request_count(
    server: &MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Waits until the fake server has seen a specific number of featured-plugin requests. Tests use it to prove cache warming or network avoidance happened.

**Data flow**: It receives a mock server and expected count, asks the generic request-count waiter to watch the `/plugins/featured` path, and returns success or an error.

**Call relations**: The featured-cache startup test calls this; it simply specializes `wait_for_remote_plugin_request_count` for the featured endpoint.

*Call graph*: calls 1 internal fn (wait_for_remote_plugin_request_count); called by 1 (plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request).


##### `wait_for_workspace_settings_request_count`  (lines 3536–3542)

```
async fn wait_for_workspace_settings_request_count(
    server: &MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Waits until the fake server has seen a specific number of account-settings requests. This is used to check that workspace plugin settings are cached.

**Data flow**: It receives a mock server and expected count, then delegates to the generic request-count waiter for the account settings path.

**Call relations**: The workspace-settings cache test calls this after two plugin-list requests to confirm only one settings fetch occurred.

*Call graph*: calls 1 internal fn (wait_for_remote_plugin_request_count); called by 1 (plugin_list_reuses_cached_workspace_codex_plugins_setting).


##### `wait_for_remote_plugin_request_count`  (lines 3544–3573)

```
async fn wait_for_remote_plugin_request_count(
    server: &MockServer,
    path_suffix: &str,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Polls the fake HTTP server until exactly the expected number of GET requests have been made to a path suffix. It helps tests wait for asynchronous background calls without racing.

**Data flow**: It reads recorded mock-server requests in a loop, counts matching GET paths, succeeds when the count matches, errors if it grows too high, and sleeps briefly between checks until the timeout.

**Call relations**: Many tests and small wrapper waiters use this to verify that the app server either did or did not contact particular remote plugin endpoints.

*Call graph*: called by 10 (plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit, plugin_list_does_not_fetch_remote_marketplaces_when_plugins_disabled, plugin_list_fetches_shared_with_me_kind, plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled, plugin_list_omits_created_by_me_when_remote_plugins_disabled, plugin_list_omits_shared_with_me_kind_when_plugin_sharing_disabled, plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth, plugin_list_uses_cached_global_remote_catalog_and_refreshes_it, wait_for_featured_plugin_request_count, wait_for_workspace_settings_request_count); 5 external calls (from_millis, received_requests, bail!, sleep, timeout).


##### `wait_for_remote_installed_scope_request`  (lines 3575–3596)

```
async fn wait_for_remote_installed_scope_request(server: &MockServer, scope: &str) -> Result<()>
```

**Purpose**: Waits until the fake server receives an installed-plugin request for a specific scope such as GLOBAL, WORKSPACE, or USER. This proves the server queried the expected remote installed set.

**Data flow**: It repeatedly reads recorded requests, looks for a GET to `/ps/plugins/installed` with the requested `scope` query value, and returns when found or times out.

**Call relations**: Remote installed-plugin tests call this after responses or sync work to confirm the app server contacted the expected backend scope.

*Call graph*: called by 5 (plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_fetches_shared_with_me_kind); 5 external calls (from_millis, received_requests, bail!, sleep, timeout).


##### `wait_for_cached_remote_catalog_plugin_ids`  (lines 3598–3619)

```
async fn wait_for_cached_remote_catalog_plugin_ids(
    codex_home: &std::path::Path,
    expected_plugin_ids: &[&str],
) -> Result<()>
```

**Purpose**: Waits until the on-disk remote catalog cache contains exactly the expected plugin IDs. This is useful because catalog refresh happens asynchronously.

**Data flow**: It sorts the expected IDs, repeatedly reads IDs from cache files through `cached_remote_catalog_plugin_ids`, and succeeds once the lists match.

**Call relations**: The remote-catalog cache refresh test calls it after list requests to observe when the background cache update has landed on disk.

*Call graph*: calls 1 internal fn (cached_remote_catalog_plugin_ids); called by 1 (plugin_list_uses_cached_global_remote_catalog_and_refreshes_it); 3 external calls (from_millis, sleep, timeout).


##### `cached_remote_catalog_plugin_ids`  (lines 3621–3642)

```
fn cached_remote_catalog_plugin_ids(codex_home: &std::path::Path) -> Result<Vec<String>>
```

**Purpose**: Reads plugin IDs from the app server's cached remote catalog files. It gives tests a simple way to inspect cache contents without caring about full catalog JSON.

**Data flow**: It looks under `cache/remote_plugin_catalog`, reads each JSON file if the directory exists, extracts plugin `id` strings from each `plugins` array, sorts them, and returns the list.

**Call relations**: Only `wait_for_cached_remote_catalog_plugin_ids` calls this, using it as the snapshot function inside a polling loop.

*Call graph*: called by 1 (wait_for_cached_remote_catalog_plugin_ids); 5 external calls (join, new, from_slice, read, read_dir).


##### `wait_for_path_exists`  (lines 3644–3655)

```
async fn wait_for_path_exists(path: &std::path::Path) -> Result<()>
```

**Purpose**: Waits until a file or directory appears on disk. Tests use it for background plugin bundle downloads that finish after the response is sent.

**Data flow**: It receives a path, repeatedly checks whether it exists, sleeps briefly between checks, and returns success once it appears or an error on timeout.

**Call relations**: Bundle-sync tests call this after startup, `plugin/list`, or `plugin/installed` to confirm asynchronous installation completed.

*Call graph*: called by 4 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 4 external calls (from_millis, exists, sleep, timeout).


##### `wait_for_path_missing`  (lines 3657–3668)

```
async fn wait_for_path_missing(path: &std::path::Path) -> Result<()>
```

**Purpose**: Waits until a file or directory has been removed from disk. Tests use it to verify stale plugin cache cleanup.

**Data flow**: It receives a path, repeatedly checks that it no longer exists, sleeps briefly between checks, and returns success once missing or an error on timeout.

**Call relations**: The remote bundle upgrade/removal test calls this to prove old and stale cache paths were deleted.

*Call graph*: called by 1 (plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 4 external calls (from_millis, exists, sleep, timeout).


##### `mount_remote_plugin_list`  (lines 3670–3680)

```
async fn mount_remote_plugin_list(server: &MockServer, scope: &str, body: &str)
```

**Purpose**: Registers a fake backend route for listing remote plugins in a given scope. It lets tests control exactly what the app server receives from the remote catalog API.

**Data flow**: It takes a mock server, scope, and response body, sets up a GET route for `/backend-api/ps/plugins/list` with expected query parameters and auth headers, and serves the supplied body.

**Call relations**: Remote catalog and workspace-directory tests call this during setup before the app server sends plugin-list requests.

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

**Purpose**: Builds a small JSON response body for a remote plugin-list page. It keeps cache-related tests readable by avoiding repeated long JSON strings.

**Data flow**: It receives a remote plugin ID, plugin name, display name, and short description, formats them into a JSON string with one plugin and no next page, and returns that string.

**Call relations**: The remote catalog cache test calls this to create both the initial cached catalog and the later refreshed catalog.

*Call graph*: called by 1 (plugin_list_uses_cached_global_remote_catalog_and_refreshes_it); 1 external calls (format!).


##### `mount_openai_curated_remote_collection_plugin_list`  (lines 3719–3730)

```
async fn mount_openai_curated_remote_collection_plugin_list(server: &MockServer, body: &str)
```

**Purpose**: Registers a fake backend route for the explicit OpenAI curated remote collection. The key detail is the `collection=vertical` query parameter.

**Data flow**: It receives a mock server and response body, mounts a GET route for global plugin listing with the vertical collection query and expected auth headers, and returns that body to matching requests.

**Call relations**: The explicit vertical collection test uses this before sending a `plugin/list` request with the vertical marketplace kind.

*Call graph*: called by 1 (plugin_list_includes_openai_curated_remote_collection_when_requested); 6 external calls (given, new, header, method, path, query_param).


##### `mount_shared_workspace_plugins`  (lines 3732–3741)

```
async fn mount_shared_workspace_plugins(server: &MockServer, body: &str)
```

**Purpose**: Registers a fake backend route for plugins shared with the current workspace user. It models the sharing-specific API endpoint.

**Data flow**: It takes a mock server and JSON body, mounts a GET route for `/backend-api/ps/plugins/workspace/shared` with expected headers and limit query, and serves the body.

**Call relations**: The shared-with-me plugin-list test calls this to provide private and unlisted shared plugin data.

*Call graph*: called by 1 (plugin_list_fetches_shared_with_me_kind); 6 external calls (given, new, header, method, path, query_param).


##### `mount_remote_installed_plugins`  (lines 3743–3752)

```
async fn mount_remote_installed_plugins(server: &MockServer, scope: &str, body: &str)
```

**Purpose**: Registers a fake backend route for remote installed plugins in a specific scope. Tests use it to model what the backend says the user has installed.

**Data flow**: It receives a mock server, scope, and body, mounts a GET route for `/backend-api/ps/plugins/installed` with the scope query and auth headers, and returns the supplied JSON.

**Call relations**: Most remote-plugin tests call this directly or through `mount_empty_user_installed_plugins` to set up installed-state responses.

*Call graph*: called by 14 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, mount_empty_user_installed_plugins, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace, plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag (+4 more)); 6 external calls (given, new, header, method, path, query_param).


##### `mount_empty_user_installed_plugins`  (lines 3754–3756)

```
async fn mount_empty_user_installed_plugins(server: &MockServer)
```

**Purpose**: Convenience helper that says the USER scope has no installed plugins. It avoids repeating the same empty installed-plugin route setup.

**Data flow**: It receives a mock server, builds the standard empty installed response, and mounts it for the USER scope through `mount_remote_installed_plugins`.

**Call relations**: Remote tests call it when they care about GLOBAL or WORKSPACE data and want USER installs to be harmlessly empty.

*Call graph*: calls 2 internal fn (empty_remote_installed_plugins_body, mount_remote_installed_plugins); called by 11 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag, plugin_list_includes_openai_curated_remote_collection_when_requested, plugin_list_propagates_explicit_openai_curated_remote_collection_errors, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles (+1 more)).


##### `empty_remote_installed_plugins_body`  (lines 3758–3766)

```
fn empty_remote_installed_plugins_body() -> &'static str
```

**Purpose**: Returns a standard JSON page with no installed plugins and no next page. It is the shared empty response used by many remote-plugin tests.

**Data flow**: It takes no input and returns a static JSON string containing an empty `plugins` array and pagination metadata.

**Call relations**: Installed-route helpers and remote tests use this whenever a scope should contain no plugins.

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

**Purpose**: Builds a JSON page for a workspace-scoped remote plugin. It can represent listed, private, or unlisted shared plugins, optionally with installed enabled state.

**Data flow**: It receives plugin identifiers, names, discoverability, and an optional enabled value, then formats a remote-plugin JSON response including creator and sharing metadata.

**Call relations**: Workspace directory, shared-with-me, and installed-plugin tests use this as their main mock backend response builder; `user_remote_plugin_page_body` adapts it for USER scope.

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

**Purpose**: Builds a JSON page for a user-scoped remote plugin by reusing the workspace plugin body shape. This models plugins created by the current user.

**Data flow**: It passes the inputs to `workspace_remote_plugin_page_body`, then changes the first scope field from WORKSPACE to USER and returns the resulting JSON string.

**Call relations**: Created-by-me tests call this for USER list and installed responses.

*Call graph*: calls 1 internal fn (workspace_remote_plugin_page_body); called by 2 (plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace).


##### `remote_installed_plugin_body`  (lines 3841–3852)

```
fn remote_installed_plugin_body(
    bundle_download_url: &str,
    release_version: &str,
    enabled: bool,
) -> String
```

**Purpose**: Builds a standard installed remote plugin response without an app manifest. It is the common mock body for a globally installed remote plugin.

**Data flow**: It receives a bundle download URL, release version, and enabled flag, then delegates to the optional app-manifest builder with no app manifest.

**Call relations**: Remote installed and conflict-resolution tests call this when they only need the basic installed plugin shape.

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

**Purpose**: Builds an installed remote plugin response that includes an app manifest. Tests use it to verify that bundle sync writes both plugin files and app metadata.

**Data flow**: It receives bundle URL, release version, enabled flag, and app manifest JSON, then delegates to the optional app-manifest builder with that manifest included.

**Call relations**: Startup sync and bundle upgrade tests call this before mounting the remote installed-plugin endpoint.

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

**Purpose**: Formats the full JSON response for one installed remote plugin, optionally including app-manifest data. It is the central body builder behind the two simpler installed-body helpers.

**Data flow**: It takes plugin bundle URL, version, enabled state, and optional app manifest, inserts them into a remote installed-plugin JSON page, and returns the string.

**Call relations**: `remote_installed_plugin_body` and `remote_installed_plugin_body_with_app_manifest` both call this so tests share one consistent mock response shape.

*Call graph*: called by 2 (remote_installed_plugin_body, remote_installed_plugin_body_with_app_manifest); 1 external calls (format!).


##### `mount_remote_plugin_bundle`  (lines 3908–3924)

```
async fn mount_remote_plugin_bundle(
    server: &MockServer,
    plugin_name: &str,
    body: Vec<u8>,
) -> String
```

**Purpose**: Registers a fake download URL for a remote plugin bundle. This lets bundle-sync tests download real compressed bytes from the mock server.

**Data flow**: It receives a mock server, plugin name, and bundle bytes, mounts a GET route like `/bundles/name.tar.gz`, and returns the full URL that tests can place in remote plugin JSON.

**Call relations**: Bundle sync tests call this before mounting installed-plugin responses, so the app server can later fetch the mocked bundle URL.

*Call graph*: called by 4 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 5 external calls (given, new, format!, method, path).


##### `remote_plugin_bundle_tar_gz_bytes`  (lines 3926–3950)

```
fn remote_plugin_bundle_tar_gz_bytes(plugin_name: &str) -> Result<Vec<u8>>
```

**Purpose**: Creates a tiny compressed plugin bundle for tests. The bundle contains a plugin manifest and one skill file, enough to verify extraction works.

**Data flow**: It receives a plugin name, builds a tar archive compressed with gzip, writes `.codex-plugin/plugin.json` and `skills/plan-work/SKILL.md` into it, and returns the bytes.

**Call relations**: Remote bundle tests call this, then pass the bytes to `mount_remote_plugin_bundle`.

*Call graph*: called by 4 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 6 external calls (new, new, default, format!, new, new_gnu).


##### `write_installed_plugin`  (lines 3952–3958)

```
fn write_installed_plugin(
    codex_home: &TempDir,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<()>
```

**Purpose**: Creates a fake installed plugin cache entry using the default `local` version folder. Tests use it to mark a local plugin as installed.

**Data flow**: It receives a temporary Codex home, marketplace name, and plugin name, then delegates to `write_installed_plugin_with_version` with version `local`.

**Call relations**: Local installed-state tests call this during setup before the app server reads the plugin cache.

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

**Purpose**: Creates a fake installed plugin cache entry for a specific version. This is useful for testing remote bundle upgrades and stale version cleanup.

**Data flow**: It builds the cache path under `plugins/cache/<marketplace>/<plugin>/<version>/.codex-plugin`, creates directories, writes a minimal `plugin.json`, and returns any file-system error.

**Call relations**: `write_installed_plugin` calls it for local installs, and the remote sync test calls it directly to create old cached versions.

*Call graph*: called by 2 (plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles, write_installed_plugin); 4 external calls (path, format!, create_dir_all, write).


##### `write_plugin_sync_config`  (lines 3981–4002)

```
fn write_plugin_sync_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes config used by featured-plugin and plugin-sync tests. It enables plugins, points to a backend URL, and sets enabled flags for a few curated plugin IDs.

**Data flow**: It receives a Codex home path and base URL, writes a `config.toml` containing the URL, plugin feature flag, and plugin enabled settings, and returns file-write status.

**Call relations**: Featured-plugin tests call this before starting the app server and mocking the featured endpoint.

*Call graph*: called by 2 (plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth, plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request); 3 external calls (join, format!, write).


##### `write_remote_plugin_catalog_config`  (lines 4004–4020)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config that enables both plugins and remote-plugin catalog support. Tests use it when they expect the app server to query remote plugin APIs.

**Data flow**: It receives a Codex home path and base URL, writes `chatgpt_base_url`, `plugins = true`, and `remote_plugin = true` into `config.toml`, and returns any I/O error.

**Call relations**: Remote catalog, bundle sync, conflict, and feature-filter tests call this before starting `TestAppServer`.

*Call graph*: called by 8 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit, plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled, plugin_list_includes_remote_marketplaces_when_remote_plugin_enabled, plugin_list_marks_remote_plugin_disabled_by_admin, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles, plugin_list_uses_cached_global_remote_catalog_and_refreshes_it, plugin_list_vertical_kind_noops_when_remote_plugin_enabled); 3 external calls (join, format!, write).


##### `write_openai_curated_marketplace`  (lines 4022–4033)

```
fn write_openai_curated_marketplace(
    codex_home: &std::path::Path,
    plugin_names: &[&str],
) -> std::io::Result<()>
```

**Purpose**: Creates a fake local OpenAI curated marketplace. It is used to test normal curated plugin listing and installed-state behavior.

**Data flow**: It receives a Codex home path and plugin names, then delegates to `write_curated_marketplace` with the standard marketplace file and name.

**Call relations**: Several curated local marketplace tests call this, and it shares implementation with the API-curated marketplace helper.

*Call graph*: calls 1 internal fn (write_curated_marketplace); called by 4 (plugin_installed_includes_installed_plugins_and_explicit_install_suggestions, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth, plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request).


##### `write_openai_api_curated_marketplace`  (lines 4035–4046)

```
fn write_openai_api_curated_marketplace(
    codex_home: &std::path::Path,
    plugin_names: &[&str],
) -> std::io::Result<()>
```

**Purpose**: Creates a fake local marketplace for API-key authentication mode. It labels the marketplace as OpenAI Curated while using the API-specific marketplace name.

**Data flow**: It receives a Codex home path and plugin names, then calls `write_curated_marketplace` with `api_marketplace.json`, `openai-api-curated`, and a display name.

**Call relations**: The API-auth curated marketplace test calls this to verify API-key users see the correct local marketplace without remote ChatGPT calls.

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

**Purpose**: Writes a complete fake curated marketplace tree, including marketplace JSON, plugin manifests, and a curated SHA marker. This gives tests a realistic local curated-plugin source.

**Data flow**: It receives marketplace naming details and plugin names, creates a temporary Git-like directory under Codex home, writes the marketplace file, writes one minimal manifest per plugin, and records a fake curated plugin SHA.

**Call relations**: The OpenAI curated and API curated helper functions both call this, so all curated marketplace tests use the same disk layout.

*Call graph*: called by 2 (write_openai_api_curated_marketplace, write_openai_curated_marketplace); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin_share_local_path_mapping`  (lines 4111–4130)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &std::path::Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
) -> std::io::Result<()>
```

**Purpose**: Writes a mapping from a remote shared plugin ID to a local plugin path. This lets tests simulate a local plugin that has been shared or linked to a remote plugin record.

**Data flow**: It receives Codex home, remote plugin ID, and absolute plugin path, serializes that mapping as pretty JSON under `.tmp/plugin-share-local-paths-v1.json`, and writes it to disk.

**Call relations**: The shared-local-plugin listing test calls this before `plugin/list`, so the app server can add share context to the returned local plugin.

*Call graph*: called by 1 (plugin_list_returns_share_context_for_shared_local_plugin); 8 external calls (join, format!, new, json!, to_string_pretty, to_value, create_dir_all, write).


### `app-server/tests/suite/v2/plugin_read.rs`

`test` · `test run`

This is a test file, so it does not implement plugin reading itself. Instead, it builds many small fake worlds and asks the app server, “What do you say this plugin looks like?” The tests create temporary Codex home folders, temporary plugin marketplaces, plugin manifests, skill files, hook files, and mock HTTP servers. Then they send JSON-RPC requests, which are structured request/response messages, to the test app server and check the answer.

The main goal is to protect user-facing plugin behavior. These tests make sure the server rejects unclear requests, reports missing plugins as friendly request errors, reads local plugin bundles without accidentally cloning remote git sources, and preserves important metadata such as install state, enabled state, share links, app templates, connector categories, MCP server names, hooks, skills, and default prompts. MCP servers are external helper processes a plugin can expose; these tests confirm their names are shown correctly.

The file also checks remote behavior using mock web servers. These fake servers stand in for ChatGPT backend APIs, so the tests can verify authorization headers, account headers, and response conversion without depending on the real network. Helper functions at the bottom write common config files and plugin fixtures, like a stage crew setting up props before each scene.

#### Function details

##### `plugin_read_rejects_missing_read_source`  (lines 57–83)

```
async fn plugin_read_rejects_missing_read_source() -> Result<()>
```

**Purpose**: Checks that a plugin read request is rejected when it says which plugin to read but does not say where to read it from. This protects the API from guessing between local and remote sources.

**Data flow**: It starts a fresh test server with an empty temporary home folder, sends a request with no marketplace path and no remote marketplace name, then waits for an error response. The expected result is an “invalid request” error explaining that exactly one read source is required.

**Call relations**: This test drives the server directly through the test harness. It relies on the app server validation path to catch the bad request before any marketplace file or remote catalog is used.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_read_rejects_multiple_read_sources`  (lines 86–114)

```
async fn plugin_read_rejects_multiple_read_sources() -> Result<()>
```

**Purpose**: Checks that a plugin read request is rejected when it gives both a local marketplace path and a remote marketplace name. The server must not accept ambiguous instructions.

**Data flow**: It creates a temporary server, builds a request containing both possible source fields, sends it, and reads the error message. The request becomes an invalid-request error saying the caller must provide exactly one source.

**Call relations**: Like the missing-source test, this exercises the app server’s early request validation. It uses path conversion for the fake marketplace path, but the server should reject the request before trying to read that path.

*Call graph*: calls 2 internal fn (new, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_read_returns_remote_mcp_servers_when_uninstalled`  (lines 117–290)

```
async fn plugin_read_returns_remote_mcp_servers_when_uninstalled() -> Result<()>
```

**Purpose**: Checks that reading an uninstalled remote plugin still returns the useful remote details, including MCP server names and related apps. It also verifies that one MCP server linked to an app is not duplicated in the standalone MCP list.

**Data flow**: It writes config and ChatGPT auth into a temporary home, starts a mock backend, and teaches that backend to return plugin details, the installed-plugin list, and connector app data. The request goes in as a remote plugin read; the response comes out as a plugin detail object with remote identity, prompt text, one standalone MCP server, and one app.

**Call relations**: The test calls the mock server setup tools, then sends the request through the test app server. The app server is expected to fetch remote plugin details, installed status, and connector information before returning a single combined response.

*Call graph*: calls 2 internal fn (new, new); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_read_returns_share_context_for_shared_remote_plugin`  (lines 293–443)

```
async fn plugin_read_returns_share_context_for_shared_remote_plugin() -> Result<()>
```

**Purpose**: Checks that a shared remote plugin includes sharing information such as owner, readers, share URL, and discoverability. It also confirms that an older private marketplace name is normalized to the public shared-with-me name.

**Data flow**: It writes remote-plugin config and auth, makes a mock backend return a workspace-scoped shared plugin, and sends read requests using two remote marketplace names. Each request is turned into a response whose plugin summary includes a share context copied from the remote data.

**Call relations**: This test uses write_remote_plugin_catalog_config for setup and the mock backend for remote catalog answers. The app server’s remote plugin reader must combine the remote plugin details with installed-state lookup and then expose the sharing fields in protocol form.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+4 more)).


##### `plugin_read_includes_share_url_for_admin_disabled_remote_plugin`  (lines 446–671)

```
async fn plugin_read_includes_share_url_for_admin_disabled_remote_plugin() -> Result<()>
```

**Purpose**: Checks that a remote plugin disabled by an administrator still shows its share URL and detailed metadata. This matters because users may need to understand why a plugin exists but cannot be used.

**Data flow**: It prepares remote config, auth, a mocked plugin detail response marked disabled by admin, and a mocked installed-plugin response where the plugin is installed but disabled. The read request produces a plugin response with disabled availability, share URL, description, keywords, prompts, disabled skill state, and app template summaries.

**Call relations**: The test sets up mock remote catalog calls and then asks the test app server to read the plugin. The server must merge data from plugin details and installed status, including app templates and disabled skills, into the final JSON-RPC response.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+4 more)).


##### `plugin_skill_read_reads_remote_skill_contents_when_remote_plugin_enabled`  (lines 674–735)

```
async fn plugin_skill_read_reads_remote_skill_contents_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Checks that the server can fetch the Markdown contents of a skill from a remote plugin. A skill is a plugin-provided instruction or capability description.

**Data flow**: It writes remote catalog config and auth, makes the mock backend return a skill body with Markdown text, and sends a plugin skill read request. The response is converted into a skill-read response containing that Markdown text.

**Call relations**: This test exercises the separate skill-read route rather than the broader plugin-read route. The app server must call the remote skill endpoint and hand the returned skill contents back to the client.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 13 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+3 more)).


##### `plugin_read_maps_missing_remote_plugin_to_invalid_request`  (lines 738–786)

```
async fn plugin_read_maps_missing_remote_plugin_to_invalid_request() -> Result<()>
```

**Purpose**: Checks that a missing remote plugin becomes a client-friendly invalid-request error instead of an internal crash. A 404 from the backend should tell the caller the requested plugin was not found.

**Data flow**: It configures a mock backend to return HTTP 404 for a remote plugin detail request. The test sends a read request and expects a JSON-RPC error with code -32600 and a message mentioning the failed remote catalog request.

**Call relations**: The test uses the remote catalog config helper and mock HTTP routing. The app server’s remote read path receives the 404 and is expected to translate it into the correct JSON-RPC error category.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 13 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, timeout (+3 more)).


##### `plugin_read_rejects_remote_marketplace_when_plugins_are_disabled`  (lines 789–838)

```
async fn plugin_read_rejects_remote_marketplace_when_plugins_are_disabled() -> Result<()>
```

**Purpose**: Checks that remote plugin reading is not allowed when the main plugins feature is disabled. This prevents remote plugin support from being enabled by only a partial feature flag.

**Data flow**: It writes config where plugins are off but remote_plugin is on, adds auth, starts the server, and sends a remote plugin read request. The result is an invalid-request error saying remote plugin read is not enabled.

**Call relations**: The test sends the request through the normal test server. The app server should reject it during feature-flag checks before making any remote backend calls.

*Call graph*: calls 2 internal fn (new, new); 9 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, write, timeout).


##### `plugin_read_rejects_invalid_remote_plugin_name`  (lines 841–869)

```
async fn plugin_read_rejects_invalid_remote_plugin_name() -> Result<()>
```

**Purpose**: Checks that remote plugin IDs cannot contain path-like characters such as slashes and traversal segments. This protects remote request construction from unsafe or malformed IDs.

**Data flow**: It writes remote config, starts the test server, and sends a remote plugin read request with a name like a path escape. The server returns an invalid-request error explaining the allowed characters.

**Call relations**: This test reaches the remote plugin validation logic through the app server. No mock backend is needed because the bad ID should be rejected before any network request is attempted.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_read_returns_canonical_openai_curated_marketplace_name`  (lines 872–927)

```
async fn plugin_read_returns_canonical_openai_curated_marketplace_name() -> Result<()>
```

**Purpose**: Checks that a local marketplace named openai-curated is reported consistently as openai-curated. This protects stable plugin IDs such as plugin-name@marketplace-name.

**Data flow**: It creates a fake local marketplace and plugin manifest, writes config enabling the plugin, marks it installed in the cache, then sends a local plugin read request. The response includes the canonical marketplace name, marketplace path, plugin ID, and plugin name.

**Call relations**: This test uses write_plugin_marketplace to create the marketplace and write_installed_plugin to simulate installation. The app server reads the local marketplace file and installed cache to build the response.

*Call graph*: calls 4 internal fn (new, write_installed_plugin, write_plugin_marketplace, try_from); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_share_context_for_shared_local_plugin`  (lines 930–1070)

```
async fn plugin_read_returns_share_context_for_shared_local_plugin() -> Result<()>
```

**Purpose**: Checks that a local plugin linked to a remote shared plugin shows sharing context from the remote catalog. This lets a locally available plugin still show who shared it and what remote version exists.

**Data flow**: It creates local plugin files, records a mapping from remote plugin ID to local plugin path, configures auth and a mock backend, and sends a local read request. The response keeps local version information and adds share context such as remote version, owner, editor, and share URL.

**Call relations**: The test combines local file setup through write_plugin_marketplace and write_plugin_share_local_path_mapping with remote data from the mock backend. The app server must notice the local path mapping, fetch remote share details, and attach them to the local plugin summary.

*Call graph*: calls 6 internal fn (new, new, write_plugin_marketplace, write_plugin_share_local_path_mapping, write_remote_plugin_catalog_config, try_from); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_read_keeps_remote_version_when_share_principals_are_missing`  (lines 1073–1175)

```
async fn plugin_read_keeps_remote_version_when_share_principals_are_missing() -> Result<()>
```

**Purpose**: Checks a careful edge case: if the remote shared-plugin response has no share principals, the server still preserves the remote version. It should not discard all share context just because some sharing details are absent.

**Data flow**: It sets up a local plugin mapped to a remote plugin and has the mock backend return remote details where share_principals is null. The final response contains remote plugin ID and remote version, while optional sharing fields like discoverability, URL, creator, and principals are empty.

**Call relations**: This follows the same local-plus-remote share-context path as the full shared-local test. It verifies the app server’s conversion logic handles incomplete remote sharing data without losing the version.

*Call graph*: calls 6 internal fn (new, new, write_plugin_marketplace, write_plugin_share_local_path_mapping, write_remote_plugin_catalog_config, try_from); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_read_falls_back_to_local_share_context_without_remote_auth`  (lines 1178–1228)

```
async fn plugin_read_falls_back_to_local_share_context_without_remote_auth() -> Result<()>
```

**Purpose**: Checks that a locally mapped shared plugin still shows a minimal share context when the user has no remote ChatGPT authentication. The server can at least say which remote plugin the local copy is linked to.

**Data flow**: It enables plugins, creates a local marketplace and plugin source, writes the local-path mapping, but does not write remote auth. The read response contains a share context with the remote plugin ID and leaves remote-only details blank.

**Call relations**: This test uses only local helpers and no mock backend. It confirms the app server can read the local mapping file and return partial share context without attempting authenticated remote enrichment.

*Call graph*: calls 6 internal fn (new, write_plugin_marketplace, write_plugin_share_local_path_mapping, write_plugin_source, write_plugins_enabled_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `plugin_read_fails_on_malformed_share_mapping`  (lines 1231–1277)

```
async fn plugin_read_fails_on_malformed_share_mapping() -> Result<()>
```

**Purpose**: Checks that a corrupted local share-mapping file causes a clear internal error. This file connects remote shared plugin IDs to local plugin paths, so bad JSON must not be silently ignored.

**Data flow**: It creates a valid local plugin setup but writes invalid text into the share mapping JSON file. The plugin read request returns a JSON-RPC internal error mentioning failure to load the mapping.

**Call relations**: The test uses local setup helpers, then forces the app server into the mapping-reading path. The app server is expected to report the malformed local state rather than producing misleading plugin data.

*Call graph*: calls 5 internal fn (new, write_plugin_marketplace, write_plugin_source, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_plugin_details_with_bundle_contents`  (lines 1280–1556)

```
async fn plugin_read_returns_plugin_details_with_bundle_contents() -> Result<()>
```

**Purpose**: Checks the full local plugin bundle reading path. It verifies that manifests, skills, hooks, app definitions, MCP server definitions, install state, enable state, policies, and interface metadata are all reflected in the response.

**Data flow**: It builds a realistic plugin directory tree with marketplace data, plugin.json, skill Markdown files, product policy files, an app file, an MCP file, and hooks. It also writes user config that disables one skill and one hook entry, then sends a read request. The response contains the expected plugin details and filters out a ChatGPT-only skill.

**Call relations**: This is the broadest local plugin read test. The app server reads many files from the fake repository and the fake Codex home, combines them with config state, and returns one protocol response representing the plugin bundle.

*Call graph*: calls 3 internal fn (new, write_installed_plugin, try_from); 8 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_app_metadata_category`  (lines 1559–1660)

```
async fn plugin_read_returns_app_metadata_category() -> Result<()>
```

**Purpose**: Checks that app connector category metadata is copied into plugin app summaries. This helps the UI show connector apps in the right category.

**Data flow**: It starts a small local apps server returning two connector records, writes connector config and auth, creates a plugin that references those apps, and sends a plugin read request. The response shows a category for the app whose remote metadata had one and no category for the other.

**Call relations**: This test calls start_apps_server and write_connectors_config. During plugin read, the app server fetches connector data from the fake apps server and enriches local plugin app entries with that information.

*Call graph*: calls 7 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 7 external calls (new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `plugin_read_hides_apps_for_api_key_auth`  (lines 1663–1748)

```
async fn plugin_read_hides_apps_for_api_key_auth() -> Result<()>
```

**Purpose**: Checks that connector apps are hidden when the user is authenticated only with an API key. App connector information requires ChatGPT-style account auth, but MCP server names should still be shown.

**Data flow**: It starts a fake apps server, writes connector config, stores an API-key auth file, creates a plugin with an app and matching MCP server, and starts the test server with token environment variables cleared. The response has no apps but still lists the MCP server.

**Call relations**: This test uses start_apps_server but expects the app server not to expose app connector details under API-key auth. It proves the local plugin reader separates app visibility from MCP server discovery.

*Call graph*: calls 6 internal fn (new_with_env, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 8 external calls (new, Integer, to_response, assert!, assert_eq!, write, timeout, vec!).


##### `plugin_read_accepts_legacy_string_default_prompt`  (lines 1751–1814)

```
async fn plugin_read_accepts_legacy_string_default_prompt() -> Result<()>
```

**Purpose**: Checks backward compatibility for older plugin manifests where defaultPrompt is a single string instead of a list. The server should normalize it into the modern list form.

**Data flow**: It creates a local marketplace and plugin manifest containing one string default prompt, enables plugins, and sends a read request. The response contains default_prompt as a one-item list.

**Call relations**: The test reaches the manifest parsing and response conversion path. It ensures older plugin files still work with clients that expect the newer protocol shape.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_describes_uninstalled_git_source_without_cloning`  (lines 1817–1884)

```
async fn plugin_read_describes_uninstalled_git_source_without_cloning() -> Result<()>
```

**Purpose**: Checks that an uninstalled plugin whose source is another git repository is described without cloning that repository. This avoids slow or surprising network/disk work just to view a marketplace listing.

**Data flow**: It creates a marketplace entry pointing at a missing git-subdir source, enables plugins, and sends a read request. The response contains a generic description with the source URL and path, says the plugin is not installed, and no staging clone directory appears.

**Call relations**: This test drives the local marketplace reading path for an uninstalled cross-repo plugin. The app server should return lightweight listing information and stop before any clone or bundle inspection.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 10 external calls (new, Integer, to_response, assert!, assert_eq!, format!, create_dir_all, write, timeout, from_directory_path).


##### `plugin_read_returns_invalid_request_when_plugin_is_missing`  (lines 1887–1935)

```
async fn plugin_read_returns_invalid_request_when_plugin_is_missing() -> Result<()>
```

**Purpose**: Checks that asking for a plugin name not present in the marketplace returns a clear invalid-request error. This gives callers a useful explanation instead of an empty or confusing response.

**Data flow**: It creates a marketplace with one plugin, enables plugins, then requests a different plugin name. The server returns an error code for invalid request and a message saying the requested plugin was not found.

**Call relations**: The test exercises the marketplace lookup part of local plugin read. The app server reads the marketplace file, fails to find the requested entry, and reports that failure to the JSON-RPC caller.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_invalid_request_when_plugin_manifest_is_missing`  (lines 1938–1984)

```
async fn plugin_read_returns_invalid_request_when_plugin_manifest_is_missing() -> Result<()>
```

**Purpose**: Checks that a marketplace entry pointing to a local plugin directory without a plugin manifest fails clearly. The manifest is the main file that tells the server what the plugin is.

**Data flow**: It creates a marketplace and an empty plugin directory, enables plugins, and sends a read request. The result is an invalid-request error mentioning a missing or invalid plugin.json.

**Call relations**: The test reaches the local bundle inspection path. After the marketplace lookup succeeds, the app server tries to read the plugin manifest and converts that missing-file problem into a user-facing request error.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `write_installed_plugin`  (lines 1986–2003)

```
fn write_installed_plugin(
    codex_home: &TempDir,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<()>
```

**Purpose**: Creates just enough installed-plugin cache data for tests that need the server to believe a plugin is installed. It writes a minimal plugin.json into the expected cache location.

**Data flow**: It receives a temporary Codex home, marketplace name, and plugin name. It builds the cache path, creates the directories, writes a tiny manifest with the plugin name, and returns success or a file-system error.

**Call relations**: The canonical marketplace and full bundle tests call this helper before starting the test server. The app server later reads the cache path created here when deciding installed status.

*Call graph*: called by 2 (plugin_read_returns_canonical_openai_curated_marketplace_name, plugin_read_returns_plugin_details_with_bundle_contents); 4 external calls (path, format!, create_dir_all, write).


##### `write_plugins_enabled_config`  (lines 2005–2013)

```
fn write_plugins_enabled_config(codex_home: &TempDir) -> Result<()>
```

**Purpose**: Writes a minimal config file that turns the plugins feature on. Tests use it when they do not need any other configuration.

**Data flow**: It receives a temporary Codex home and writes config.toml containing only the plugins feature flag. The output is a file on disk and either success or an I/O error.

**Call relations**: Several local plugin tests call this setup helper before launching the test app server. The server then reads this config during initialization so plugin read requests are allowed.

*Call graph*: called by 6 (plugin_read_accepts_legacy_string_default_prompt, plugin_read_describes_uninstalled_git_source_without_cloning, plugin_read_fails_on_malformed_share_mapping, plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_returns_invalid_request_when_plugin_is_missing, plugin_read_returns_invalid_request_when_plugin_manifest_is_missing); 2 external calls (path, write).


##### `start_apps_server`  (lines 2020–2042)

```
async fn start_apps_server(connectors: Vec<AppInfo>) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts a tiny local HTTP server that pretends to be the connector directory API. Tests use it to check how plugin reading enriches app information.

**Data flow**: It receives a list of app connector records, stores them in shared state protected by a mutex, binds to a random local port, installs routes for connector-list endpoints, and spawns the server task. It returns the base URL and the task handle so the test can stop it later.

**Call relations**: The app metadata and API-key-auth tests call this helper. When the app server tries to fetch connector data, the routes created here hand the request to list_directory_connectors.

*Call graph*: called by 2 (plugin_read_hides_apps_for_api_key_auth, plugin_read_returns_app_metadata_category); 9 external calls (new, new, new, bind, get, serve, format!, json!, spawn).


##### `list_directory_connectors`  (lines 2044–2073)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Responds to fake connector-directory HTTP requests during tests. It checks that the request has the expected bearer token, account ID, and query option before returning connector data.

**Data flow**: It receives shared server state, HTTP headers, and the request URI. It validates the authorization header, account header, and external_logos=true query parameter; if any check fails it returns an HTTP error, otherwise it clones the stored JSON and returns it.

**Call relations**: This function is registered as the route handler by start_apps_server. It is called by Axum, the web framework, whenever the test app server asks the fake connector API for app listings.

*Call graph*: 3 external calls (get, query, Json).


##### `write_connectors_config`  (lines 2075–2090)

```
fn write_connectors_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes config that points the app server at a test connector API and enables both plugins and connectors. It also chooses file-based credential stores for the test.

**Data flow**: It receives a Codex home path and a base URL, formats a config.toml with that URL and feature flags, and writes it to disk. The result is a config file the test server can read at startup.

**Call relations**: The connector category and API-key-auth tests call this before launching the test server. The app server later uses the written base URL when it tries to fetch connector directory data.

*Call graph*: called by 2 (plugin_read_hides_apps_for_api_key_auth, plugin_read_returns_app_metadata_category); 3 external calls (join, format!, write).


##### `write_remote_plugin_catalog_config`  (lines 2092–2108)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config that points remote plugin catalog calls at a test backend and enables remote plugin support. This lets tests use a mock server instead of the real ChatGPT backend.

**Data flow**: It receives a Codex home path and backend base URL, formats a config.toml with plugins and remote_plugin enabled, and writes it to disk. The output is the server startup config for remote plugin tests.

**Call relations**: Most remote plugin tests call this helper before writing auth and starting the app server. The app server then sends remote catalog requests to the mock URL configured here.

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

**Purpose**: Creates a minimal local plugin marketplace file for tests. A marketplace is the list that tells the server which plugins exist and where their source lives.

**Data flow**: It receives a repository root, marketplace name, plugin name, and source path. It creates fake repository and marketplace directories, writes marketplace.json with one local plugin entry, and returns any I/O error if setup fails.

**Call relations**: Many local plugin tests call this helper to avoid repeating marketplace setup. The app server later reads the marketplace.json file produced here when handling plugin read requests.

*Call graph*: called by 7 (plugin_read_fails_on_malformed_share_mapping, plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_hides_apps_for_api_key_auth, plugin_read_keeps_remote_version_when_share_principals_are_missing, plugin_read_returns_app_metadata_category, plugin_read_returns_canonical_openai_curated_marketplace_name, plugin_read_returns_share_context_for_shared_local_plugin); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin_source`  (lines 2137–2158)

```
fn write_plugin_source(
    repo_root: &std::path::Path,
    plugin_name: &str,
    app_ids: &[&str],
) -> Result<()>
```

**Purpose**: Creates a simple local plugin source directory with a manifest and optional app references. It is a shortcut for tests that do not need a full plugin bundle.

**Data flow**: It receives a repository root, plugin name, and list of app IDs. It creates the plugin manifest folder, writes plugin.json, builds an .app.json file from the app IDs, and writes that JSON to disk.

**Call relations**: Tests for app enrichment, API-key hiding, share fallback, and malformed share mapping use this helper. The app server later reads the files it creates while building the plugin response.

*Call graph*: called by 4 (plugin_read_fails_on_malformed_share_mapping, plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_hides_apps_for_api_key_auth, plugin_read_returns_app_metadata_category); 6 external calls (join, format!, json!, to_vec_pretty, create_dir_all, write).


##### `write_plugin_share_local_path_mapping`  (lines 2160–2179)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &std::path::Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
) -> std::io::Result<()>
```

**Purpose**: Writes the local mapping file that links a remote shared plugin ID to a local plugin path. Tests use it to simulate a plugin that was shared remotely but is also present on disk.

**Data flow**: It receives a Codex home path, remote plugin ID, and absolute local plugin path. It serializes that mapping as JSON, creates the temporary directory, writes the mapping file, and returns success or an I/O error.

**Call relations**: The shared-local-plugin tests and fallback test call this helper before reading the plugin. The app server later loads this mapping to decide whether to attach share context to a local plugin summary.

*Call graph*: called by 3 (plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_keeps_remote_version_when_share_principals_are_missing, plugin_read_returns_share_context_for_shared_local_plugin); 8 external calls (join, format!, json!, new, to_string_pretty, to_value, create_dir_all, write).


### `app-server/tests/suite/v2/marketplace_add.rs`

`test` · `test run`

This is an integration test, meaning it checks several parts of the app working together rather than testing one small helper in isolation. The test builds a tiny fake marketplace inside a temporary Codex home folder. That fake marketplace contains the minimum files the server expects: a marketplace description file, a sample plugin description, and a marker text file used to prove the original local content is still there.

The test then starts a real test app server and sends it a JSON-RPC request. JSON-RPC is a simple request-and-response message format often used between tools and servers. The request asks the server to add a marketplace using the relative path `./marketplace`, rather than a remote repository or an absolute path.

After sending the request, the test waits for the matching response, but only up to a fixed timeout so a broken server cannot make the test hang forever. It checks three important results: the marketplace name was read from the JSON file, the installed root points to the real canonical path of the local directory, and the server says this marketplace was not already added. Finally, it reads the marker file back from the installed location. This is like putting a note in a box before handing it to someone, then checking the note is still there afterward.

#### Function details

##### `marketplace_add_local_directory_source`  (lines 17–62)

```
async fn marketplace_add_local_directory_source() -> Result<()>
```

**Purpose**: This test verifies that adding a marketplace from a local directory works end to end. It checks that the server reads the marketplace metadata, returns the correct local path, and does not treat a first-time add as a duplicate.

**Data flow**: It starts with an empty temporary Codex home folder. The test writes a small marketplace structure into that folder, starts a test app server pointed at the folder, and sends a marketplace-add request using a relative path. The server response is converted into a typed result, then the test compares the returned name, installed path, duplicate flag, and marker file contents against the expected values.

**Call relations**: The async test runner starts this function as a test case. Inside it, the function creates the test server, initializes it, sends the marketplace-add request, waits for the matching JSON-RPC response, converts that response into a `MarketplaceAddResponse`, and then uses assertions to confirm the server behaved correctly.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 8 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout).


### `app-server/tests/suite/v2/plugin_install.rs`

`test` · `test run`

Plugin installation touches many risky and user-visible things: it reads marketplace files, downloads remote bundles, writes plugin files into a cache, talks to ChatGPT backend endpoints, checks workspace settings, starts OAuth discovery for MCP servers, and reports analytics. This test file builds small fake worlds around those behaviors and checks that the app server makes the right choices.

The tests use temporary folders as a fake Codex home and fake repositories. They also use mock HTTP servers, which are small pretend web servers that return controlled responses. This lets the tests simulate remote plugin catalogs, bundle downloads, connector directories, analytics collection, and OAuth discovery without calling real services.

A large part of the file is helper code. Some helpers write config files and plugin manifests. Others mount fake backend routes, build tiny compressed plugin bundles, or count whether a request happened. The tests then install plugins through the same JSON-RPC-style server interface a real client would use and inspect the response, written files, and outbound requests.

Without this file, the plugin installer could regress in subtle ways: accepting unsafe paths, installing disabled plugins, failing to cache remote bundles correctly, starting OAuth when it should not, or missing analytics events.

#### Function details

##### `plugin_install_rejects_relative_marketplace_paths`  (lines 73–97)

```
async fn plugin_install_rejects_relative_marketplace_paths() -> Result<()>
```

**Purpose**: Checks that a plugin install request cannot point to a marketplace file using a relative path. This matters because relative paths can be ambiguous and unsafe.

**Data flow**: It creates a temporary server home, starts the test app server, sends a raw install request with a relative marketplace path, and waits for an error. The expected output is an invalid-request error saying the request is not acceptable.

**Call relations**: The async test runner calls this test directly. It relies on the test server setup and request-reading helpers, then stops at the error response instead of continuing into any install flow.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, json!, timeout).


##### `plugin_install_rejects_missing_install_source`  (lines 100–126)

```
async fn plugin_install_rejects_missing_install_source() -> Result<()>
```

**Purpose**: Checks that an install request must say where the plugin comes from. The installer requires either a local marketplace path or a remote marketplace name.

**Data flow**: It sends an install request with neither source field filled in. The app server turns that bad input into an invalid-request error explaining that exactly one source is required.

**Call relations**: The test runner invokes it as a standalone case. It uses the app server’s normal plugin install request helper and then reads the matching error response.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_rejects_multiple_install_sources`  (lines 129–157)

```
async fn plugin_install_rejects_multiple_install_sources() -> Result<()>
```

**Purpose**: Checks that an install request cannot provide both a local marketplace file and a remote marketplace name. This avoids unclear behavior about which source should win.

**Data flow**: It builds a fake absolute marketplace path and also supplies a remote marketplace name. The server rejects the request before attempting any install and returns an invalid-request error.

**Call relations**: The test runner calls this case. It exercises the app server’s validation path through the normal plugin install request helper.

*Call graph*: calls 2 internal fn (new, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_rejects_remote_marketplace_when_plugins_are_disabled`  (lines 160–192)

```
async fn plugin_install_rejects_remote_marketplace_when_plugins_are_disabled() -> Result<()>
```

**Purpose**: Checks that remote plugin installation is blocked when the plugins feature is turned off in config. This protects deployments where plugins are intentionally disabled.

**Data flow**: It writes a config file with plugins disabled, starts the server, and asks to install a remote plugin. The output is an invalid-request error saying remote plugin install is not enabled.

**Call relations**: The test runner invokes it. The test sets up local config on disk, then uses the normal install request and error-reading path.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, write, timeout).


##### `plugin_install_writes_remote_plugin_to_cloud_and_cache`  (lines 195–289)

```
async fn plugin_install_writes_remote_plugin_to_cloud_and_cache() -> Result<()>
```

**Purpose**: Checks the happy path for installing a remote plugin: download the bundle, write it to the local cache, notify the backend, and return the expected install response.

**Data flow**: It creates a fake backend, a fake downloadable tar.gz plugin bundle, and a fake plugin detail response. After sending the remote install request, it checks the JSON response, verifies backend and bundle requests happened once, and confirms the plugin manifest, app manifest, and skill file were written in the expected cache location.

**Call relations**: The test runner calls this scenario. It depends on helpers that configure remote plugin auth, mount fake backend endpoints, build the bundle bytes, send the install request, and wait for recorded request counts.

*Call graph*: calls 9 internal fn (new_with_env, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_app_manifest, mount_remote_plugin_install_after_cache_write, remote_plugin_bundle_tar_gz_bytes_with_contents, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 11 external calls (start, new, Integer, to_response, assert!, assert_eq!, format!, json!, from_str, read_to_string (+1 more)).


##### `plugin_install_uses_remote_apps_needing_auth_response`  (lines 292–357)

```
async fn plugin_install_uses_remote_apps_needing_auth_response() -> Result<()>
```

**Purpose**: Checks that when the remote backend says which apps need authentication, the installer uses that answer instead of refetching the connector directory.

**Data flow**: It prepares a remote plugin whose install response includes an app id needing auth. The server returns a PluginInstallResponse containing an app summary for that id, and the test verifies the connector-directory endpoint was not called.

**Call relations**: The test runner invokes it. It uses remote plugin setup helpers, then relies on request-count checking to prove the installer did not take an unnecessary fallback path.

*Call graph*: calls 9 internal fn (new_with_env, configure_remote_plugin_with_apps_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_app_manifest, mount_remote_plugin_install_with_apps_needing_auth, remote_plugin_bundle_tar_gz_bytes, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, to_response, assert_eq!, json!, timeout).


##### `plugin_install_rejects_missing_remote_bundle_url`  (lines 360–403)

```
async fn plugin_install_rejects_missing_remote_bundle_url() -> Result<()>
```

**Purpose**: Checks that a remote plugin cannot be installed if the backend does not provide a download URL for its bundle.

**Data flow**: It mounts a remote plugin detail response with no bundle URL, sends an install request, and receives an internal error. It also confirms the backend install endpoint was not called and no cache directory was created.

**Call relations**: The test runner calls it. It uses remote setup helpers and the request-count helper to confirm the installer stopped before cloud install or local cache writes.

*Call graph*: calls 6 internal fn (new, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_detail, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_plain_http_remote_bundle_url`  (lines 406–444)

```
async fn plugin_install_rejects_plain_http_remote_bundle_url() -> Result<()>
```

**Purpose**: Checks that plain HTTP bundle downloads are rejected by default. This prevents silently downloading plugin code over an insecure connection.

**Data flow**: It gives the installer an HTTP bundle URL from the mock server without enabling the test-only HTTP override. The installer returns an error about the unsupported URL scheme and does not install or cache anything.

**Call relations**: The test runner calls this case. It uses fake remote plugin endpoints and verifies through request counts that the cloud install endpoint was not contacted.

*Call graph*: calls 6 internal fn (new, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_detail, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_invalid_remote_release_version`  (lines 447–486)

```
async fn plugin_install_rejects_invalid_remote_release_version() -> Result<()>
```

**Purpose**: Checks that a remote release version cannot contain path-like tricks such as ../. This helps prevent writing downloaded files outside the intended cache area.

**Data flow**: It mounts plugin details with a malicious-looking version string, sends an install request, and expects an internal error about an invalid release version. The cache remains untouched and the install endpoint is not called.

**Call relations**: The test runner invokes it. It follows the normal remote install path until the version safety check rejects the input.

*Call graph*: calls 6 internal fn (new, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_detail, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_invalid_remote_plugin_name`  (lines 489–512)

```
async fn plugin_install_rejects_invalid_remote_plugin_name() -> Result<()>
```

**Purpose**: Checks that a remote plugin id with path traversal characters is rejected. This guards against using plugin names as unsafe file paths.

**Data flow**: It writes remote-plugin config, starts the server, and sends a plugin name containing slashes and .. segments. The server returns an invalid-request error before contacting any backend.

**Call relations**: The test runner calls it. It uses the catalog config helper and the normal install request helper to exercise front-door validation.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_rejects_remote_plugin_disabled_by_admin_before_download`  (lines 515–572)

```
async fn plugin_install_rejects_remote_plugin_disabled_by_admin_before_download() -> Result<()>
```

**Purpose**: Checks that a remote plugin marked disabled by an administrator is rejected before its bundle is downloaded.

**Data flow**: It sets up a fake plugin detail response with disabled status and a valid-looking bundle URL. The installer returns an invalid-request error, and the test confirms neither the bundle download nor backend install request happened.

**Call relations**: The test runner invokes it. It uses the detail-mounting helper that can set availability status, then uses request-count checks to prove the installer stopped early.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_status, remote_plugin_bundle_tar_gz_bytes, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_when_workspace_codex_plugins_disabled`  (lines 575–639)

```
async fn plugin_install_rejects_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Checks that workspace-level settings from the backend can block plugin installation even if local plugin files are valid.

**Data flow**: It writes config and auth, creates a local marketplace and plugin source, and mounts an account settings response saying plugins are disabled. The install request returns an invalid-request error about Codex plugins being disabled for the workspace.

**Call relations**: The test runner calls it. It combines local plugin fixture helpers with a mock backend account-settings route to test policy enforcement.

*Call graph*: calls 6 internal fn (new, new, write_plugin_marketplace, write_plugin_source, write_plugins_enabled_config_with_base_url, try_from); 13 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, timeout (+3 more)).


##### `plugin_install_returns_invalid_request_for_missing_marketplace_file`  (lines 642–667)

```
async fn plugin_install_returns_invalid_request_for_missing_marketplace_file() -> Result<()>
```

**Purpose**: Checks that installing from a non-existent marketplace file gives a clear invalid-request error.

**Data flow**: It points the install request at an absolute path that does not exist. The server responds with an error mentioning that the marketplace file does not exist.

**Call relations**: The test runner invokes it. The test uses the normal server initialization and install request flow, but expects validation to fail before reading plugin metadata.

*Call graph*: calls 2 internal fn (new, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_returns_invalid_request_for_not_available_plugin`  (lines 670–705)

```
async fn plugin_install_returns_invalid_request_for_not_available_plugin() -> Result<()>
```

**Purpose**: Checks that a plugin whose marketplace policy says it is not available cannot be installed.

**Data flow**: It writes a marketplace entry with a NOT_AVAILABLE install policy and a valid plugin source. The server rejects the install request with an invalid-request error saying the plugin is not available.

**Call relations**: The test runner calls it. It uses marketplace and source-writing helpers to build the local fixture and then exercises the installer’s policy check.

*Call graph*: calls 4 internal fn (new, write_plugin_marketplace, write_plugin_source, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_returns_invalid_request_for_disallowed_product_plugin`  (lines 708–755)

```
async fn plugin_install_returns_invalid_request_for_disallowed_product_plugin() -> Result<()>
```

**Purpose**: Checks that a plugin limited to a different product surface is rejected. This prevents installing plugins that are meant only for another client.

**Data flow**: It writes a marketplace entry whose policy allows only CHATGPT, then starts the test app server as an Atlas session. The install request is rejected as not available for install.

**Call relations**: The test runner invokes it. Unlike the shared marketplace helper, this test writes a custom marketplace JSON so it can set the product policy exactly.

*Call graph*: calls 3 internal fn (new_with_args, write_plugin_source, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_install_tracks_analytics_event`  (lines 758–821)

```
async fn plugin_install_tracks_analytics_event() -> Result<()>
```

**Purpose**: Checks that installing a local plugin sends the expected analytics event. Analytics here means a usage report sent to the configured backend.

**Data flow**: It starts a fake analytics server, writes config and auth, installs a local plugin, then waits until the analytics request arrives. The payload must describe the installed plugin, marketplace, skill presence, connector ids, and client name.

**Call relations**: The test runner calls it. It uses local plugin fixture helpers and then hands off to wait_for_plugin_analytics_payload to inspect the outgoing event.

*Call graph*: calls 7 internal fn (new, new, wait_for_plugin_analytics_payload, write_analytics_config, write_plugin_marketplace, write_plugin_source, try_from); 7 external calls (new, Integer, start_analytics_events_server, to_response, write_chatgpt_auth, assert_eq!, timeout).


##### `plugin_install_tracks_remote_plugin_analytics_event`  (lines 824–874)

```
async fn plugin_install_tracks_remote_plugin_analytics_event() -> Result<()>
```

**Purpose**: Checks that installing a remote plugin also reports the correct analytics event.

**Data flow**: It configures fake remote plugin detail, bundle, install, and analytics endpoints. After installation succeeds, it reads the analytics request and checks that it reports the remote plugin id, marketplace name, plugin name, skills, and client name.

**Call relations**: The test runner invokes it. It uses remote endpoint helpers and the analytics payload waiter to verify the install flow’s reporting side effect.

*Call graph*: calls 10 internal fn (new_with_env, configure_remote_plugin_test, mount_backend_analytics_events, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install, remote_plugin_bundle_tar_gz_bytes, send_remote_plugin_install_request, wait_for_plugin_analytics_payload); 6 external calls (start, new, Integer, to_response, assert_eq!, timeout).


##### `plugin_install_errors_when_remote_bundle_download_fails`  (lines 877–928)

```
async fn plugin_install_errors_when_remote_bundle_download_fails() -> Result<()>
```

**Purpose**: Checks that a failed remote bundle download stops installation cleanly.

**Data flow**: It mounts the bundle URL to return HTTP 503, then sends the remote install request. The server returns an internal error mentioning the failed status, records one download attempt, does not call the backend install endpoint, and does not create cache files.

**Call relations**: The test runner calls it. It shares the remote plugin setup helpers with happy-path tests, but changes the bundle response to trigger the error path.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_returns_apps_needing_auth`  (lines 931–1028)

```
async fn plugin_install_returns_apps_needing_auth() -> Result<()>
```

**Purpose**: Checks that local plugin installation returns a list of connector apps the user still needs to authorize.

**Data flow**: It starts a fake apps server with two connectors and an MCP tool for one of them, writes a plugin that references both app ids, and installs it. The response reports only the connector that is enabled but not accessible and needs user authorization.

**Call relations**: The test runner invokes it. It uses start_apps_server for connector data and local plugin helpers for the install fixture, then shuts the fake server down.

*Call graph*: calls 7 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 8 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin`  (lines 1031–1099)

```
async fn plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin() -> Result<()>
```

**Purpose**: Checks that MCP OAuth discovery is skipped when a plugin also has a ChatGPT connector app for the same MCP surface.

**Data flow**: It creates a connector app named like the MCP server, writes a plugin with both app and MCP config, installs it, and confirms no OAuth discovery request reached the mock OAuth server.

**Call relations**: The test runner calls it. It uses the fake apps server, plugin source helper, MCP config helper, and OAuth request counter to prove the skip behavior.

*Call graph*: calls 8 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_mcp_config, write_plugin_source, try_from); 9 external calls (start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed`  (lines 1102–1160)

```
async fn plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed() -> Result<()>
```

**Purpose**: Checks that MCP OAuth discovery does start when the plugin’s app id is not allowed as a ChatGPT connector app.

**Data flow**: It starts an empty apps server, writes a plugin with a disallowed-looking app id and an HTTP MCP server, then installs it. The response has no apps needing auth, and the mock OAuth server receives discovery traffic.

**Call relations**: The test runner invokes it. It uses the same fixture pattern as the skip test, but with no matching connector so the installer falls through to MCP OAuth.

*Call graph*: calls 8 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_mcp_config, write_plugin_source, try_from); 9 external calls (start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout).


##### `plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin`  (lines 1163–1215)

```
async fn plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin() -> Result<()>
```

**Purpose**: Checks that when the user authenticates with an API key instead of ChatGPT credentials, MCP OAuth discovery still starts for a dual-surface plugin.

**Data flow**: It writes config enabling plugins and connectors, supplies an OPENAI_API_KEY environment variable, creates a plugin with app and MCP config, and installs it. The OAuth mock receives discovery requests.

**Call relations**: The test runner calls it. It uses the plugin fixture helpers and the OAuth request counter, but no ChatGPT connector directory server.

*Call graph*: calls 5 internal fn (new_with_env, write_plugin_marketplace, write_plugin_mcp_config, write_plugin_source, try_from); 8 external calls (start, new, Integer, to_response, assert!, assert_eq!, write, timeout).


##### `plugin_install_starts_remote_mcp_oauth_for_install_response_only_app`  (lines 1218–1263)

```
async fn plugin_install_starts_remote_mcp_oauth_for_install_response_only_app() -> Result<()>
```

**Purpose**: Checks that a remote plugin can trigger MCP OAuth when the app needing auth comes only from the backend install response.

**Data flow**: It builds a remote plugin bundle containing MCP config, makes the backend install response name an app needing auth, installs the plugin, and verifies both the returned app summary and OAuth discovery traffic.

**Call relations**: The test runner invokes it. It combines remote bundle-building helpers, remote install response helpers, and the OAuth counter.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_with_apps_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install_with_apps_needing_auth, remote_plugin_bundle_tar_gz_bytes_with_mcp_config, send_remote_plugin_install_request); 7 external calls (start, new, Integer, to_response, assert!, assert_eq!, timeout).


##### `plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app`  (lines 1266–1315)

```
async fn plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app() -> Result<()>
```

**Purpose**: Checks that a remote plugin skips MCP OAuth when the bundle includes an app manifest that maps the same MCP server name to the app needing auth.

**Data flow**: It builds a remote bundle containing both an app manifest and MCP config, has the backend say that app needs auth, and installs the plugin. The response lists the app, but the OAuth server receives no discovery request.

**Call relations**: The test runner calls it. It uses the bundle helper that includes app and MCP entries, plus the remote install-with-apps helper and OAuth request counter.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_with_apps_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install_with_apps_needing_auth, remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config, send_remote_plugin_install_request); 6 external calls (start, new, Integer, to_response, assert_eq!, timeout).


##### `plugin_install_filters_disallowed_apps_needing_auth`  (lines 1318–1406)

```
async fn plugin_install_filters_disallowed_apps_needing_auth() -> Result<()>
```

**Purpose**: Checks that the installer only reports apps needing auth if those apps are allowed connector apps.

**Data flow**: It warms the app directory cache with one allowed connector, writes a plugin that references that app and a disallowed app id, then installs it. The response lists only the allowed connector, and the test confirms the cached directory was reused.

**Call relations**: The test runner invokes it. It calls start_apps_server, warm_app_directory_cache, and local plugin fixture helpers before checking the install response.

*Call graph*: calls 8 internal fn (new, new, start_apps_server, warm_app_directory_cache, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 8 external calls (new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `plugin_install_makes_bundled_mcp_servers_available_to_followup_requests`  (lines 1409–1479)

```
async fn plugin_install_makes_bundled_mcp_servers_available_to_followup_requests() -> Result<()>
```

**Purpose**: Checks that MCP servers bundled inside an installed plugin become known to later server requests without being copied into the user’s main config file.

**Data flow**: It installs a local plugin containing a .mcp.json file with an echo command server. It confirms the main config was not rewritten with that server, then sends a follow-up OAuth login request for the bundled server and gets the expected error for a non-HTTP MCP server.

**Call relations**: The test runner calls it. It uses local marketplace and source helpers, then performs a second request against the same running app server to prove the installed plugin affected later behavior.

*Call graph*: calls 4 internal fn (new, write_plugin_marketplace, write_plugin_source, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, json!, read_to_string, write, timeout).


##### `AppsServerControl::directory_request_count`  (lines 1493–1495)

```
fn directory_request_count(&self) -> usize
```

**Purpose**: Returns how many connector directory requests the fake apps server has received. Tests use it to prove whether the app server fetched or reused connector data.

**Data flow**: It reads an atomic counter, which is a number safe to share between running tasks, and returns the current value as a usize. It does not change any state.

**Call relations**: Helper tests call this through AppsServerControl, especially after start_apps_server creates the control object and list_directory_connectors increments the shared counter.


##### `warm_app_directory_cache`  (lines 1498–1524)

```
async fn warm_app_directory_cache(
    mcp: &mut TestAppServer,
    server_control: &AppsServerControl,
    expected_app_name: &str,
) -> Result<usize>
```

**Purpose**: Forces the app server to fetch the connector directory once, then returns the request count. This gives later tests a known cached state.

**Data flow**: It sends an apps/list request with force_refetch set, reads the JSON-RPC response, checks that an expected app name appears, then reads and returns the fake server’s directory request count.

**Call relations**: plugin_install_filters_disallowed_apps_needing_auth calls this before installing a plugin. It uses the app list request path and AppsServerControl::directory_request_count to prepare and measure the cache.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_apps_list_request); called by 1 (plugin_install_filters_disallowed_apps_needing_auth); 6 external calls (default, Integer, directory_request_count, to_response, assert!, timeout).


##### `PluginInstallMcpServer::get_info`  (lines 1532–1534)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Describes the fake MCP server’s capabilities to clients. In these tests, it says the server supports tools.

**Data flow**: It builds a ServerInfo value with tool support enabled and returns it. No input data is read beyond the receiver itself.

**Call relations**: The RMCP streamable HTTP service calls this when a client connects and asks what the fake MCP server can do.

*Call graph*: 2 external calls (builder, new).


##### `PluginInstallMcpServer::list_tools`  (lines 1536–1554)

```
fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Futu
```

**Purpose**: Returns the list of fake MCP tools configured for the test server. These tools can carry connector metadata used by plugin install tests.

**Data flow**: It clones the shared tools list while holding a mutex, which is a lock that prevents simultaneous mutation, and returns it in a ListToolsResult with no next page.

**Call relations**: The RMCP service calls this when the app server lists tools from the fake MCP endpoint. start_apps_server provides the shared tools list used here.


##### `start_apps_server`  (lines 1557–1601)

```
async fn start_apps_server(
    connectors: Vec<AppInfo>,
    tools: Vec<Tool>,
) -> Result<(String, JoinHandle<()>, AppsServerControl)>
```

**Purpose**: Starts a small fake ChatGPT apps and MCP server for tests. It lets plugin installation code ask for connector directories and MCP tools without using real network services.

**Data flow**: It receives connector records and tool records, stores them in shared state, binds a random local TCP port, builds an Axum router with directory routes and an MCP service, spawns it in the background, and returns the base URL, task handle, and control object.

**Call relations**: Several plugin install tests call this when they need connector-directory behavior. Its routes call list_directory_connectors, and its MCP service uses PluginInstallMcpServer.

*Call graph*: called by 4 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_returns_apps_needing_auth, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed); 13 external calls (new, new, default, new, new, default, new, bind, get, serve (+3 more)).


##### `list_directory_connectors`  (lines 1603–1634)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Serves the fake connector directory endpoint. It checks that the app server sends the expected auth headers and query parameter.

**Data flow**: It increments the request counter, reads headers and the URL query, and rejects missing auth or missing external_logos=true. If the request is valid, it returns the stored connector JSON.

**Call relations**: The Axum router created by start_apps_server calls this for directory-list routes. Tests later inspect the counter through AppsServerControl.

*Call graph*: 3 external calls (get, query, Json).


##### `connector_tool`  (lines 1636–1655)

```
fn connector_tool(connector_id: &str, connector_name: &str) -> Result<Tool>
```

**Purpose**: Builds a fake MCP tool that represents a connector app. The tool metadata tells the installer which connector id and name it belongs to.

**Data flow**: It receives a connector id and display name, creates a minimal JSON schema, marks the tool read-only, attaches connector metadata, and returns the Tool.

**Call relations**: plugin_install_returns_apps_needing_auth uses this to populate start_apps_server with an MCP tool tied to a connector.

*Call graph*: 9 external calls (new, Borrowed, Owned, new, new, format!, json!, new, from_value).


##### `write_connectors_config`  (lines 1657–1670)

```
fn write_connectors_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a test config file that points ChatGPT connector calls at a fake server and enables connectors.

**Data flow**: It receives a Codex home path and base URL, formats a config.toml string with that URL, file-based MCP OAuth credentials, and connectors enabled, then writes it to disk.

**Call relations**: Connector-related tests call this before starting TestAppServer so the app server talks to the fake apps server.

*Call graph*: called by 4 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_returns_apps_needing_auth, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed); 3 external calls (join, format!, write).


##### `write_plugins_enabled_config_with_base_url`  (lines 1672–1686)

```
fn write_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a test config file that enables plugins and points backend calls at a chosen base URL.

**Data flow**: It receives a Codex home path and backend base URL, formats a small config.toml, and writes it under the test home.

**Call relations**: plugin_install_rejects_when_workspace_codex_plugins_disabled calls this before mocking backend workspace settings.

*Call graph*: called by 1 (plugin_install_rejects_when_workspace_codex_plugins_disabled); 3 external calls (join, format!, write).


##### `write_analytics_config`  (lines 1688–1693)

```
fn write_analytics_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a config file that sends analytics traffic to a fake backend server.

**Data flow**: It receives a Codex home path and base URL, formats the chatgpt_base_url setting, and writes config.toml.

**Call relations**: plugin_install_tracks_analytics_event calls this before installing a plugin and waiting for the analytics request.

*Call graph*: called by 1 (plugin_install_tracks_analytics_event); 3 external calls (join, format!, write).


##### `mount_backend_analytics_events`  (lines 1695–1701)

```
async fn mount_backend_analytics_events(server: &MockServer)
```

**Purpose**: Configures a mock server to accept analytics event posts. This gives remote plugin tests a fake backend endpoint for usage reporting.

**Data flow**: It receives a MockServer and adds a POST route for the analytics-events path that returns a simple success JSON body.

**Call relations**: plugin_install_tracks_remote_plugin_analytics_event calls this so the installer’s analytics POST has somewhere valid to go.

*Call graph*: called by 1 (plugin_install_tracks_remote_plugin_analytics_event); 4 external calls (given, new, method, path).


##### `wait_for_plugin_analytics_payload`  (lines 1703–1724)

```
async fn wait_for_plugin_analytics_payload(server: &MockServer) -> Result<serde_json::Value>
```

**Purpose**: Waits until the mock server records a plugin analytics request, then returns its JSON body.

**Data flow**: It repeatedly reads recorded mock requests until it finds a POST whose path ends in the analytics-events endpoint. It parses that request body as JSON and returns it, or times out if no matching request appears.

**Call relations**: Both local and remote analytics tests call this after installation to inspect what the app server reported.

*Call graph*: called by 2 (plugin_install_tracks_analytics_event, plugin_install_tracks_remote_plugin_analytics_event); 5 external calls (from_millis, received_requests, from_slice, sleep, timeout).


##### `oauth_discovery_request_count`  (lines 1726–1734)

```
async fn oauth_discovery_request_count(server: &MockServer) -> usize
```

**Purpose**: Counts how many OAuth discovery requests reached a mock OAuth server. OAuth discovery is the first step where a client asks an authorization server how login should work.

**Data flow**: It reads the mock server’s recorded requests, filters paths containing oauth-authorization-server, and returns the count.

**Call relations**: OAuth-related install tests call this after installation to confirm whether MCP OAuth discovery was started or skipped.

*Call graph*: 1 external calls (received_requests).


##### `write_remote_plugin_catalog_config`  (lines 1736–1752)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config that enables both plugins and remote plugins and points backend calls at a fake catalog server.

**Data flow**: It receives a Codex home path and base URL, formats config.toml with chatgpt_base_url and feature flags, and writes it to disk.

**Call relations**: configure_remote_plugin_test wraps this with auth setup, while plugin_install_rejects_invalid_remote_plugin_name uses it directly for validation-only testing.

*Call graph*: called by 2 (configure_remote_plugin_test, plugin_install_rejects_invalid_remote_plugin_name); 3 external calls (join, format!, write).


##### `configure_remote_plugin_test`  (lines 1754–1764)

```
fn configure_remote_plugin_test(codex_home: &std::path::Path, server: &MockServer) -> Result<()>
```

**Purpose**: Prepares a test home for remote plugin installation using the mock backend and fake ChatGPT credentials.

**Data flow**: It writes remote plugin config using the mock server URL, then writes a ChatGPT auth fixture with token, user id, and account id.

**Call relations**: Many remote plugin tests call this before starting TestAppServer. It delegates config writing to write_remote_plugin_catalog_config and auth writing to shared test support.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); called by 7 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_invalid_remote_release_version, plugin_install_rejects_missing_remote_bundle_url, plugin_install_rejects_plain_http_remote_bundle_url, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_writes_remote_plugin_to_cloud_and_cache); 2 external calls (write_chatgpt_auth, format!).


##### `configure_remote_plugin_with_apps_test`  (lines 1766–1792)

```
fn configure_remote_plugin_with_apps_test(
    codex_home: &std::path::Path,
    server: &MockServer,
) -> Result<()>
```

**Purpose**: Prepares a test home for remote plugin installation with connector support enabled.

**Data flow**: It writes config enabling plugins, remote plugins, and connectors, pointing backend calls at the mock server. It then writes the fake ChatGPT auth credentials needed by mocked backend routes.

**Call relations**: Remote tests involving apps needing authorization call this before mounting plugin detail and install endpoints.

*Call graph*: calls 1 internal fn (new); called by 3 (plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_uses_remote_apps_needing_auth_response); 4 external calls (join, write_chatgpt_auth, format!, write).


##### `mount_remote_plugin_bundle`  (lines 1794–1809)

```
async fn mount_remote_plugin_bundle(
    server: &MockServer,
    status_code: u16,
    body: Vec<u8>,
) -> String
```

**Purpose**: Adds a fake downloadable remote plugin bundle endpoint to a mock server.

**Data flow**: It receives a status code and byte body, mounts GET /bundles/linear.tar.gz to return that body as gzip content, and returns the full URL for use in plugin detail responses.

**Call relations**: Remote plugin tests call this before mounting plugin detail data so the detail response can point at the fake bundle.

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

**Purpose**: Mounts a normal available remote plugin detail response. It is a convenience wrapper for the more configurable detail helper.

**Data flow**: It receives plugin id, release version, and optional bundle URL, then asks the status-aware helper to mount the response as available.

**Call relations**: Many remote plugin tests call this when they do not need custom availability status or app manifest fields.

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

**Purpose**: Mounts a remote plugin detail response that includes an app manifest. This lets tests check how bundled app metadata is written and used.

**Data flow**: It receives plugin id, version, optional bundle URL, and app manifest JSON, then delegates to the most general detail-mounting helper with available status.

**Call relations**: Remote tests for cached app manifests and apps-needing-auth behavior call this before sending the install request.

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

**Purpose**: Mounts a remote plugin detail response with a chosen availability status, such as available or disabled by admin.

**Data flow**: It receives plugin id, version, optional bundle URL, and status, then delegates to the general helper without an app manifest.

**Call relations**: mount_remote_plugin_detail uses this for the common available case, and the disabled-by-admin test calls it directly.

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

**Purpose**: Builds and mounts the full fake backend response for remote plugin details. This is the central helper for remote plugin metadata.

**Data flow**: It converts the availability enum into the backend status string, conditionally includes bundle URL and app manifest fields, formats the JSON body, and mounts an authenticated GET route with the includeDownloadUrls query parameter.

**Call relations**: The simpler remote detail helpers all delegate here. Remote install tests rely on the route it mounts when the app server looks up plugin metadata.

*Call graph*: called by 2 (mount_remote_plugin_detail_with_app_manifest, mount_remote_plugin_detail_with_status); 7 external calls (given, new, format!, header, method, path, query_param).


##### `mount_empty_remote_installed_plugins`  (lines 1914–1931)

```
async fn mount_empty_remote_installed_plugins(server: &MockServer)
```

**Purpose**: Mounts a fake backend response saying no remote plugins are currently installed.

**Data flow**: It adds an authenticated GET route for the installed-plugins endpoint with scope=GLOBAL and returns an empty plugin list plus pagination metadata.

**Call relations**: Most remote plugin tests call this during setup so the installer’s installed-plugin check succeeds with a known empty state.

*Call graph*: called by 10 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_invalid_remote_release_version, plugin_install_rejects_missing_remote_bundle_url, plugin_install_rejects_plain_http_remote_bundle_url, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_uses_remote_apps_needing_auth_response, plugin_install_writes_remote_plugin_to_cloud_and_cache); 6 external calls (given, new, header, method, path, query_param).


##### `mount_remote_plugin_install`  (lines 1933–1946)

```
async fn mount_remote_plugin_install(server: &MockServer, remote_plugin_id: &str)
```

**Purpose**: Mounts a simple successful backend install endpoint for a remote plugin.

**Data flow**: It receives a plugin id, configures an authenticated POST route for that plugin’s install path, and returns JSON saying the plugin is enabled.

**Call relations**: Remote analytics and download-failure tests call this. In the download-failure case, request-count checks prove this route was not reached.

*Call graph*: called by 2 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_tracks_remote_plugin_analytics_event); 6 external calls (given, new, format!, header, method, path).


##### `mount_remote_plugin_install_with_apps_needing_auth`  (lines 1948–1967)

```
async fn mount_remote_plugin_install_with_apps_needing_auth(
    server: &MockServer,
    remote_plugin_id: &str,
    app_ids_needing_auth: &[&str],
)
```

**Purpose**: Mounts a backend install endpoint that also reports which app ids still need user authorization.

**Data flow**: It receives a plugin id and list of app ids, configures an authenticated POST route that requires includeAppsNeedingAuth=true, and returns enabled status plus app_ids_needing_auth.

**Call relations**: Remote tests about apps needing auth and MCP OAuth call this before sending a remote install request.

*Call graph*: called by 3 (plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_uses_remote_apps_needing_auth_response); 8 external calls (given, new, format!, json!, header, method, path, query_param).


##### `CacheManifestExists::matches`  (lines 1975–1977)

```
fn matches(&self, _request: &Request) -> bool
```

**Purpose**: Acts as a custom mock-server condition that only matches once a local cache manifest file exists.

**Data flow**: It ignores the HTTP request details and checks whether the configured manifest path is a file. It returns true only after the installer has written that file.

**Call relations**: mount_remote_plugin_install_after_cache_write uses this matcher so the fake backend install endpoint responds only after the plugin cache write has happened.

*Call graph*: 1 external calls (is_file).


##### `mount_remote_plugin_install_after_cache_write`  (lines 1980–1998)

```
async fn mount_remote_plugin_install_after_cache_write(
    server: &MockServer,
    remote_plugin_id: &str,
    manifest_path: std::path::PathBuf,
)
```

**Purpose**: Mounts a backend install endpoint that only accepts the request after the downloaded plugin manifest exists in the local cache.

**Data flow**: It receives the plugin id and expected manifest path, configures an authenticated POST route, and attaches CacheManifestExists as an extra condition before returning success.

**Call relations**: plugin_install_writes_remote_plugin_to_cloud_and_cache calls this to verify the installer writes local cache files before notifying the backend install endpoint.

*Call graph*: called by 1 (plugin_install_writes_remote_plugin_to_cloud_and_cache); 6 external calls (given, new, format!, header, method, path).


##### `send_remote_plugin_install_request`  (lines 2000–2010)

```
async fn send_remote_plugin_install_request(
    mcp: &mut TestAppServer,
    remote_plugin_id: &str,
) -> Result<i64>
```

**Purpose**: Sends a remote plugin install request using the standard remote marketplace name shape used by these tests.

**Data flow**: It receives the running test app server and remote plugin id, builds PluginInstallParams with no local marketplace path, a placeholder remote marketplace name, and the plugin id, then returns the JSON-RPC request id.

**Call relations**: Many remote plugin tests call this to avoid repeating request construction. It hands off to TestAppServer::send_plugin_install_request.

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

**Purpose**: Waits until the mock backend has seen exactly a chosen number of requests for a given method and path suffix.

**Data flow**: It repeatedly reads recorded mock requests, counts matching method and path entries, succeeds when the count equals the expected number, fails if the count goes too high, and times out if it never reaches the target.

**Call relations**: Remote plugin tests call this after install attempts to prove downloads, backend installs, or connector fetches happened—or did not happen—the expected number of times.

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

**Purpose**: Writes a local plugin marketplace file for tests. A marketplace is the catalog that tells the installer which plugins exist and where their source lives.

**Data flow**: It receives repo path, marketplace name, plugin name, source path, and optional policy values. It creates the fake repo and marketplace directories, formats marketplace.json, and writes it to disk.

**Call relations**: Most local plugin tests call this before installing. Tests that need custom JSON outside its supported options write their own marketplace instead.

*Call graph*: called by 9 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_makes_bundled_mcp_servers_available_to_followup_requests, plugin_install_rejects_when_workspace_codex_plugins_disabled, plugin_install_returns_apps_needing_auth, plugin_install_returns_invalid_request_for_not_available_plugin, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed, plugin_install_tracks_analytics_event); 5 external calls (join, new, format!, create_dir_all, write).


##### `write_plugin_source`  (lines 2091–2112)

```
fn write_plugin_source(
    repo_root: &std::path::Path,
    plugin_name: &str,
    app_ids: &[&str],
) -> Result<()>
```

**Purpose**: Writes the minimum local plugin files needed by the installer: a plugin manifest and an app manifest.

**Data flow**: It creates the plugin directory and .codex-plugin folder, writes plugin.json with the plugin name, builds .app.json from the supplied app ids, and writes the pretty JSON to disk.

**Call relations**: Local plugin tests call this after write_plugin_marketplace so the marketplace entry points at real plugin files.

*Call graph*: called by 10 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_makes_bundled_mcp_servers_available_to_followup_requests, plugin_install_rejects_when_workspace_codex_plugins_disabled, plugin_install_returns_apps_needing_auth, plugin_install_returns_invalid_request_for_disallowed_product_plugin, plugin_install_returns_invalid_request_for_not_available_plugin, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed, plugin_install_tracks_analytics_event); 6 external calls (join, format!, json!, to_vec_pretty, create_dir_all, write).


##### `write_plugin_mcp_config`  (lines 2114–2133)

```
fn write_plugin_mcp_config(
    repo_root: &std::path::Path,
    plugin_name: &str,
    mcp_base_url: &str,
) -> Result<()>
```

**Purpose**: Writes a plugin’s MCP server configuration file for tests. MCP is the Model Context Protocol, a way for the app to talk to external tool servers.

**Data flow**: It receives repo path, plugin name, and an MCP base URL, then writes .mcp.json containing one HTTP MCP server named sample-mcp.

**Call relations**: OAuth-related local plugin tests call this so installation can discover or skip OAuth setup for bundled MCP servers.

*Call graph*: called by 3 (plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed); 3 external calls (join, format!, write).


##### `remote_plugin_bundle_tar_gz_bytes`  (lines 2135–2138)

```
fn remote_plugin_bundle_tar_gz_bytes(plugin_name: &str) -> Result<Vec<u8>>
```

**Purpose**: Creates a simple compressed remote plugin bundle containing a plugin manifest and default skill file.

**Data flow**: It receives a plugin name, formats a small plugin manifest JSON string, and delegates to the content-based bundle helper. The result is tar.gz bytes suitable for the fake bundle endpoint.

**Call relations**: Remote tests call this for the common bundle shape. It delegates to remote_plugin_bundle_tar_gz_bytes_with_contents.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_contents); called by 3 (plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_uses_remote_apps_needing_auth_response); 1 external calls (format!).


##### `remote_plugin_bundle_tar_gz_bytes_with_mcp_config`  (lines 2140–2160)

```
fn remote_plugin_bundle_tar_gz_bytes_with_mcp_config(
    plugin_name: &str,
    mcp_base_url: &str,
) -> Result<Vec<u8>>
```

**Purpose**: Creates a compressed remote plugin bundle that includes MCP server configuration.

**Data flow**: It receives a plugin name and MCP base URL, formats plugin.json and .mcp.json contents, and asks the entry-level bundle builder to package them.

**Call relations**: plugin_install_starts_remote_mcp_oauth_for_install_response_only_app calls this to make a remote plugin whose install should trigger MCP OAuth discovery.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_entries); called by 1 (plugin_install_starts_remote_mcp_oauth_for_install_response_only_app); 1 external calls (format!).


##### `remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config`  (lines 2162–2183)

```
fn remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config(
    plugin_name: &str,
    app_manifest: &str,
    mcp_base_url: &str,
) -> Result<Vec<u8>>
```

**Purpose**: Creates a compressed remote plugin bundle containing both an app manifest and MCP server configuration.

**Data flow**: It receives plugin name, app manifest JSON text, and MCP base URL, formats the plugin and MCP config, and delegates to the entry-level bundle builder.

**Call relations**: plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app calls this to test how bundled app metadata affects OAuth decisions.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_entries); called by 1 (plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app); 1 external calls (format!).


##### `remote_plugin_bundle_tar_gz_bytes_with_contents`  (lines 2185–2194)

```
fn remote_plugin_bundle_tar_gz_bytes_with_contents(
    plugin_manifest: &str,
    app_manifest: Option<&str>,
) -> Result<Vec<u8>>
```

**Purpose**: Creates a compressed remote plugin bundle from explicit plugin manifest text and an optional app manifest.

**Data flow**: It passes the given plugin manifest and optional app manifest to the entry-level bundle builder without an MCP config. The output is tar.gz bytes.

**Call relations**: plugin_install_writes_remote_plugin_to_cloud_and_cache uses this for custom manifest contents, and remote_plugin_bundle_tar_gz_bytes uses it for the simple case.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_entries); called by 2 (plugin_install_writes_remote_plugin_to_cloud_and_cache, remote_plugin_bundle_tar_gz_bytes).


##### `remote_plugin_bundle_tar_gz_bytes_with_entries`  (lines 2196–2230)

```
fn remote_plugin_bundle_tar_gz_bytes_with_entries(
    plugin_manifest: &str,
    app_manifest: Option<&str>,
    mcp_config: Option<&str>,
) -> Result<Vec<u8>>
```

**Purpose**: Builds the actual tar.gz archive bytes used as fake remote plugin downloads. Think of it as packing a tiny test plugin into a zip-like box.

**Data flow**: It starts a gzip encoder and tar archive, always adds plugin.json and a skill file, optionally adds .app.json and .mcp.json, writes each entry with file mode metadata, then finishes and returns the compressed bytes.

**Call relations**: All remote bundle helper variants delegate here. Mock bundle endpoints serve the bytes it produces to the app server during remote install tests.

*Call graph*: called by 3 (remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config, remote_plugin_bundle_tar_gz_bytes_with_contents, remote_plugin_bundle_tar_gz_bytes_with_mcp_config); 6 external calls (new, new, default, new, new_gnu, vec!).


### `app-server/tests/suite/v2/plugin_share.rs`

`test` · `test execution`

Plugin sharing touches many moving parts: local files, user authentication, app configuration, remote HTTP APIs, and JSON-RPC requests, which are structured messages sent to the app server. This test file acts like a careful rehearsal for all of those parts. It creates temporary folders, writes small fake plugins, starts a mock remote server, and then talks to a real test instance of the app server through plugin/share methods.

The tests check the happy paths and the guardrails. For example, they verify that saving a plugin asks the backend for an upload URL, uploads a compressed plugin bundle, then creates a workspace plugin share. They also check that unsupported settings are rejected before any network call is made. Checkout tests confirm that a remote shared plugin can be downloaded into the user's local plugin folder and added to a personal marketplace file, while failures clean up partial work. Other tests cover listing shared plugins, updating who can access them, and deleting a share.

The helper functions are the test workshop: they write config files, build tiny plugin bundles, create expected JSON payloads, and register mock HTTP responses. Without this file, changes to plugin sharing could silently break real users' ability to share, install, or control access to plugins.

#### Function details

##### `plugin_share_save_uploads_local_plugin`  (lines 53–191)

```
async fn plugin_share_save_uploads_local_plugin() -> Result<()>
```

**Purpose**: Tests the full path for sharing a local plugin for the first time. It proves that the app server uploads the plugin, creates the remote share, and later remembers which local folder belongs to that remote plugin.

**Data flow**: It starts with temporary app and plugin folders, a tiny test plugin, fake auth credentials, and mocked backend responses. It sends plugin/share/save with the local plugin path, reads back the returned remote plugin id and share URL, then asks plugin/share/list and checks that the shared plugin appears with the expected local path. It also begins with a corrupt local-path mapping file to make sure bad old cache data does not break the save flow.

**Call relations**: The async test runner invokes this test. Inside, it uses helpers such as write_test_plugin, write_remote_plugin_config, and write_corrupt_plugin_share_local_path_mapping to prepare the world, then uses the mock server and TestAppServer to exercise the real request flow.

*Call graph*: calls 6 internal fn (new, new, write_corrupt_plugin_share_local_path_mapping, write_remote_plugin_config, write_test_plugin, try_from); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_share_save_forwards_access_policy`  (lines 194–289)

```
async fn plugin_share_save_forwards_access_policy() -> Result<()>
```

**Purpose**: Checks that access settings chosen by the client are sent correctly when creating a new plugin share. In plain terms, it verifies that the server passes along who may access the plugin and whether it is reachable by link.

**Data flow**: It creates a local plugin, configures auth and a fake backend, then sends plugin/share/save with UNLISTED discoverability and one user share target. The mocked backend expects a request body that includes that user plus an added workspace reader target, and the test succeeds only if the app server sends exactly that shape. The response is converted into a PluginShareSaveResponse and compared with the expected remote id and share URL.

**Call relations**: The test runner calls this function during the suite. It relies on write_remote_plugin_config and write_test_plugin for setup, then hands the actual behavior to TestAppServer and verifies the HTTP request with wiremock.

*Call graph*: calls 5 internal fn (new, new, write_remote_plugin_config, write_test_plugin, try_from); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `plugin_share_save_rejects_listed_discoverability`  (lines 292–331)

```
async fn plugin_share_save_rejects_listed_discoverability() -> Result<()>
```

**Purpose**: Makes sure clients cannot create a shared plugin with LISTED discoverability through this endpoint. LISTED would mean broadly visible, and this endpoint only allows private or unlisted sharing.

**Data flow**: It prepares a plugin and app server, then sends plugin/share/save with discoverability set to LISTED. Instead of making an upload, the server returns a JSON-RPC error with code -32600 and a message explaining that only UNLISTED or PRIVATE are supported.

**Call relations**: The test runner invokes it. It uses the same setup helpers as the save tests, but the important handoff is to TestAppServer, which should reject the request before any mocked upload behavior is needed.

*Call graph*: calls 4 internal fn (new, new, write_remote_plugin_config, write_test_plugin); 8 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, timeout).


##### `plugin_share_save_rejects_when_plugin_sharing_disabled`  (lines 334–389)

```
async fn plugin_share_save_rejects_when_plugin_sharing_disabled() -> Result<()>
```

**Purpose**: Verifies that plugin sharing cannot be used when the feature flag is turned off in config. This protects deployments or users where the feature should not be active.

**Data flow**: It writes a config file where plugins and remote plugins are enabled but plugin_sharing is false. It sends plugin/share/save and expects a JSON-RPC error saying plugin sharing is disabled. It then checks that the fake backend received no requests, proving the app server stopped locally.

**Call relations**: The test runner calls this test. It prepares a plugin with write_test_plugin but deliberately writes custom config instead of using the normal helper, then checks TestAppServer's rejection and the mock server's empty request log.

*Call graph*: calls 3 internal fn (new, new, write_test_plugin); 10 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, write, timeout).


##### `plugin_share_rejects_workspace_targets_from_client`  (lines 392–467)

```
async fn plugin_share_rejects_workspace_targets_from_client() -> Result<()>
```

**Purpose**: Checks that clients are not allowed to directly name workspace principals in shareTargets. The app server wants workspace-wide link access to be expressed through UNLISTED discoverability instead.

**Data flow**: It prepares a normal sharing setup, then sends plugin/share/save with a workspace target and expects an error. It then sends plugin/share/updateTargets with the same kind of workspace target and expects the same error. No successful share settings are returned.

**Call relations**: The test runner runs this as a validation test. It uses write_remote_plugin_config and write_test_plugin for setup, then asks TestAppServer to reject both the create-share and update-targets paths consistently.

*Call graph*: calls 4 internal fn (new, new, write_remote_plugin_config, write_test_plugin); 8 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, timeout).


##### `plugin_share_save_rejects_access_policy_for_existing_plugin`  (lines 470–517)

```
async fn plugin_share_save_rejects_access_policy_for_existing_plugin() -> Result<()>
```

**Purpose**: Ensures access settings are only accepted when creating a new share, not when saving changes to an already existing remote plugin. This keeps the save endpoint from silently changing sharing rules in the wrong place.

**Data flow**: It sends plugin/share/save with a plugin path, an existing remotePluginId, and access policy fields. The server returns an invalid-request JSON-RPC error explaining that discoverability and shareTargets must be changed through plugin/share/updateTargets instead.

**Call relations**: The test runner invokes it. Setup is shared with the other save tests through write_remote_plugin_config and write_test_plugin, while TestAppServer performs the validation being checked.

*Call graph*: calls 4 internal fn (new, new, write_remote_plugin_config, write_test_plugin); 8 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, timeout).


##### `plugin_share_list_returns_created_workspace_plugins`  (lines 520–595)

```
async fn plugin_share_list_returns_created_workspace_plugins() -> Result<()>
```

**Purpose**: Tests that plugin/share/list returns workspace plugins created by the user and marks whether they are installed. This is the list a client would show when displaying shared plugins.

**Data flow**: It configures auth and a fake backend with two responses: one for workspace-created plugins and one for installed workspace plugins. It sends plugin/share/list, converts the JSON-RPC response, and compares the returned PluginShareListResponse with the expected plugin summary and share details.

**Call relations**: The test runner calls this function. It uses remote_plugin_json, installed_remote_plugin_json, empty_pagination_json, expected_plugin_interface, and expected_share_context indirectly through the expected mock responses and assertions.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_config); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `plugin_share_checkout_adds_personal_marketplace_entry`  (lines 598–763)

```
async fn plugin_share_checkout_adds_personal_marketplace_entry() -> Result<()>
```

**Purpose**: Tests that checking out a shared plugin downloads it locally and adds it to the user's personal marketplace file. This is what lets a shared remote plugin become a usable local plugin entry.

**Data flow**: It creates temporary app and home folders, serves a fake remote plugin bundle, and starts the app server with environment variables pointing HOME to the temp folder. It sends plugin/share/checkout, then checks the returned paths, the extracted plugin files, the generated marketplace.json entry, and the remote-to-local path mapping. It also lists local marketplace plugins to confirm the share context is attached, then repeats checkout to prove local edits are preserved.

**Call relations**: The test runner invokes it. The setup depends on mount_remote_plugin_bundle, mount_remote_plugin_detail_with_bundle, mount_empty_remote_installed_plugins, remote_plugin_bundle_tar_gz_bytes, and write_remote_plugin_config before TestAppServer performs the checkout flow.

*Call graph*: calls 8 internal fn (new, new_with_env, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_bundle, remote_plugin_bundle_tar_gz_bytes, write_remote_plugin_config, try_from); 14 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, json!, from_str (+4 more)).


##### `plugin_share_checkout_rejects_non_share_remote_plugin`  (lines 766–827)

```
async fn plugin_share_checkout_rejects_non_share_remote_plugin() -> Result<()>
```

**Purpose**: Checks that checkout refuses remote plugins that are not workspace-shared plugins. This prevents the share checkout path from being used for global marketplace plugins.

**Data flow**: It mocks a remote plugin whose scope is GLOBAL, then sends plugin/share/checkout for that id. The app server returns an invalid-request error saying the plugin is not available for checkout, and the test confirms no local plugin folder was created.

**Call relations**: The test runner runs this negative checkout case. It uses mount_remote_plugin_detail_with_bundle and mount_empty_remote_installed_plugins to make the remote plugin look real, then relies on TestAppServer to reject it based on scope.

*Call graph*: calls 5 internal fn (new, new_with_env, mount_empty_remote_installed_plugins, mount_remote_plugin_detail_with_bundle, write_remote_plugin_config); 9 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, timeout).


##### `plugin_share_checkout_cleans_up_path_when_marketplace_update_fails`  (lines 830–924)

```
async fn plugin_share_checkout_cleans_up_path_when_marketplace_update_fails() -> Result<()>
```

**Purpose**: Verifies that checkout cleans up downloaded files if it cannot safely update the personal marketplace. This avoids leaving half-installed plugins on disk.

**Data flow**: It first writes a marketplace file that already contains a plugin with the same name but a different path. It then mocks a valid shared plugin and sends plugin/share/checkout. The app server errors because adding another entry would conflict, and the test checks that the newly downloaded plugin folder and path-mapping file were removed.

**Call relations**: The test runner invokes it. It uses bundle and remote-detail helpers to prepare a realistic download, but the key story is that TestAppServer begins checkout, hits a marketplace conflict, and must clean up the work it started.

*Call graph*: calls 7 internal fn (new, new_with_env, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_bundle, remote_plugin_bundle_tar_gz_bytes, write_remote_plugin_config); 12 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, to_string_pretty, create_dir_all (+2 more)).


##### `plugin_share_update_targets_updates_share_targets`  (lines 927–1039)

```
async fn plugin_share_update_targets_updates_share_targets() -> Result<()>
```

**Purpose**: Tests that plugin/share/updateTargets sends updated sharing rules to the backend and returns the backend's resulting access list. This covers the path for changing who can read or edit a shared plugin.

**Data flow**: It sets up a fake backend expecting a PUT request with UNLISTED discoverability and a target list. The app server sends that request, the backend replies with owner, editor, and workspace reader principals, and the test checks that the JSON-RPC response contains those principals in protocol types.

**Call relations**: The test runner calls this function. It uses write_remote_plugin_config for setup and wiremock to verify the outgoing backend request, while TestAppServer turns the client request into the remote API call.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_config); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `plugin_share_update_targets_rejects_when_plugin_sharing_disabled`  (lines 1042–1090)

```
async fn plugin_share_update_targets_rejects_when_plugin_sharing_disabled() -> Result<()>
```

**Purpose**: Confirms that updating share targets is blocked when the plugin sharing feature flag is off. This mirrors the save endpoint's feature-gate behavior.

**Data flow**: It writes config with plugin_sharing set to false, starts the app server, and sends plugin/share/updateTargets. The server returns a JSON-RPC invalid-request error saying plugin sharing is disabled.

**Call relations**: The test runner invokes it. Unlike the successful update-targets test, it does not need backend mocks because TestAppServer should reject the request before any remote call.

*Call graph*: calls 2 internal fn (new, new); 9 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, write, timeout).


##### `plugin_share_delete_removes_created_workspace_plugin`  (lines 1093–1196)

```
async fn plugin_share_delete_removes_created_workspace_plugin() -> Result<()>
```

**Purpose**: Tests deletion of a shared workspace plugin and the local bookkeeping that connects a remote plugin id to a local path. After delete, the remote plugin may still be listed, but the local path mapping should be gone.

**Data flow**: It writes a local path mapping for a remote plugin, mocks a successful backend DELETE, and sends plugin/share/delete. After getting an empty success response, it asks plugin/share/list and verifies that the plugin is returned without a local_plugin_path. This proves the mapping was removed.

**Call relations**: The test runner calls it. It uses write_plugin_share_local_path_mapping to create preexisting local state, wiremock to confirm the backend delete call, and the list helpers to verify the post-delete state.

*Call graph*: calls 5 internal fn (new, new, write_plugin_share_local_path_mapping, write_remote_plugin_config, try_from); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `write_remote_plugin_config`  (lines 1198–1211)

```
fn write_remote_plugin_config(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a small config file that points the app server at the mock backend and enables plugin and remote-plugin features. Tests use it so they do not have to repeat the same configuration text.

**Data flow**: It receives a Codex home directory and a base URL. It writes config.toml under that directory with chatgpt_base_url set to the given URL and the needed feature flags enabled. Its result is a standard file-writing success or error.

**Call relations**: Many tests call this during setup before starting TestAppServer. It does not call other project helpers; it simply formats the config and writes it to disk.

*Call graph*: called by 11 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails, plugin_share_checkout_rejects_non_share_remote_plugin, plugin_share_delete_removes_created_workspace_plugin, plugin_share_list_returns_created_workspace_plugins, plugin_share_rejects_workspace_targets_from_client, plugin_share_save_forwards_access_policy, plugin_share_save_rejects_access_policy_for_existing_plugin, plugin_share_save_rejects_listed_discoverability, plugin_share_save_uploads_local_plugin (+1 more)); 3 external calls (join, format!, write).


##### `mount_remote_plugin_bundle`  (lines 1213–1230)

```
async fn mount_remote_plugin_bundle(
    server: &MockServer,
    plugin_name: &str,
    body: Vec<u8>,
) -> String
```

**Purpose**: Registers a fake downloadable plugin bundle on the mock HTTP server. Checkout tests use it to simulate downloading a compressed plugin package from the remote service.

**Data flow**: It receives the mock server, a plugin name, and the compressed bundle bytes. It mounts a GET route like /bundles/name.tar.gz that returns those bytes as gzip content, then returns the full URL that the app server should download.

**Call relations**: The checkout success and cleanup tests call this before mocking plugin details. Its returned URL is passed into mount_remote_plugin_detail_with_bundle so the app server sees a realistic download link.

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

**Purpose**: Registers a fake remote plugin detail response, including metadata and a bundle download URL. This gives checkout tests the remote information they need without contacting a real service.

**Data flow**: It receives the mock server, remote plugin id, plugin name, bundle URL, and scope such as WORKSPACE or GLOBAL. It mounts a backend GET route that requires auth headers and returns JSON describing the plugin, its release, its interface, and its sharing information. It changes the mock server's behavior but returns no value.

**Call relations**: Checkout tests call this after deciding what kind of remote plugin they want to simulate. TestAppServer later requests this route during plugin/share/checkout.

*Call graph*: called by 3 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails, plugin_share_checkout_rejects_non_share_remote_plugin); 8 external calls (given, new, format!, json!, header, method, path, query_param).


##### `mount_empty_remote_installed_plugins`  (lines 1276–1290)

```
async fn mount_empty_remote_installed_plugins(server: &MockServer, scope: &str)
```

**Purpose**: Registers a fake backend response saying no remote plugins are currently installed for a given scope. Checkout tests use this to keep the remote installed-plugin state simple.

**Data flow**: It receives the mock server and a scope string. It mounts a GET route for installed plugins with that scope and returns an empty plugins list plus an empty pagination marker. The effect is only on the mock server.

**Call relations**: The checkout tests call it before starting TestAppServer. During checkout, the app server can query installed plugins and receive a predictable empty answer.

*Call graph*: called by 3 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails, plugin_share_checkout_rejects_non_share_remote_plugin); 7 external calls (given, new, json!, header, method, path, query_param).


##### `remote_plugin_json`  (lines 1292–1326)

```
fn remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Builds the standard fake JSON object for a shared workspace plugin. Tests use it as the backend's response when listing created shared plugins.

**Data flow**: It receives a plugin id. It returns a JSON value containing the plugin name, workspace scope, private discoverability, share URL, principals, policies, release version, and interface details.

**Call relations**: installed_remote_plugin_json calls this and then adds installed-specific fields. List and delete tests also use the JSON it creates in mocked backend responses.

*Call graph*: called by 1 (installed_remote_plugin_json); 1 external calls (json!).


##### `installed_remote_plugin_json`  (lines 1328–1336)

```
fn installed_remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Builds a fake JSON object for a remote plugin that is already installed. It starts from the normal remote plugin shape and adds installed-state fields.

**Data flow**: It receives a plugin id, calls remote_plugin_json to get the base object, then inserts enabled: true and an empty disabled_skill_names list. It returns the updated JSON value.

**Call relations**: List-related tests use this when mocking the backend's installed-plugins endpoint. It depends on remote_plugin_json so the created and installed representations stay consistent.

*Call graph*: calls 1 internal fn (remote_plugin_json); 2 external calls (json!, unreachable!).


##### `empty_pagination_json`  (lines 1338–1342)

```
fn empty_pagination_json() -> serde_json::Value
```

**Purpose**: Creates the small JSON pagination object used when a fake backend response has no next page. It keeps repeated mock responses tidy.

**Data flow**: It takes no input. It returns JSON with next_page_token set to null, meaning there are no more results to fetch.

**Call relations**: Tests use it inside mocked list responses for created and installed plugins. It is a simple shared building block for predictable backend JSON.

*Call graph*: 1 external calls (json!).


##### `expected_plugin_interface`  (lines 1344–1364)

```
fn expected_plugin_interface() -> PluginInterface
```

**Purpose**: Builds the expected PluginInterface value for the fake demo plugin. Assertions use it to compare the app server's parsed plugin metadata against known data.

**Data flow**: It takes no input. It returns a PluginInterface with display name, short description, and capabilities filled in, while optional fields not used by the test are left empty.

**Call relations**: List-related assertions call this when constructing the expected PluginSummary. It mirrors the interface JSON returned by remote_plugin_json.

*Call graph*: 2 external calls (new, vec!).


##### `expected_share_context`  (lines 1366–1389)

```
fn expected_share_context(plugin_id: &str) -> PluginShareContext
```

**Purpose**: Builds the expected sharing details for a fake remote plugin. This includes its remote id, version, share URL, privacy setting, and listed principals.

**Data flow**: It receives a plugin id and returns a PluginShareContext. The context contains the same owner and reader principals that remote_plugin_json puts into backend responses.

**Call relations**: List assertions call this to check that TestAppServer converted backend share JSON into the protocol's share-context type correctly.

*Call graph*: 1 external calls (vec!).


##### `write_test_plugin`  (lines 1391–1402)

```
fn write_test_plugin(root: &Path, plugin_name: &str) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a tiny local plugin folder on disk for tests that need a real plugin path. It writes just enough files for the app server to recognize and package the plugin.

**Data flow**: It receives a root directory and plugin name. It creates a plugin directory with .codex-plugin/plugin.json and a sample skill Markdown file, then returns the path to the plugin directory or a file error.

**Call relations**: All save-related tests call this during setup. It delegates actual file creation to write_file so nested directories are created safely.

*Call graph*: calls 1 internal fn (write_file); called by 6 (plugin_share_rejects_workspace_targets_from_client, plugin_share_save_forwards_access_policy, plugin_share_save_rejects_access_policy_for_existing_plugin, plugin_share_save_rejects_listed_discoverability, plugin_share_save_rejects_when_plugin_sharing_disabled, plugin_share_save_uploads_local_plugin); 2 external calls (join, format!).


##### `remote_plugin_bundle_tar_gz_bytes`  (lines 1404–1428)

```
fn remote_plugin_bundle_tar_gz_bytes(plugin_name: &str) -> Result<Vec<u8>>
```

**Purpose**: Creates an in-memory compressed tar bundle for a fake plugin. A tar bundle is like a folder packed into one file, and gzip compresses it to make it smaller.

**Data flow**: It receives a plugin name, creates a manifest and skill file in a tar archive, compresses that archive with gzip, and returns the resulting bytes. If archive creation fails, it returns an error.

**Call relations**: Checkout tests call this before mount_remote_plugin_bundle. The bytes it returns become the fake remote download that TestAppServer extracts during checkout.

*Call graph*: called by 2 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails); 6 external calls (new, new, default, format!, new, new_gnu).


##### `write_corrupt_plugin_share_local_path_mapping`  (lines 1430–1435)

```
fn write_corrupt_plugin_share_local_path_mapping(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Writes deliberately invalid local-path mapping data. A test uses this to prove the app server can tolerate a bad cache file instead of crashing.

**Data flow**: It receives a Codex home directory and writes the text not-json to .tmp/plugin-share-local-paths-v1.json under that directory. It returns the normal file-writing result.

**Call relations**: plugin_share_save_uploads_local_plugin calls this before saving a plugin. It uses write_file to create the parent directory and file.

*Call graph*: calls 1 internal fn (write_file); called by 1 (plugin_share_save_uploads_local_plugin); 1 external calls (join).


##### `write_plugin_share_local_path_mapping`  (lines 1437–1455)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
) -> std::io::Result<()>
```

**Purpose**: Writes a valid mapping from a remote plugin id to a local plugin path. Tests use it to simulate existing local bookkeeping before delete or list behavior.

**Data flow**: It receives a Codex home directory, a remote plugin id, and an absolute plugin path. It serializes those into pretty JSON under .tmp/plugin-share-local-paths-v1.json and writes the file. It returns success or an I/O-style error.

**Call relations**: plugin_share_delete_removes_created_workspace_plugin calls this during setup. It uses write_file for the final disk write and JSON conversion helpers to build the stored mapping.

*Call graph*: calls 1 internal fn (write_file); called by 1 (plugin_share_delete_removes_created_workspace_plugin); 6 external calls (join, format!, json!, new, to_string_pretty, to_value).


##### `write_file`  (lines 1457–1466)

```
fn write_file(path: &Path, contents: &str) -> std::io::Result<()>
```

**Purpose**: Small helper that writes a file after making sure its parent directory exists. This keeps test setup code short and avoids repeated directory-creation boilerplate.

**Data flow**: It receives a path and text contents. It checks that the path has a parent directory, creates that directory tree if needed, then writes the contents to the file. It returns success or a file error.

**Call relations**: write_test_plugin, write_corrupt_plugin_share_local_path_mapping, and write_plugin_share_local_path_mapping call this whenever they need to place test files on disk.

*Call graph*: called by 3 (write_corrupt_plugin_share_local_path_mapping, write_plugin_share_local_path_mapping, write_test_plugin); 5 external calls (parent, other, format!, create_dir_all, write).


### `app-server/tests/suite/v2/plugin_uninstall.rs`

`test` · `test run`

This test file is like a checklist for the plugin uninstall button. When a user removes a plugin, the app must clean up the local plugin files, remove any saved configuration, tell the remote service when the plugin came from the cloud, and avoid unsafe or invalid requests. Without these tests, a broken uninstall flow could leave stale plugin code on disk, keep old config entries enabled, send the wrong cloud request, or accept plugin IDs that could accidentally point outside the intended plugin area.

The tests create a temporary Codex home folder, write fake plugin files and config into it, then start a test app server. They send a JSON-RPC request, which is a structured message asking the server to do something, and then wait for either a success response or an error response.

For remote plugins, the file uses a mock web server. A mock server is a fake service that records requests and returns prepared answers, like a practice receptionist for network calls. The tests use it to confirm that the app fetches plugin details before uninstalling, sends the uninstall request with the right authentication headers, deletes the correct cache folder, and does not make network calls when the plugin ID is invalid. Helper functions at the bottom build the fake files, fake configuration, fake remote plugin details, and wait until the expected mock-server request count is reached.

#### Function details

##### `plugin_uninstall_removes_plugin_cache_and_config_entry`  (lines 32–80)

```
async fn plugin_uninstall_removes_plugin_cache_and_config_entry() -> Result<()>
```

**Purpose**: This test proves that uninstalling a local plugin removes both its cached files and its entry in the config file. It also checks that running uninstall a second time is harmless, which makes the operation safe to retry.

**Data flow**: It starts with a temporary Codex home folder containing a fake installed plugin and a config entry marking that plugin as enabled. It starts the test app server, sends an uninstall request for that plugin ID, reads the server response, and checks that the response is empty success. Afterward, it looks at the file system and config text to confirm the plugin folder is gone and the config block was removed. It then sends the same uninstall request again and expects another success instead of a failure.

**Call relations**: This test calls write_installed_plugin to set up the fake plugin files, then uses the test server to exercise the real uninstall path. It relies on response-conversion helpers to read the server's JSON-RPC answer and uses assertions to verify the before-and-after state.

*Call graph*: calls 2 internal fn (new, write_installed_plugin); 8 external calls (new, Integer, to_response, assert!, assert_eq!, read_to_string, write, timeout).


##### `plugin_uninstall_tracks_analytics_event`  (lines 83–153)

```
async fn plugin_uninstall_tracks_analytics_event() -> Result<()>
```

**Purpose**: This test checks that a successful local plugin uninstall sends an analytics event. That matters because product telemetry depends on knowing when users remove plugins and what kind of plugin was removed.

**Data flow**: It creates a fake analytics server, a temporary Codex home, an installed plugin, config pointing analytics traffic at the fake server, and ChatGPT authentication data. It starts the app server, sends an uninstall request, and confirms the normal success response. Then it repeatedly checks the fake analytics server until it sees the expected POST request, reads the JSON body, and compares it to the exact event data expected for the removed plugin.

**Call relations**: This test uses write_installed_plugin for local plugin setup and external support helpers for analytics and authentication setup. After the app server completes the uninstall, the test watches the mock analytics endpoint to confirm the uninstall flow handed off the right event.

*Call graph*: calls 3 internal fn (new, new, write_installed_plugin); 12 external calls (from_millis, new, Integer, start_analytics_events_server, to_response, write_chatgpt_auth, assert_eq!, format!, from_slice, write (+2 more)).


##### `plugin_uninstall_rejects_remote_plugin_when_plugins_are_disabled`  (lines 156–186)

```
async fn plugin_uninstall_rejects_remote_plugin_when_plugins_are_disabled() -> Result<()>
```

**Purpose**: This test verifies that remote plugin uninstall is blocked when plugin support is turned off in the config. It protects users and the server from performing cloud plugin actions when the feature is disabled.

**Data flow**: It writes a config file where plugins are disabled, starts the test app server, and sends an uninstall request using a remote-style plugin ID. Instead of a success response, it waits for an error response. It then checks that the error uses the invalid-request code and says remote plugin uninstall is not enabled.

**Call relations**: This test drives the app server directly and does not set up remote network mocks because the request should be rejected before any remote work begins. Its assertions document the expected gatekeeping behavior.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, write, timeout).


##### `plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled`  (lines 189–259)

```
async fn plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: This test proves that uninstalling a remote plugin contacts the remote plugin service and then removes local cached copies. It covers the normal cloud uninstall path for a globally scoped remote plugin.

**Data flow**: It creates a temporary Codex home, starts a fake backend server, writes config enabling plugins and remote plugins, and writes ChatGPT credentials. It mounts a fake plugin-detail response and a fake uninstall response on the mock server. It also creates both the current cache folder and an older legacy cache folder for the same remote plugin. After sending the uninstall request, it checks for a success response, confirms exactly one uninstall POST was sent to the backend, and verifies both cache folders were deleted.

**Call relations**: This test uses write_remote_plugin_catalog_config to point the app at the mock backend, mount_remote_plugin_detail to provide the detail lookup response, and wait_for_remote_plugin_request_count to prove the uninstall request happened once. It exercises the full remote uninstall flow through the test app server.

*Call graph*: calls 5 internal fn (new, new, mount_remote_plugin_detail, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+6 more)).


##### `plugin_uninstall_uses_detail_scope_for_cache_namespace`  (lines 262–331)

```
async fn plugin_uninstall_uses_detail_scope_for_cache_namespace() -> Result<()>
```

**Purpose**: This test checks that the app deletes the cache folder that matches the plugin's scope reported by the remote detail response. Scope means where the plugin belongs, such as global or workspace, and it affects where the cache is stored.

**Data flow**: It sets up remote-plugin config, credentials, and a fake remote detail response saying the plugin is workspace scoped. It prepares two cache folders: one in the workspace namespace and one in the global namespace. After sending the uninstall request and receiving success, it confirms the remote uninstall POST was made once, the workspace cache was removed, and the unrelated global cache was left alone.

**Call relations**: This test depends on mount_remote_plugin_detail to make the fake backend say the plugin is in the WORKSPACE scope. It then uses wait_for_remote_plugin_request_count to confirm the cloud uninstall call and file-system checks to confirm the server used the detail response to choose the right cache area.

*Call graph*: calls 5 internal fn (new, new, mount_remote_plugin_detail, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+6 more)).


##### `plugin_uninstall_accepts_workspace_remote_plugin_id_shape`  (lines 334–404)

```
async fn plugin_uninstall_accepts_workspace_remote_plugin_id_shape() -> Result<()>
```

**Purpose**: This test confirms that workspace remote plugin IDs with the newer underscore-and-hash-like shape are accepted. It makes sure the app does not reject valid workspace plugin IDs just because they look different from older IDs.

**Data flow**: It creates remote-plugin config and credentials, mounts a fake detail response for a workspace plugin named skill-improver, and prepares that plugin's workspace cache folder. It sends an uninstall request using the workspace-shaped plugin ID. The expected result is a success response, exactly one uninstall POST to the fake backend, and deletion of the skill-improver cache folder.

**Call relations**: This test calls mount_remote_plugin_detail_with_name directly because it needs a custom plugin name in the fake backend response. It then uses wait_for_remote_plugin_request_count to verify that the app accepted the ID and continued into the real remote uninstall flow.

*Call graph*: calls 5 internal fn (new, new, mount_remote_plugin_detail_with_name, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+6 more)).


##### `plugin_uninstall_rejects_before_post_when_remote_detail_fetch_fails`  (lines 407–460)

```
async fn plugin_uninstall_rejects_before_post_when_remote_detail_fetch_fails() -> Result<()>
```

**Purpose**: This test verifies that the app does not send the uninstall POST if it cannot first fetch remote plugin details. That prevents deleting local cache or changing cloud state when the app lacks the information needed to do the uninstall safely.

**Data flow**: It configures remote plugins and credentials but does not mount a successful detail response on the mock backend. It creates a legacy cache folder to prove it should remain untouched. After sending the uninstall request, it expects an invalid-request error mentioning the remote catalog request. It then confirms one GET detail request happened, zero uninstall POST requests happened, and the local legacy cache folder still exists.

**Call relations**: This test uses write_remote_plugin_catalog_config for setup and wait_for_remote_plugin_request_count twice: once to confirm the attempted detail lookup and once to confirm no uninstall POST was sent. It checks that the app server stops the flow at the detail-fetch step.

*Call graph*: calls 4 internal fn (new, new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 9 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, create_dir_all, timeout).


##### `plugin_uninstall_rejects_remote_plugin_id_with_spaces_before_network_call`  (lines 463–495)

```
async fn plugin_uninstall_rejects_remote_plugin_id_with_spaces_before_network_call() -> Result<()>
```

**Purpose**: This test checks that a remote plugin ID containing spaces is rejected before the app tries any network request. That protects the backend call path from malformed IDs.

**Data flow**: It enables remote plugins and starts a mock backend, then sends an uninstall request with the ID "sample plugin". The app server returns an invalid-request error saying the remote plugin ID is invalid. The test then confirms that no uninstall POST was sent to the backend for that bad path.

**Call relations**: This test uses write_remote_plugin_catalog_config to enable the remote path, but it expects validation to stop the flow immediately. wait_for_remote_plugin_request_count is used as a guardrail to prove the app did not hand the bad ID off to the network layer.

*Call graph*: calls 3 internal fn (new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_uninstall_rejects_invalid_remote_plugin_id_before_network_call`  (lines 498–530)

```
async fn plugin_uninstall_rejects_invalid_remote_plugin_id_before_network_call() -> Result<()>
```

**Purpose**: This test makes sure a plugin ID containing path traversal text, such as "../", is rejected before any network call. This is an important safety check because such strings can be dangerous when used in paths or URLs.

**Data flow**: It creates remote-plugin config and starts a fake backend server, then sends an uninstall request with the ID "linear/../../oops". The server replies with an invalid-request error that mentions an invalid remote plugin ID. The test checks that no uninstall POST was recorded for the dangerous-looking path.

**Call relations**: This test focuses on input validation at the front of the uninstall flow. It uses wait_for_remote_plugin_request_count to confirm the bad ID never reaches the backend request step.

*Call graph*: calls 3 internal fn (new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_uninstall_rejects_empty_remote_plugin_id`  (lines 533–558)

```
async fn plugin_uninstall_rejects_empty_remote_plugin_id() -> Result<()>
```

**Purpose**: This test confirms that an empty plugin ID is rejected. An uninstall request without a real ID cannot be safely mapped to any plugin.

**Data flow**: It enables remote plugins, starts the test app server, and sends an uninstall request with an empty string as the plugin ID. It waits for an error response and checks that the server reports an invalid remote plugin ID with the invalid-request error code.

**Call relations**: This test uses write_remote_plugin_catalog_config to put the app into the remote-plugin-enabled mode, then verifies that the app server's validation rejects the empty ID before any meaningful uninstall work is attempted.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); 8 external calls (start, new, new, Integer, assert!, assert_eq!, format!, timeout).


##### `write_installed_plugin`  (lines 560–577)

```
fn write_installed_plugin(
    codex_home: &TempDir,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<()>
```

**Purpose**: This helper creates a minimal fake installed local plugin on disk for tests. It gives the app server just enough files to believe a plugin is installed.

**Data flow**: It receives a temporary Codex home folder, a marketplace name, and a plugin name. From those values it builds the expected plugin cache path, creates the needed folders, and writes a small plugin.json file containing the plugin name. It returns success if the files were created and an error if the file system operation failed.

**Call relations**: The local uninstall and analytics tests call this helper during setup. It prepares the before-state that the app server later cleans up during uninstall.

*Call graph*: called by 2 (plugin_uninstall_removes_plugin_cache_and_config_entry, plugin_uninstall_tracks_analytics_event); 4 external calls (path, format!, create_dir_all, write).


##### `write_remote_plugin_catalog_config`  (lines 579–595)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a config file that enables plugins and remote plugins, and points ChatGPT/backend requests at a test server. It keeps the remote-plugin tests from talking to a real service.

**Data flow**: It receives the Codex home path and a base URL for the fake backend. It writes config.toml with that base URL and feature flags for plugins and remote_plugin set to true. It returns the file-writing result.

**Call relations**: All remote-plugin tests call this helper before starting the app server. It is the switch that routes the server's remote plugin catalog and uninstall calls to the mock server used by the test.

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

**Purpose**: This helper installs a standard fake remote plugin detail response on the mock server. It is a shortcut for tests that use the default plugin name, linear.

**Data flow**: It receives the mock server, remote plugin ID, release version, and scope. It passes those values, plus the default plugin name "linear", to mount_remote_plugin_detail_with_name. It does not return data; it changes the mock server so future matching GET requests receive the prepared response.

**Call relations**: Remote uninstall tests call this when they need the app server's detail lookup to succeed. It delegates the actual mock setup to mount_remote_plugin_detail_with_name.

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

**Purpose**: This helper teaches the mock backend how to answer a remote plugin detail request. Tests use it when they need control over the plugin name, version, and scope returned by the fake catalog.

**Data flow**: It receives the mock server, plugin ID, plugin name, release version, and scope. It builds a JSON response body that looks like a remote plugin detail record, including workspace discoverability when the scope is WORKSPACE. Then it mounts a GET route on the mock server that requires the expected authorization and account headers and returns that JSON body.

**Call relations**: mount_remote_plugin_detail calls this for the common linear case, and the workspace-ID test calls it directly for a custom plugin name. The app server later fetches this response before deciding which cache folder to delete and before sending the uninstall request.

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

**Purpose**: This helper waits until the mock backend has seen exactly the expected number of matching requests. It makes asynchronous tests reliable by giving the app server a short time to finish network work.

**Data flow**: It receives the mock server, an HTTP method name, a path ending to match, and the expected count. Inside a timeout, it repeatedly reads the mock server's recorded requests, counts the ones with the matching method and path suffix, and returns success when the count is exactly right. If there are too many requests, if required request records are missing, or if the timeout expires, it returns an error.

**Call relations**: Remote-plugin tests call this after sending uninstall requests or invalid requests. It acts as the witness that confirms the app did send, or deliberately did not send, the expected backend request.

*Call graph*: called by 6 (plugin_uninstall_accepts_workspace_remote_plugin_id_shape, plugin_uninstall_rejects_before_post_when_remote_detail_fetch_fails, plugin_uninstall_rejects_invalid_remote_plugin_id_before_network_call, plugin_uninstall_rejects_remote_plugin_id_with_spaces_before_network_call, plugin_uninstall_uses_detail_scope_for_cache_namespace, plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled); 5 external calls (from_millis, received_requests, bail!, sleep, timeout).


### `app-server/tests/suite/v2/marketplace_remove.rs`

`test` · `test execution`

This is a test file, so its job is to prove that one user-facing behavior works correctly. A “marketplace” here is an external source of plugins or tools that the app server can know about and install locally. Removing one should be like uninstalling an app: the saved record should disappear, and the files on disk should be removed too.

The tests create a temporary Codex home directory so they do not touch a real user’s files. One helper writes a fake marketplace entry into the configuration. Another helper creates a small fake installed marketplace folder, including the expected marketplace metadata file. The test then starts a real test app server, sends it a `marketplace/remove` request through the same JSON-RPC-style request path the application uses, and waits for the matching response. JSON-RPC is a simple message format where each request has an ID and the response uses the same ID.

The main success test verifies three things: the response names the removed marketplace, the response points to the installed folder that was removed, and both the config entry and install folder are actually gone afterward. The second test checks the failure case: if nothing is configured or installed under that name, the server should reject the request with a specific error code and message instead of pretending it succeeded.

#### Function details

##### `configured_marketplace_update`  (lines 20–29)

```
fn configured_marketplace_update() -> MarketplaceConfigUpdate<'static>
```

**Purpose**: Builds a small, realistic marketplace configuration record for tests. This gives the test server something that looks like a marketplace the user previously added.

**Data flow**: It takes no input. It fills in fixed sample details such as a last-updated time, a Git source URL, and a branch name. It returns that configuration record so a test can write it into the temporary Codex home.

**Call relations**: The success test calls this before asking the server to remove the marketplace. It supplies the configuration data that `record_user_marketplace` saves, creating the starting state that the removal request is expected to clean up.

*Call graph*: called by 1 (marketplace_remove_deletes_config_and_installed_root).


##### `write_installed_marketplace`  (lines 31–36)

```
fn write_installed_marketplace(codex_home: &std::path::Path, marketplace_name: &str) -> Result<()>
```

**Purpose**: Creates a fake installed marketplace folder on disk for a test. This makes the test environment look as if the marketplace has already been installed.

**Data flow**: It receives the temporary Codex home path and a marketplace name. It finds the normal install location, creates the expected plugin metadata folder, writes a minimal `marketplace.json` file, and returns success or an error if the filesystem work fails.

**Call relations**: The success test calls this after writing the marketplace configuration. Internally it asks `marketplace_install_root` where marketplace installs belong, then uses filesystem calls to create directories and write the fake metadata file.

*Call graph*: calls 1 internal fn (marketplace_install_root); called by 1 (marketplace_remove_deletes_config_and_installed_root); 2 external calls (create_dir_all, write).


##### `canonicalize_path_with_existing_parent`  (lines 38–47)

```
fn canonicalize_path_with_existing_parent(path: &std::path::Path) -> Result<std::path::PathBuf>
```

**Purpose**: Normalizes a path for comparison even when the final item may no longer exist. This is useful here because the test wants to compare the path of a folder that has just been removed.

**Data flow**: It receives a path. It separates the parent folder from the final file or directory name, canonicalizes the parent into its absolute real path, then joins the original final name back on. It returns the normalized path, or an error if the path has no parent, no final name, or the parent cannot be resolved.

**Call relations**: The success test uses this when checking the removed install path returned by the server. Since the marketplace folder may already be deleted, the helper avoids canonicalizing the missing folder itself and only canonicalizes its still-existing parent.

*Call graph*: 2 external calls (file_name, parent).


##### `marketplace_remove_deletes_config_and_installed_root`  (lines 50–88)

```
async fn marketplace_remove_deletes_config_and_installed_root() -> Result<()>
```

**Purpose**: Tests the happy path for marketplace removal. It proves that the app server removes both the marketplace’s config entry and its installed files, and returns the removed install location in its response.

**Data flow**: It starts with a fresh temporary Codex home. It writes a marketplace config record and creates a fake installed marketplace folder named `debug`. Then it starts the test app server, initializes it, sends a remove request, reads the response, checks the response fields, reads the config file, and verifies the config entry and install folder are gone. It returns success if all checks pass, or an error/assertion failure if anything is wrong.

**Call relations**: This is one of the file’s actual async tests. It uses `configured_marketplace_update` to create the saved marketplace state, `write_installed_marketplace` to create the installed files, `TestAppServer` to exercise the real server request path, and `to_response` to turn the raw response into the specific marketplace removal response type.

*Call graph*: calls 4 internal fn (new, configured_marketplace_update, write_installed_marketplace, marketplace_install_root); 8 external calls (new, Integer, to_response, assert!, assert_eq!, record_user_marketplace, read_to_string, timeout).


##### `marketplace_remove_rejects_unknown_marketplace`  (lines 91–115)

```
async fn marketplace_remove_rejects_unknown_marketplace() -> Result<()>
```

**Purpose**: Tests the error path for marketplace removal. It ensures the server refuses to remove a marketplace name that is neither configured nor installed.

**Data flow**: It starts with an empty temporary Codex home, launches and initializes the test app server, sends a remove request for `debug`, and waits for an error response with the matching request ID. It then checks that the error code and message are exactly the expected ones.

**Call relations**: This async test exercises the same server request path as the success test, but without creating any starting marketplace state. It relies on the server to detect the missing marketplace and return a JSON-RPC error, which the test reads through `read_stream_until_error_message`.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, Integer, assert_eq!, timeout).


### `app-server/tests/suite/v2/marketplace_upgrade.rs`

`test` · `test run`

A marketplace here is a folder of plugin information that the app can install from a source. These tests create small temporary Git repositories to act like real remote marketplaces, then ask a test app server to upgrade them through its normal JSON-RPC request path. JSON-RPC is a message format where a client sends a request with an id and later receives either a result or an error for that same id.

The file first provides helper functions that build fake marketplace repositories, make new commits, record marketplace settings in a temporary Codex home directory, and send an upgrade request to the running test server. The Git repository acts like a tiny “store shelf”: the test writes a marker file, commits it, changes it, and then checks whether the server fetched the newer marker.

The actual tests cover the important behavior from a user’s point of view. Upgrading all configured Git marketplaces should install both updated copies and write the new revisions back to config. Upgrading one named marketplace should leave the others alone. Running upgrade again when nothing changed should succeed but return no upgraded folders. Asking to upgrade a missing marketplace, or one configured as a local folder instead of Git, should return a clear request error. Without these tests, changes to marketplace upgrade code could silently break installing plugins from Git sources.

#### Function details

##### `run_git`  (lines 26–37)

```
fn run_git(cwd: &Path, args: &[&str]) -> Result<String>
```

**Purpose**: Runs a Git command inside a chosen folder and returns the command’s text output. Tests use it so they can create and inspect real Git repositories instead of mocking Git behavior.

**Data flow**: It receives a working directory and a list of Git arguments. It starts the git program there, checks whether it succeeded, and turns standard output into a trimmed string. If Git fails, it returns an error that includes the command, directory, and Git’s error text.

**Call relations**: The repository setup helpers call this whenever they need Git work done. `init_marketplace_repo` uses it to initialize, configure, commit, and read the first revision, while `commit_marketplace_marker` uses it to make later commits and read their revision ids.

*Call graph*: called by 2 (commit_marketplace_marker, init_marketplace_repo); 3 external calls (from_utf8_lossy, bail!, new).


##### `write_marketplace_files`  (lines 39–47)

```
fn write_marketplace_files(root: &Path, marketplace_name: &str, marker: &str) -> Result<()>
```

**Purpose**: Creates the minimum files needed for a fake marketplace repository. It gives the test marketplace a manifest file and a marker file whose contents can prove which version was installed.

**Data flow**: It receives a root folder, a marketplace name, and marker text. It creates the `.agents/plugins` directory, writes a `marketplace.json` file containing the marketplace name, and writes `marker.txt` with the marker text. The folder on disk is changed; success or a file-system error is returned.

**Call relations**: `init_marketplace_repo` calls this before making the first Git commit. The later tests then rely on the marker file to verify whether an upgrade copied the old or new marketplace contents.

*Call graph*: called by 1 (init_marketplace_repo); 4 external calls (join, format!, create_dir_all, write).


##### `init_marketplace_repo`  (lines 49–57)

```
fn init_marketplace_repo(root: &Path, marketplace_name: &str, marker: &str) -> Result<String>
```

**Purpose**: Turns an empty temporary folder into a small Git marketplace repository with an initial commit. It returns the first commit id so the tests can pretend the user currently has an older revision recorded.

**Data flow**: It receives a folder, marketplace name, and marker text. It initializes Git, sets test author details, writes marketplace files, stages everything, commits it, and asks Git for the current commit id. The result is the revision string for that initial marketplace state.

**Call relations**: The main upgrade tests call this at the start to create realistic Git sources. It delegates the file creation to `write_marketplace_files` and all Git commands to `run_git`.

*Call graph*: calls 2 internal fn (run_git, write_marketplace_files); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date).


##### `commit_marketplace_marker`  (lines 59–64)

```
fn commit_marketplace_marker(root: &Path, marker: &str) -> Result<String>
```

**Purpose**: Creates a new Git commit that changes only the marker file. Tests use this to simulate a marketplace publishing an update.

**Data flow**: It receives a repository folder and new marker text. It overwrites `marker.txt`, stages that file, commits it, and returns the new commit id. The repository moves from its older version to a newer version that can be upgraded to.

**Call relations**: The upgrade tests call this after `init_marketplace_repo` to create something newer than the recorded revision. It relies on `run_git` for staging, committing, and reading the new revision.

*Call graph*: calls 1 internal fn (run_git); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 2 external calls (join, write).


##### `configured_git_marketplace_update`  (lines 66–79)

```
fn configured_git_marketplace_update(
    source: &'a str,
    last_revision: Option<&'a str>,
    ref_name: Option<&'a str>,
) -> MarketplaceConfigUpdate<'a>
```

**Purpose**: Builds the configuration record that says a marketplace comes from Git. This lets tests write the same kind of marketplace entry the real app expects.

**Data flow**: It receives a Git source string, an optional last-known revision, and an optional Git reference name. It packages those values with fixed test metadata, marks the source type as `git`, and returns the configuration update object.

**Call relations**: `record_git_marketplace` calls this just before saving a marketplace into the temporary Codex home. It is the small builder that keeps each test from repeating the same configuration fields.

*Call graph*: called by 1 (record_git_marketplace).


##### `configured_local_marketplace_update`  (lines 81–90)

```
fn configured_local_marketplace_update(source: &str) -> MarketplaceConfigUpdate<'_>
```

**Purpose**: Builds a configuration record for a marketplace that comes from a local folder, not Git. The rejection test uses it to prove that the upgrade request refuses non-Git marketplaces.

**Data flow**: It receives a local source path as text. It packages that path with fixed test metadata, marks the source type as `local`, and leaves Git-only fields empty. The returned object is ready to be written into test config.

**Call relations**: `marketplace_upgrade_rejects_unknown_or_non_git_marketplace` calls this when setting up the local-only marketplace. That test then asks the server to upgrade it and expects an error.

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

**Purpose**: Writes a Git marketplace entry into the temporary Codex configuration. It is a test convenience wrapper around the real config-writing function.

**Data flow**: It receives the Codex home folder, marketplace name, Git source folder, last recorded revision, and optional reference name. It converts the source path to text, builds a Git marketplace update object, and writes it to the user marketplace config. The config file in the temporary home is changed.

**Call relations**: The successful upgrade tests call this to make the app server believe a marketplace is already configured. It calls `configured_git_marketplace_update` for the data shape and then hands the result to `record_user_marketplace` from the config code.

*Call graph*: calls 1 internal fn (configured_git_marketplace_update); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 2 external calls (display, record_user_marketplace).


##### `disable_plugin_startup_tasks`  (lines 108–116)

```
fn disable_plugin_startup_tasks(codex_home: &Path) -> Result<()>
```

**Purpose**: Turns off plugin startup behavior in the temporary test configuration. This keeps the tests focused on marketplace upgrading instead of unrelated plugin work that might run when the server starts.

**Data flow**: It receives the Codex home folder. It reads `config.toml`, appends a features section setting `plugins = false`, and writes the file back. The temporary config is changed before the test server starts.

**Call relations**: The tests that start with Git marketplaces call this before creating `TestAppServer`. It prepares a quieter server startup so `send_marketplace_upgrade` can test the upgrade request itself.

*Call graph*: called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 4 external calls (join, format!, read_to_string, write).


##### `marketplace_install_root`  (lines 118–120)

```
fn marketplace_install_root(codex_home: &Path) -> std::path::PathBuf
```

**Purpose**: Computes where installed marketplaces should live under a Codex home directory. It centralizes the test’s expectation for the install folder path.

**Data flow**: It receives the Codex home path and appends the test install directory `.tmp/marketplaces`. It returns that combined path without touching the disk.

**Call relations**: `expected_installed_root` calls this when building the exact expected installed marketplace path. One test also uses the same location to confirm that an unselected marketplace was not installed.

*Call graph*: called by 1 (expected_installed_root); 1 external calls (join).


##### `expected_installed_root`  (lines 122–127)

```
fn expected_installed_root(codex_home: &Path, marketplace_name: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Builds the absolute path where a specific marketplace should be installed. Tests use this path both in expected server responses and when reading installed files.

**Data flow**: It receives the Codex home folder and marketplace name. It first canonicalizes the Codex home so the path is absolute, appends the marketplace install folder and name, and converts the result into an absolute-path type. It returns that checked absolute path or an error if the path cannot be made valid.

**Call relations**: The tests for upgrading all marketplaces and upgrading one named marketplace call this before comparing responses. It uses `marketplace_install_root` to keep the path layout consistent.

*Call graph*: calls 2 internal fn (marketplace_install_root, try_from); called by 2 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only); 1 external calls (canonicalize).


##### `send_marketplace_upgrade`  (lines 129–145)

```
async fn send_marketplace_upgrade(
    mcp: &mut TestAppServer,
    marketplace_name: Option<&str>,
) -> Result<MarketplaceUpgradeResponse>
```

**Purpose**: Sends a marketplace upgrade request to the test app server and waits for the successful response. It hides the request-id and timeout details so the tests can read like user stories.

**Data flow**: It receives a mutable test server connection and an optional marketplace name. It sends a request containing that name, waits until a response with the matching request id arrives, converts the JSON-RPC response into a `MarketplaceUpgradeResponse`, and returns it. If the server is too slow or returns an invalid response, an error comes back.

**Call relations**: The successful upgrade tests call this after the server is initialized. It talks to `TestAppServer` through `send_marketplace_upgrade_request` and `read_stream_until_response_message`, then hands the raw response to `to_response` for typed decoding.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_marketplace_upgrade_request); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 3 external calls (Integer, to_response, timeout).


##### `marketplace_upgrade_all_configured_git_marketplaces`  (lines 148–199)

```
async fn marketplace_upgrade_all_configured_git_marketplaces() -> Result<()>
```

**Purpose**: Checks that a request with no specific marketplace name upgrades every configured Git marketplace. It verifies both the server response and the actual files installed on disk.

**Data flow**: It creates temporary Codex and Git source folders, initializes two marketplaces, commits newer versions, records the old revisions in config, and starts the test server. It sends an upgrade request for all marketplaces, then checks that the response names both marketplaces, returns both install roots, has no errors, installs the newer marker files, and writes the new revisions into config.

**Call relations**: This is a top-level asynchronous test called by the test runner. It strings together the helper functions: repository setup through `init_marketplace_repo` and `commit_marketplace_marker`, config setup through `record_git_marketplace` and `disable_plugin_startup_tasks`, path expectations through `expected_installed_root`, and the actual server request through `send_marketplace_upgrade`.

*Call graph*: calls 7 internal fn (new, commit_marketplace_marker, disable_plugin_startup_tasks, expected_installed_root, init_marketplace_repo, record_git_marketplace, send_marketplace_upgrade); 5 external calls (new, assert!, assert_eq!, read_to_string, timeout).


##### `marketplace_upgrade_named_marketplace_only`  (lines 202–250)

```
async fn marketplace_upgrade_named_marketplace_only() -> Result<()>
```

**Purpose**: Checks that asking to upgrade one named marketplace updates only that marketplace. This protects against accidentally upgrading every configured marketplace when the user requested just one.

**Data flow**: It creates two temporary Git marketplaces, records both as configured, and starts the test server. It sends an upgrade request naming `tools`, then checks that the response mentions only `tools`, that the installed `tools` marker is the new one, and that the `debug` install folder was never created.

**Call relations**: This top-level test follows the same setup pattern as the all-marketplaces test but calls `send_marketplace_upgrade` with a marketplace name. It uses `expected_installed_root` only for the selected marketplace, then directly checks the shared install root to make sure the unselected one was untouched.

*Call graph*: calls 7 internal fn (new, commit_marketplace_marker, disable_plugin_startup_tasks, expected_installed_root, init_marketplace_repo, record_git_marketplace, send_marketplace_upgrade); 4 external calls (new, assert!, assert_eq!, timeout).


##### `marketplace_upgrade_returns_empty_roots_when_already_up_to_date`  (lines 253–283)

```
async fn marketplace_upgrade_returns_empty_roots_when_already_up_to_date() -> Result<()>
```

**Purpose**: Checks the no-op case: upgrading a marketplace that is already current should succeed but report that nothing was upgraded. This gives callers a clean way to distinguish “no changes” from “failure.”

**Data flow**: It creates one Git marketplace, records an older revision, starts the server, and sends an upgrade request once to bring it up to date. Then it sends the same request again. The second response should list the selected marketplace, contain no upgraded roots, and contain no errors.

**Call relations**: This top-level test uses the same repository and config helpers as the other successful cases. Its main interaction with the server is two calls to `send_marketplace_upgrade`: the first prepares the up-to-date state, and the second checks the expected empty result.

*Call graph*: calls 6 internal fn (new, commit_marketplace_marker, disable_plugin_startup_tasks, init_marketplace_repo, record_git_marketplace, send_marketplace_upgrade); 4 external calls (new, assert!, assert_eq!, timeout).


##### `marketplace_upgrade_rejects_unknown_or_non_git_marketplace`  (lines 286–318)

```
async fn marketplace_upgrade_rejects_unknown_or_non_git_marketplace() -> Result<()>
```

**Purpose**: Checks that the server rejects marketplace upgrade requests that cannot be valid: a missing marketplace and a marketplace configured as local instead of Git. It makes sure callers receive a clear protocol error instead of a misleading success.

**Data flow**: It creates a temporary Codex home and records one local-only marketplace. After starting the test server, it sends two upgrade requests: one for a nonexistent name and one for the local marketplace. For each request it waits for an error response and checks that the error code and message match the expected invalid-request result.

**Call relations**: This top-level test does not use `send_marketplace_upgrade` because it expects errors rather than successful responses. It builds the local config with `configured_local_marketplace_update`, writes it through `record_user_marketplace`, sends requests directly through the test server, and waits for matching error messages.

*Call graph*: calls 2 internal fn (new, configured_local_marketplace_update); 5 external calls (new, Integer, assert_eq!, record_user_marketplace, timeout).


### App, hook, and skill discovery
These tests focus on listing higher-level extensibility surfaces exposed by the app server, including apps, hooks, and skills from local, plugin, and MCP-backed sources.

### `app-server/tests/suite/v2/app_list.rs`

`test` · `test run`

This is a test file, not production code. Its job is to prove that the app list feature behaves correctly in many real-world situations: connectors turned off, the wrong kind of login, workspace plugin settings disabled, slow upstream services, pagination, cached data, and forced refreshes. Think of it like a small stage set: the tests create temporary config files and auth files, start a pretend ChatGPT server, then ask the real app-server for "app/list" and check the answer.

The fake server has two sides. One side returns directory apps, like a public catalog. The other side exposes MCP tools, where MCP means Model Context Protocol, a way for tools/apps to describe what actions they provide. The app-server is expected to merge these two sources: directory entries provide rich metadata, while tools prove which apps are actually accessible to the signed-in user.

The tests also watch for update notifications. These notifications matter because clients may show app list changes while data is still loading. The file checks that the server sends useful updates, avoids empty or misleading interim updates, keeps old cached data if a forced refresh fails, and respects local configuration such as per-app enabled flags.

#### Function details

##### `list_apps_returns_empty_when_connectors_disabled`  (lines 64–90)

```
async fn list_apps_returns_empty_when_connectors_disabled() -> Result<()>
```

**Purpose**: Checks that app listing returns an empty list when the connectors feature is not enabled. This protects users from seeing app/connectors data when the feature is meant to be off.

**Data flow**: It creates a temporary Codex home folder and starts a test app-server with default settings. It sends an app-list request with a limit, waits for the matching JSON-RPC response, converts that response into an app-list result, and confirms there are no apps and no next page.

**Call relations**: The async test runner calls this test. Inside the test, TestAppServer starts the real server under test, and the response is decoded through the shared test helper so the assertion checks the same shape a client would receive.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, to_response, assert!, timeout).


##### `list_apps_returns_empty_with_api_key_auth`  (lines 93–155)

```
async fn list_apps_returns_empty_with_api_key_auth() -> Result<()>
```

**Purpose**: Checks that connector apps are not returned when the user is authenticated with an API key instead of ChatGPT account credentials. This matters because connector access depends on ChatGPT account context, not just any valid credential.

**Data flow**: It prepares fake connector data and fake tool data, starts a local fake apps server, writes config pointing the app-server to it, and saves API-key auth. After sending app/list, it expects an empty result even though the fake upstream server has data.

**Call relations**: The test runner invokes it. It relies on start_apps_server_with_delays to create the pretend upstream service, write_connectors_config to aim the server at that service, and the common response conversion helper to inspect the app-server reply.

*Call graph*: calls 4 internal fn (new, start_apps_server_with_delays, write_connectors_config, default); 7 external calls (new, Integer, to_response, assert!, save_auth, timeout, vec!).


##### `list_apps_returns_empty_when_workspace_codex_plugins_disabled`  (lines 158–217)

```
async fn list_apps_returns_empty_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Checks that workspace-level settings can disable Codex plugins/connectors, even when connector data exists. This prevents a client from showing apps that an organization has turned off.

**Data flow**: It starts a fake apps server whose workspace settings say plugins are disabled, writes connector config and ChatGPT-style auth, then runs app/list. The output should be an empty list with no cursor.

**Call relations**: The test runner calls it. It uses start_apps_server_with_workspace_plugins_enabled to make the fake settings endpoint return the disabled flag, then drives the app-server through TestAppServer without managed config so the test controls the setting.

*Call graph*: calls 4 internal fn (new, new_without_managed_config, start_apps_server_with_workspace_plugins_enabled, write_connectors_config); 7 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, timeout, vec!).


##### `list_apps_includes_plugin_apps_for_chatgpt_auth`  (lines 220–261)

```
async fn list_apps_includes_plugin_apps_for_chatgpt_auth() -> Result<()>
```

**Purpose**: Checks that locally cached plugin apps are included when the user has ChatGPT authentication and plugin support is enabled. This confirms that app listing is not limited to remote directory results.

**Data flow**: It starts a fake server with no remote apps, writes config enabling connectors and plugins, creates a local plugin fixture on disk, and writes ChatGPT auth. The app-list response is then checked for the app id from the local plugin file.

**Call relations**: The test runner invokes it. It combines write_connectors_and_plugins_config and write_plugin_app_fixture to build the local setup before TestAppServer asks the app-server for the merged list.

*Call graph*: calls 5 internal fn (new, new, start_apps_server_with_delays, write_connectors_and_plugins_config, write_plugin_app_fixture); 7 external calls (new, new, Integer, to_response, write_chatgpt_auth, assert!, timeout).


##### `list_apps_uses_thread_feature_flag_when_thread_id_is_provided`  (lines 264–364)

```
async fn list_apps_uses_thread_feature_flag_when_thread_id_is_provided() -> Result<()>
```

**Purpose**: Checks that app listing can use the feature settings that belonged to an already-started thread. This matters because changing global config later should not necessarily change what an existing conversation is allowed to use.

**Data flow**: It starts with connectors enabled, creates a thread, then rewrites config to disable connectors globally. A global app-list request returns nothing, but an app-list request tied to the earlier thread still returns the connector app.

**Call relations**: The test runner calls it. The test first uses the thread-start request flow to capture a thread id, then sends two app-list requests so the app-server behavior can be compared with and without that thread context.

*Call graph*: calls 4 internal fn (new, new, start_apps_server_with_delays, write_connectors_config); 10 external calls (new, Integer, default, to_response, write_chatgpt_auth, assert!, format!, write, timeout, vec!).


##### `list_apps_keeps_apps_with_app_only_tools_accessible`  (lines 367–431)

```
async fn list_apps_keeps_apps_with_app_only_tools_accessible() -> Result<()>
```

**Purpose**: Checks that a connector whose tool is marked visible only inside the app still counts as accessible. This avoids hiding apps just because their tools are not meant to appear in every tool picker.

**Data flow**: It creates a connector tool, adds metadata saying its UI visibility is only "app", starts the fake apps server, writes config and auth, then forces a fresh app-list fetch. The result should contain the app and mark it accessible.

**Call relations**: The test runner invokes it. It uses connector_tool to create realistic MCP tool metadata and start_apps_server_with_delays to serve that metadata to the app-server.

*Call graph*: calls 5 internal fn (new, new, connector_tool, start_apps_server_with_delays, write_connectors_config); 9 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, json!, timeout, vec!).


##### `list_apps_reports_is_enabled_from_config`  (lines 434–507)

```
async fn list_apps_reports_is_enabled_from_config() -> Result<()>
```

**Purpose**: Checks that the app list reports whether a specific app is enabled according to local config. This lets clients show an app while still knowing it is disabled for use.

**Data flow**: It starts a fake connector/tool server, writes a config file that enables connectors globally but sets apps.beta.enabled to false, and writes ChatGPT auth. The returned app list contains beta, but its is_enabled field is false.

**Call relations**: The test runner calls it. The fake upstream provides the app, while the local config file provides the override that the app-server must apply before returning the response.

*Call graph*: calls 3 internal fn (new, new, start_apps_server_with_delays); 10 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, write, timeout, vec!).


##### `list_apps_emits_updates_and_returns_after_both_lists_load`  (lines 510–680)

```
async fn list_apps_emits_updates_and_returns_after_both_lists_load() -> Result<()>
```

**Purpose**: Checks the timing and content of app-list update notifications when accessible tool data arrives before delayed directory data. It proves the server can first show accessible apps, then later send a richer merged list.

**Data flow**: It prepares two directory apps, rich metadata for one app, and one accessible MCP tool. The fake directory response is delayed, so the test first expects an update with only the accessible app, then a second update and final response with the merged list.

**Call relations**: The test runner invokes it. It uses read_app_list_updated_notification to listen for server notifications before reading the final JSON-RPC response, which verifies both streaming updates and the request result.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 10 external calls (from_millis, from, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_waits_for_accessible_data_before_emitting_directory_updates`  (lines 683–805)

```
async fn list_apps_waits_for_accessible_data_before_emitting_directory_updates() -> Result<()>
```

**Purpose**: Checks that the app-server does not send directory-only updates before it knows which apps are accessible. This prevents a client from briefly showing misleading inaccessible data.

**Data flow**: It makes directory data available immediately but delays the tool list that marks beta accessible. It listens to update notifications until the full expected list arrives, and any earlier update must contain only accessible apps.

**Call relations**: The test runner calls it. It uses the fake server delay knobs from start_apps_server_with_delays and the notification reader helper to inspect the order of messages produced by the app-server.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 9 external calls (from_millis, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_does_not_emit_empty_interim_updates`  (lines 808–895)

```
async fn list_apps_does_not_emit_empty_interim_updates() -> Result<()>
```

**Purpose**: Checks that the app-server does not send an empty app-list update while it is still waiting for real data. This matters because an empty update could make a user interface flash or clear useful state unnecessarily.

**Data flow**: It delays the directory response and provides no accessible tools. The test waits briefly for an update and expects none, then waits longer and verifies the eventual directory app appears in both the update and the final response.

**Call relations**: The test runner invokes it. It uses read_app_list_updated_notification with a short timeout to prove that no premature notification is emitted.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 10 external calls (from_millis, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_paginates_results`  (lines 898–1038)

```
async fn list_apps_paginates_results() -> Result<()>
```

**Purpose**: Checks that app/list supports pages when the client asks for only a limited number of apps. Pagination is the common pattern where a large list is split into smaller chunks with a cursor pointing to the next chunk.

**Data flow**: It sets up two apps, asks for one result, stores the returned cursor, waits for the merged data to be ready, and asks again with that cursor. The first page contains beta, the second contains alpha, and the second page has no further cursor.

**Call relations**: The test runner calls it. It combines normal request/response checks with notification reading so it knows when the server has finished building the complete merged list before requesting the second page.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 9 external calls (from_millis, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_force_refetch_preserves_previous_cache_on_failure`  (lines 1041–1142)

```
async fn list_apps_force_refetch_preserves_previous_cache_on_failure() -> Result<()>
```

**Purpose**: Checks that a failed forced refresh does not erase the previous successful app-list cache. This protects users from losing their last known app list during a temporary auth or network problem.

**Data flow**: It first loads a valid app list using good ChatGPT auth. Then it overwrites auth with an invalid token and sends a force_refetch request, which should fail. A later non-forced app-list request should still return the original cached data.

**Call relations**: The test runner invokes it. It uses start_apps_server_with_delays for the fake upstream and then deliberately changes the auth file between requests to simulate a refresh failure.

*Call graph*: calls 4 internal fn (new, new, start_apps_server_with_delays, write_connectors_config); 8 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_force_refetch_patches_updates_from_cached_snapshots`  (lines 1145–1383)

```
async fn list_apps_force_refetch_patches_updates_from_cached_snapshots() -> Result<()>
```

**Purpose**: Checks the detailed behavior of forced refreshes when cached data already exists. It verifies that the server can show a useful cached snapshot while new data is loading, then replace it with the final refreshed list.

**Data flow**: It warms the cache with beta as accessible and alpha from the directory. Then the fake server is changed so beta disappears and alpha has updated text. A forced refresh first emits the old cached combined list, avoids an unhelpful inaccessible-only interim update, then emits and returns the new final alpha-only list.

**Call relations**: The test runner calls it. This test needs start_apps_server_with_delays_and_control so it can mutate the fake upstream during the test, and it uses read_app_list_updated_notification several times to verify the exact update sequence.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays_and_control, write_connectors_config); 10 external calls (from_millis, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `read_app_list_updated_notification`  (lines 1385–1398)

```
async fn read_app_list_updated_notification(
    mcp: &mut TestAppServer,
) -> Result<AppListUpdatedNotification>
```

**Purpose**: Waits for the next app/list/updated notification and turns it into the specific app-list payload used by the tests. It saves each test from repeating the same waiting and decoding code.

**Data flow**: It receives a mutable TestAppServer, waits up to the default timeout for a notification named app/list/updated, converts the generic server notification into the app-list-updated variant, and returns that payload. If the notification is the wrong kind, it returns an error.

**Call relations**: The update-order tests call this helper whenever they need to observe streaming notifications before the final response. It delegates the actual stream reading to TestAppServer and uses the timeout wrapper so a broken server fails the test instead of hanging forever.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 5 (list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_patches_updates_from_cached_snapshots, list_apps_paginates_results, list_apps_waits_for_accessible_data_before_emitting_directory_updates); 2 external calls (bail!, timeout).


##### `AppListMcpServer::new`  (lines 1416–1418)

```
fn new(tools: Arc<StdMutex<Vec<Tool>>>, tools_delay: Duration) -> Self
```

**Purpose**: Creates the fake MCP server object used by the tests. It stores the shared tool list and an optional artificial delay for listing tools.

**Data flow**: It receives a thread-safe shared list of tools and a delay duration. It returns an AppListMcpServer containing those values, without starting any network work by itself.

**Call relations**: The fake HTTP service factory inside start_apps_server_with_delays_and_control_inner calls this when a test MCP session is created. Later, the MCP framework calls this object’s get_info and list_tools methods.


##### `AppsServerControl::set_connectors`  (lines 1428–1434)

```
fn set_connectors(&self, connectors: Vec<AppInfo>)
```

**Purpose**: Changes the fake directory response while a test is running. This lets a test simulate the remote app directory changing over time.

**Data flow**: It receives a new list of AppInfo values. It locks the shared response storage and replaces it with JSON shaped like the directory API response: apps plus a null next token.

**Call relations**: The force-refetch cache test uses this control object after the app-server has already warmed its cache, so the next refresh sees different upstream directory data.

*Call graph*: 1 external calls (json!).


##### `AppsServerControl::set_tools`  (lines 1436–1442)

```
fn set_tools(&self, tools: Vec<Tool>)
```

**Purpose**: Changes the fake MCP tool list while a test is running. This lets a test simulate apps becoming accessible or inaccessible.

**Data flow**: It receives a new list of Tool objects. It locks the shared tool storage and replaces the old list with the new one.

**Call relations**: The force-refetch cache test calls this alongside set_connectors so the fake upstream can represent a changed world before the app-server performs a forced refresh.


##### `AppListMcpServer::get_info`  (lines 1446–1448)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Tells the MCP framework what this fake server can do. In this test server, the important capability is that it can list tools.

**Data flow**: It reads no outside data from the test state. It returns a ServerInfo value whose capabilities say tools are enabled.

**Call relations**: The MCP framework calls this during setup or capability negotiation. That allows the app-server under test to know it can ask the fake MCP server for tools.

*Call graph*: 2 external calls (builder, new).


##### `AppListMcpServer::list_tools`  (lines 1450–1472)

```
fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Futu
```

**Purpose**: Returns the current fake MCP tools to the app-server. These tools are how the tests mark certain connector apps as accessible.

**Data flow**: It receives the MCP list-tools request and context, though this implementation does not need them. It optionally sleeps for the configured delay, clones the shared tool list under a lock, and returns it with no next cursor.

**Call relations**: The MCP framework calls this when the app-server asks the fake upstream for accessible tools. Tests use the delay to force different arrival orders between tool data and directory data.

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

**Purpose**: Starts the fake apps server with configurable delays for directory data and tool data. It is the common helper for tests that do not need to change server data after startup.

**Data flow**: It receives initial connectors, initial tools, and two delay values. It calls the more general server-start helper, discards the live control handle, and returns the local server URL plus the background task handle.

**Call relations**: Many app-list tests call this to create the pretend ChatGPT/MCP upstream. It hands the real setup work to start_apps_server_with_delays_and_control.

*Call graph*: calls 1 internal fn (start_apps_server_with_delays_and_control); called by 10 (list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_preserves_previous_cache_on_failure, list_apps_includes_plugin_apps_for_chatgpt_auth, list_apps_keeps_apps_with_app_only_tools_accessible, list_apps_paginates_results, list_apps_reports_is_enabled_from_config, list_apps_returns_empty_with_api_key_auth, list_apps_uses_thread_feature_flag_when_thread_id_is_provided, list_apps_waits_for_accessible_data_before_emitting_directory_updates).


##### `start_apps_server_with_workspace_plugins_enabled`  (lines 1487–1502)

```
async fn start_apps_server_with_workspace_plugins_enabled(
    connectors: Vec<AppInfo>,
    tools: Vec<Tool>,
    workspace_plugins_enabled: bool,
) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts the fake apps server with a chosen workspace plugin setting. This is used to test whether app-server respects organization or workspace policy.

**Data flow**: It receives connectors, tools, and a boolean saying whether workspace plugins are enabled. It starts the shared fake server with no artificial delays and returns its URL and background task handle.

**Call relations**: The workspace-disabled test calls this helper. It delegates to start_apps_server_with_delays_and_control_inner with the workspace flag set to the requested value.

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

**Purpose**: Starts the fake apps server and also returns a control handle for changing its data later. This is useful for tests that need to simulate refreshes or upstream changes.

**Data flow**: It receives initial connectors, tools, and delays. It calls the inner setup helper with workspace plugins enabled, then returns the server URL, task handle, and AppsServerControl object.

**Call relations**: The force-refetch patching test calls this directly because it needs live control. The simpler start_apps_server_with_delays helper also calls it and hides the control handle.

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

**Purpose**: Builds and launches the full fake upstream server used by the tests. This includes directory API routes, a workspace settings route, and a nested MCP HTTP service.

**Data flow**: It takes initial connector data, initial tool data, delay settings, and the workspace plugin flag. It puts shared data behind locks, binds a local random TCP port, builds an Axum router, spawns the server in the background, and returns the URL, task handle, and control object.

**Call relations**: The public server-start helpers call this. The routes it registers later call workspace_settings_response and list_directory_connectors, while the nested MCP service creates AppListMcpServer instances for tool listing.

*Call graph*: called by 2 (start_apps_server_with_delays_and_control, start_apps_server_with_workspace_plugins_enabled); 12 external calls (new, default, new, new, default, new, bind, get, serve, format! (+2 more)).


##### `workspace_settings_response`  (lines 1576–1598)

```
async fn workspace_settings_response(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Imitates the ChatGPT workspace settings endpoint. It returns whether plugins are enabled for the account, but only if the request has the expected auth headers.

**Data flow**: It reads the shared fake server state and the incoming HTTP headers. If the bearer token or account id is wrong, it returns Unauthorized; otherwise it returns JSON containing beta_settings.enable_plugins.

**Call relations**: The fake Axum router calls this when the app-server requests account settings. Tests use it indirectly to check that app listing honors workspace plugin policy.

*Call graph*: 3 external calls (get, Json, json!).


##### `list_directory_connectors`  (lines 1600–1633)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Imitates the ChatGPT directory endpoint that lists available connector apps. It checks authentication and query parameters before returning the fake app list.

**Data flow**: It receives shared state, HTTP headers, and the request URI. It may sleep for the configured directory delay, then verifies the bearer token, account id, and external_logos=true query parameter. If all are valid, it clones and returns the current JSON response; otherwise it returns an HTTP error.

**Call relations**: The fake router calls this for both directory list routes. The app-server under test hits these routes during app-list loading, and the tests use delays and mutable responses to shape what the app-server sees.

*Call graph*: 4 external calls (get, query, Json, sleep).


##### `connector_tool`  (lines 1635–1654)

```
fn connector_tool(connector_id: &str, connector_name: &str) -> Result<Tool>
```

**Purpose**: Creates a realistic fake MCP tool that represents a connector app. The metadata links the tool back to a connector id and display name.

**Data flow**: It receives a connector id and connector name. It builds a small JSON schema, creates a read-only Tool named connector_<id>, attaches connector_id and connector_name metadata, and returns the tool or an error if JSON conversion fails.

**Call relations**: Tests that need accessible connector apps use this helper before starting the fake server. In the provided call graph, the app-only visibility test calls it and then edits the metadata further.

*Call graph*: called by 1 (list_apps_keeps_apps_with_app_only_tools_accessible); 9 external calls (new, Borrowed, Owned, new, new, format!, json!, new, from_value).


##### `write_connectors_config`  (lines 1656–1670)

```
fn write_connectors_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config file that points the app-server at the fake ChatGPT base URL and enables connectors. This lets each test run in its own temporary home folder.

**Data flow**: It receives a Codex home path and a base URL. It writes config.toml containing that URL, file-based OAuth credential storage, and features.connectors = true, then returns the file write result.

**Call relations**: Most connector tests call this before starting TestAppServer. The app-server later reads this file during its own startup and uses it to talk to the fake upstream instead of the real service.

*Call graph*: called by 10 (list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_patches_updates_from_cached_snapshots, list_apps_force_refetch_preserves_previous_cache_on_failure, list_apps_keeps_apps_with_app_only_tools_accessible, list_apps_paginates_results, list_apps_returns_empty_when_workspace_codex_plugins_disabled, list_apps_returns_empty_with_api_key_auth, list_apps_uses_thread_feature_flag_when_thread_id_is_provided, list_apps_waits_for_accessible_data_before_emitting_directory_updates); 3 external calls (join, format!, write).


##### `write_connectors_and_plugins_config`  (lines 1672–1690)

```
fn write_connectors_and_plugins_config(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes config that enables both connectors and plugins, including one enabled test plugin. This is used for tests that verify local plugin apps appear in app/list.

**Data flow**: It receives a Codex home path and fake base URL. It writes config.toml with connectors and plugins enabled plus a sample@test plugin entry.

**Call relations**: The plugin-app inclusion test calls this before creating the plugin fixture and starting the app-server. Together, the config and fixture make the local plugin visible to app listing.

*Call graph*: called by 1 (list_apps_includes_plugin_apps_for_chatgpt_auth); 3 external calls (join, format!, write).


##### `write_plugin_app_fixture`  (lines 1692–1712)

```
fn write_plugin_app_fixture(codex_home: &Path, plugin_name: &str, app_id: &str) -> Result<()>
```

**Purpose**: Creates a small fake cached plugin on disk with an app id. This gives the app-server something local to discover during plugin app listing.

**Data flow**: It receives the Codex home path, plugin name, and desired app id. It creates the plugin cache directories, writes a plugin.json file, writes an .app.json file describing the app id, and returns success or any filesystem/JSON error.

**Call relations**: The plugin-app inclusion test calls this after writing plugin-enabled config. The app-server then reads these files as if they were a cached installed plugin.

*Call graph*: called by 1 (list_apps_includes_plugin_apps_for_chatgpt_auth); 6 external calls (join, format!, json!, to_vec_pretty, create_dir_all, write).


### `app-server/tests/suite/v2/hooks_list.rs`

`test` · `test run`

Hooks are small commands that Codex can run at certain moments, such as before a tool is used or when a user submits a prompt. Because hooks can run local commands, the app server must be careful about where they came from, whether they are enabled, and whether the user has trusted their exact contents. This test file acts like a safety checklist for that behavior.

The tests build temporary Codex home folders, project folders, plugin folders, and config files. Then they start a real test app server and talk to it through its JSON-RPC-style API, which is a request-and-response protocol using JSON messages. The tests ask for `hooks/list` results and compare the returned hook metadata with the expected source path, command, matcher, timeout, trust status, and enabled state.

Several tests also write configuration changes through the server, rather than editing files directly. That matters because the real app must update already-loaded sessions when hook trust or enabled state changes. The longer session tests prove that untrusted or modified hooks do not run, trusted hooks do run, and disabled hooks stop running even inside a session that was already started. In short, this file protects the user-facing contract for discovering and safely controlling hooks.

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

**Purpose**: Builds the expected identity hash for a command hook. The tests use this to check that the server reports the same “fingerprint” for a hook that the configuration system would calculate.

**Data flow**: It receives the hook event name, optional matcher, command text, timeout, and optional status message. It packages those values into the same normalized hook shape used by configuration, converts that shape to TOML data, and asks the config library to produce a version hash. It returns that hash as a string.

**Call relations**: The hook-list tests call this when they build the exact `HookMetadata` they expect from the server. It hands off the normalized value to the configuration library’s TOML conversion and versioning code so the test compares against the real hash algorithm, not a made-up value.

*Call graph*: 4 external calls (try_from, version_for_toml, unreachable!, vec!).


##### `write_user_hook_config`  (lines 69–85)

```
fn write_user_hook_config(codex_home: &std::path::Path) -> Result<()>
```

**Purpose**: Creates a simple user-level hook configuration in a temporary Codex home folder. This gives tests a known hook that should be discovered as coming from the user’s main config file.

**Data flow**: It receives a path to a fake Codex home directory. It writes a `config.toml` file there containing one `PreToolUse` command hook for Bash, with a command, timeout, and status message. It returns success or an error if writing the file fails.

**Call relations**: The user-hook tests call this before starting the test app server. Once the server starts, it reads this config file, and the tests then ask the server to list hooks or change the hook’s enabled state.

*Call graph*: called by 2 (config_batch_write_toggles_user_hook, hooks_list_shows_discovered_hook); 2 external calls (join, write).


##### `write_plugin_hook_config`  (lines 87–107)

```
fn write_plugin_hook_config(codex_home: &std::path::Path, hooks_json: &str) -> Result<()>
```

**Purpose**: Creates a fake installed plugin with a hooks file and enables that plugin in the temporary user config. This lets tests check how plugin-provided hooks are discovered and reported.

**Data flow**: It receives a fake Codex home path and the exact JSON text to use as the plugin’s hooks file. It creates the expected plugin cache folders, writes a minimal plugin manifest, writes `hooks/hooks.json`, and writes a user `config.toml` that turns on plugins and hooks and enables the demo plugin. It returns success or any filesystem error.

**Call relations**: Plugin-related tests call this during setup. The app server later reads the generated plugin files, so the tests can verify normal plugin hooks, plugin hook parse warnings, and whether plugin capability information is warmed before a thread starts.

*Call graph*: called by 3 (hooks_list_shows_discovered_plugin_hook, hooks_list_shows_plugin_hook_load_warnings, hooks_list_warms_plugin_capabilities_for_thread_start); 3 external calls (join, create_dir_all, write).


##### `write_project_hook_config`  (lines 109–130)

```
fn write_project_hook_config(dot_codex_folder: &std::path::Path, command: &str) -> Result<()>
```

**Purpose**: Writes a project-level `.codex/config.toml` containing one command hook. It is used to create controlled project and worktree hook setups.

**Data flow**: It receives the path to a `.codex` folder and the command string the hook should run. It creates the folder if needed, writes a config file that enables hooks, and inserts the supplied command into a `PreToolUse` Bash hook. It returns success or a filesystem error.

**Call relations**: The linked-worktree test calls this to create both a root repository hook and a worktree hook. The server is then expected to choose the root repository hook for the linked worktree, which the test verifies.

*Call graph*: called by 1 (hooks_list_uses_root_repo_hooks_for_linked_worktrees); 4 external calls (join, format!, create_dir_all, write).


##### `hooks_list_shows_discovered_hook`  (lines 133–187)

```
async fn hooks_list_shows_discovered_hook() -> Result<()>
```

**Purpose**: Checks that a user-defined hook appears in the hook list with all important details filled in correctly. This confirms the basic “read hooks from user config and show them to the client” path.

**Data flow**: It creates temporary home and working directories, writes a user hook config, starts the test server, and sends a hook-list request for the working directory. It converts the server response into a typed hook-list response and compares it to the exact expected hook metadata, including path, source, command, timeout, enabled state, hash, and untrusted status.

**Call relations**: This test uses `write_user_hook_config` for setup and `command_hook_hash` to compute the expected hash. It drives the app server through `TestAppServer`, waits for the matching response, then verifies that the protocol response matches the contract.

*Call graph*: calls 3 internal fn (new, write_user_hook_config, from_absolute_path); 7 external calls (new, Integer, to_response, assert_eq!, canonicalize, timeout, vec!).


##### `hooks_list_shows_discovered_plugin_hook`  (lines 190–265)

```
async fn hooks_list_shows_discovered_plugin_hook() -> Result<()>
```

**Purpose**: Checks that a hook supplied by an enabled plugin appears in the hook list as a plugin hook. This protects the plugin hook discovery behavior.

**Data flow**: It creates temporary folders, writes a fake plugin with a valid `hooks.json`, starts the server, and asks for hooks for one working directory. It then checks that the response contains one hook whose source is the plugin, whose plugin id is present, and whose command, matcher, timeout, status message, hash, and trust status match expectations.

**Call relations**: This test uses `write_plugin_hook_config` to create the plugin files and `command_hook_hash` to match the server’s hook fingerprint. The server reads the plugin cache during the request, and the test checks the JSON-RPC response after converting it into typed data.

*Call graph*: calls 3 internal fn (new, write_plugin_hook_config, from_absolute_path); 7 external calls (new, Integer, to_response, assert_eq!, canonicalize, timeout, vec!).


##### `hooks_list_warms_plugin_capabilities_for_thread_start`  (lines 268–343)

```
async fn hooks_list_warms_plugin_capabilities_for_thread_start() -> Result<()>
```

**Purpose**: Checks that asking for hooks also loads enough plugin information for a later thread start to know about plugin MCP servers. An MCP server is an external tool server that Codex can connect to for plugin-provided capabilities.

**Data flow**: It writes a fake plugin hook and a plugin `.mcp.json` file naming a plugin MCP server. After starting the app server, it sends a hook-list request, waits for it to finish, deletes the `.mcp.json` file, and then starts a thread. Even though the file is gone, it expects a startup-status notification for the plugin MCP server, proving the information was already warmed into memory.

**Call relations**: This test uses `write_plugin_hook_config` for plugin setup, then talks to the server first through the hook-list request and later through thread-start. It watches server notifications to confirm that the warmed plugin capability data is handed into the thread startup flow.

*Call graph*: calls 2 internal fn (new, write_plugin_hook_config); 8 external calls (new, Integer, default, to_response, remove_file, write, timeout, vec!).


##### `hooks_list_shows_plugin_hook_load_warnings`  (lines 346–375)

```
async fn hooks_list_shows_plugin_hook_load_warnings() -> Result<()>
```

**Purpose**: Checks that a broken plugin hook file does not crash hook listing and instead produces a warning. This helps make plugin problems visible without breaking the whole hook-list response.

**Data flow**: It creates a fake plugin whose hooks file contains invalid JSON, starts the server, and asks for hooks. The response should contain no hooks for that working directory, one warning, and that warning should mention that parsing the plugin hooks config failed.

**Call relations**: This test uses `write_plugin_hook_config` with deliberately bad JSON. The server attempts to load the plugin hook file during hook listing, records the parse problem, and returns that warning for the test to inspect.

*Call graph*: calls 2 internal fn (new, write_plugin_hook_config); 7 external calls (new, Integer, to_response, assert!, assert_eq!, timeout, vec!).


##### `hooks_list_uses_each_cwds_effective_feature_enablement`  (lines 378–469)

```
async fn hooks_list_uses_each_cwds_effective_feature_enablement() -> Result<()>
```

**Purpose**: Checks that hook listing respects feature flags separately for each requested working directory. In plain terms, one folder may have hooks disabled while another project has them enabled.

**Data flow**: It writes a user config that disables hooks globally, then creates a trusted workspace whose project config enables hooks and defines one project hook. It sends one hook-list request containing both the home folder and the workspace. The response should show no hooks for the folder where hooks are effectively off, and one project hook for the workspace where hooks are effectively on.

**Call relations**: This test sets project trust with `set_project_trust_level`, then drives the server through a multi-directory hook-list request. It verifies that the server does not apply one directory’s feature setting to all directories in the request.

*Call graph*: calls 3 internal fn (new, set_project_trust_level, try_from); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `hooks_list_uses_root_repo_hooks_for_linked_worktrees`  (lines 472–551)

```
async fn hooks_list_uses_root_repo_hooks_for_linked_worktrees() -> Result<()>
```

**Purpose**: Checks that a linked Git worktree uses the root repository’s Codex hook config, not its own separate `.codex` folder. This matters because linked worktrees are alternate checkouts that still belong to the same underlying repository.

**Data flow**: It creates a fake repository root and a fake linked worktree by writing a `.git` file that points back to the repo’s worktree metadata. It writes different hooks in the root repo and worktree folders, marks the root repo trusted, and asks the server to list hooks for both paths. It verifies that both entries use the root hook and the same hook key, then writes a trusted hash for that key and confirms the worktree view reports the hook as trusted.

**Call relations**: This test uses `write_project_hook_config` twice to make competing configs, then relies on the server’s repository detection during hook listing. It also uses the config batch write API to update hook trust state and checks that the same state applies when listing from the linked worktree.

*Call graph*: calls 4 internal fn (new, write_project_hook_config, set_project_trust_level, from_absolute_path); 9 external calls (new, Integer, to_response, assert_eq!, format!, create_dir_all, write, timeout, vec!).


##### `config_batch_write_toggles_user_hook`  (lines 554–650)

```
async fn config_batch_write_toggles_user_hook() -> Result<()>
```

**Purpose**: Checks that the server’s config-write API can turn a user hook off and back on. This proves that hook enabled state can be changed through the app, not only by manually editing files.

**Data flow**: It writes a user hook, starts the server, lists hooks, and records the hook key. It sends a config batch write that sets that hook’s state to `enabled: false`, lists hooks again, and expects the same hook to be present but disabled. Then it writes `enabled: true`, lists again, and expects the hook to be enabled.

**Call relations**: This test uses `write_user_hook_config` for setup and then alternates between hook-list requests and config batch write requests. The hook key returned by the server becomes the address used for later state edits.

*Call graph*: calls 2 internal fn (new, write_user_hook_config); 6 external calls (new, Integer, to_response, assert_eq!, timeout, vec!).


##### `config_batch_write_updates_hook_trust_for_loaded_session`  (lines 653–901)

```
async fn config_batch_write_updates_hook_trust_for_loaded_session() -> Result<()>
```

**Purpose**: Checks that changing hook trust through the config API affects a session that is already running. It proves that untrusted hooks do not run, trusted hooks do run, and modified hooks stop running again.

**Data flow**: It skips Windows, then creates a mock model server and a Python hook script that logs each time it receives input. It starts the app server, lists the hook, starts a thread, and sends a first turn while the hook is untrusted; no log file should appear. It writes the hook’s current hash as trusted, confirms hook listing now says trusted, and sends a second turn; the hook should log once. Then it modifies the hook config so its hash changes, confirms listing says modified, and sends a third turn; the log count should stay at one.

**Call relations**: This test combines hook listing, config batch writing, thread starting, and turn starting. The mock response server supplies assistant replies so turns can complete, while the hook log file acts as proof of whether the app server actually ran the hook.

*Call graph*: calls 1 internal fn (new); 13 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, assert_ne!, format!, skip_if_windows! (+3 more)).


##### `config_batch_write_disables_hook_for_loaded_session`  (lines 904–1094)

```
async fn config_batch_write_disables_hook_for_loaded_session() -> Result<()>
```

**Purpose**: Checks that disabling a hook through the config API stops it from running in an already-loaded session. This protects users from needing to restart a session just to turn off a hook.

**Data flow**: It skips Windows, creates a mock model server, writes a Python hook script that records runs, and configures that hook in the temporary Codex home. It lists the hook, marks its current hash trusted, starts a thread, and sends a first turn; the hook log should contain one entry. It then writes hook state with `enabled: false`, sends a second turn in the same thread, and checks that the log count remains one.

**Call relations**: This test follows the same live-session path as the trust test, but focuses on the enabled flag. It uses the hook key from hook listing as the target of the config write, then uses turn execution and the log file to verify that the running session picked up the disabled state.

*Call graph*: calls 1 internal fn (new); 11 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, format!, skip_if_windows!, write, timeout (+1 more)).


### `app-server/tests/suite/v2/skills_list.rs`

`test` · `test suite`

This test file acts like a safety checklist for the server’s skill-listing feature. A “skill” here is a folder containing a `SKILL.md` file with a name and description. The server must gather these skills from several places: the user’s Codex home folder, the current workspace, local plugins, cached remote plugins, and temporary extra roots set while the server is running.

The tests create temporary folders, write fake skill files and plugin metadata, start a test app server, then talk to it through the same request-and-response protocol a real client would use. They also use a mock HTTP server to pretend to be ChatGPT/backend plugin services, so the tests can check remote-plugin behavior without depending on the real network.

The important behaviors covered are practical ones: plugin skills should be hidden when plugins are disabled; workspace skills should be skipped when the execution environment is disabled; relative working directories should be accepted; response order should match request order; cached results should stay cached unless a reload is requested; runtime-added skill roots should take effect only for the current server process; and file changes should trigger a `skills/changed` notification. Without these tests, the app could silently show stale skills, expose disabled plugin skills, miss updates, or confuse clients by returning results in the wrong shape or order.

#### Function details

##### `write_skill`  (lines 38–44)

```
fn write_skill(root: &TempDir, name: &str) -> Result<()>
```

**Purpose**: Creates a simple test skill under a temporary Codex home folder. Test cases use it when they need a known skill file to be discoverable by the server.

**Data flow**: It receives a temporary root folder and a skill name. It creates `skills/<name>/SKILL.md`, writes front matter containing that name and a matching description, and returns success or an error if the filesystem work fails.

**Call relations**: Several tests call this before starting or querying the test server, so the server has a real skill file to find. It supports the tests for normal home skills, disabled workspace roots, and change notifications.

*Call graph*: called by 3 (skills_changed_notification_is_emitted_after_skill_change, skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled, skills_list_skips_cwd_roots_when_environment_disabled); 4 external calls (path, format!, create_dir_all, write).


##### `expect_skills_changed_notification`  (lines 46–61)

```
async fn expect_skills_changed_notification(
    mcp: &mut TestAppServer,
    timeout_duration: Duration,
) -> Result<()>
```

**Purpose**: Waits for the server to send a `skills/changed` notification and checks that it has the expected empty payload. This keeps tests from guessing whether a skill-root update has actually reached clients.

**Data flow**: It receives a running test server connection and a timeout length. It waits until a `skills/changed` notification arrives, reads its JSON parameters, converts them into the expected notification type, checks equality, and returns success or an error.

**Call relations**: The runtime-extra-roots test calls this after each request that changes extra skill roots. It sits between “we asked the server to change roots” and “now we safely query the skill list again.”

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (skills_extra_roots_set_updates_process_runtime_roots); 3 external calls (assert_eq!, from_value, timeout).


##### `write_plugins_enabled_config_with_base_url`  (lines 63–77)

```
fn write_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a small config file that turns on plugin support and points ChatGPT/backend requests at a test server. This lets tests exercise plugin behavior without using production services.

**Data flow**: It receives a Codex home path and a base URL. It writes `config.toml` with that URL and `[features] plugins = true`, then returns the filesystem result.

**Call relations**: The workspace-plugin-disabled test calls this while setting up its fake environment. The app server later reads this config when it starts.

*Call graph*: called by 1 (skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled); 3 external calls (join, format!, write).


##### `write_remote_plugins_enabled_config_with_base_url`  (lines 79–94)

```
fn write_remote_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a config file that enables both plugin support and remote-plugin support. This prepares the server to ask the mocked backend about installed remote plugins.

**Data flow**: It receives a Codex home path and a base URL. It writes `config.toml` containing the backend URL plus `plugins = true` and `remote_plugin = true`, then returns the write result.

**Call relations**: The remote-plugin cache test calls this before starting the server. That test then uses mock HTTP responses to control what the server believes is available or installed.

*Call graph*: called by 1 (skills_list_loads_remote_installed_plugin_skills_from_cache); 3 external calls (join, format!, write).


##### `write_plugin_with_skill`  (lines 96–135)

```
fn write_plugin_with_skill(
    repo_root: &std::path::Path,
    plugin_name: &str,
    skill_name: &str,
) -> Result<()>
```

**Purpose**: Creates a fake local plugin inside a temporary repository, including one skill inside that plugin. This gives tests a realistic workspace plugin to include or exclude.

**Data flow**: It receives a repository path, a plugin name, and a skill name. It creates enough repository and plugin marker files for the server to recognize the plugin, writes marketplace metadata, writes plugin metadata, creates `skills/<skill_name>/SKILL.md`, and returns success or an error.

**Call relations**: The test for disabled workspace Codex plugins uses this helper to set up a plugin skill that should not be shown when backend account settings say plugins are disabled.

*Call graph*: called by 1 (skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled); 4 external calls (join, format!, create_dir_all, write).


##### `write_cached_remote_plugin_with_skill`  (lines 137–155)

```
fn write_cached_remote_plugin_with_skill(
    codex_home: &std::path::Path,
) -> Result<std::path::PathBuf>
```

**Purpose**: Creates a fake cached remote plugin under the Codex home directory and puts a skill inside it. This simulates a remote plugin that has already been downloaded to disk.

**Data flow**: It receives the Codex home path. It creates a cache directory for a `linear` plugin, writes plugin metadata, writes a `triage-issues` skill file, and returns the path to that skill file.

**Call relations**: The remote-installed-plugin test calls this before the server refreshes plugin installation state. Later, after a plugin list request refreshes the cache state, the test checks that this cached skill appears in the skill list.

*Call graph*: called by 1 (skills_list_loads_remote_installed_plugin_skills_from_cache); 3 external calls (join, create_dir_all, write).


##### `skills_list_loads_remote_installed_plugin_skills_from_cache`  (lines 158–337)

```
async fn skills_list_loads_remote_installed_plugin_skills_from_cache() -> Result<()>
```

**Purpose**: Checks that skills from a cached remote plugin become visible after the server learns that the remote plugin is installed and enabled. It protects the flow where plugin metadata comes from the backend but skill files are read from the local cache.

**Data flow**: The test builds temporary Codex home and working folders, writes a cached remote plugin skill, writes remote-plugin config and auth, and programs a mock backend with plugin-list responses. It first confirms the cached skill is not shown before installation state is refreshed, then sends a plugin-list request, repeatedly asks for skills until the remote plugin skill appears, and finally checks its path and enabled status.

**Call relations**: This is a full integration-style test: setup helpers create disk state, wiremock supplies backend answers, `TestAppServer` runs the app server, plugin-list refreshes remote plugin state, and skills-list proves the server now includes the cached plugin skill.

*Call graph*: calls 4 internal fn (new, new, write_cached_remote_plugin_with_skill, write_remote_plugins_enabled_config_with_base_url); 19 external calls (from_millis, given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq! (+9 more)).


##### `skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled`  (lines 340–402)

```
async fn skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Checks that workspace plugin skills are hidden when account settings say Codex plugins are disabled, while ordinary non-plugin skills still remain available. This prevents disabled plugin features from leaking into the client.

**Data flow**: The test creates a home skill and a local plugin skill, writes config and auth, and makes the mock backend return `enable_plugins: false`. It starts the server, requests skills for the repository, and verifies the home skill is present but the plugin skill is absent.

**Call relations**: It uses the local-skill and local-plugin helpers for setup, then relies on the server’s account-settings lookup during initialization or request handling. The final skill-list response is the proof that backend policy is being enforced.

*Call graph*: calls 5 internal fn (new, new_without_managed_config, write_plugin_with_skill, write_plugins_enabled_config_with_base_url, write_skill); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+5 more)).


##### `skills_list_skips_cwd_roots_when_environment_disabled`  (lines 405–452)

```
async fn skills_list_skips_cwd_roots_when_environment_disabled() -> Result<()>
```

**Purpose**: Checks that workspace-local skills are not loaded when the execution environment is disabled. This matters because reading workspace roots may depend on that environment being available or allowed.

**Data flow**: The test creates one skill in Codex home and another under the current working directory’s `.codex/skills` folder. It starts the server with the execution-server environment variable set to `none`, asks for skills for that working directory, and checks that only the home skill appears.

**Call relations**: It calls `write_skill` for the home skill and writes the workspace skill directly. The server is started with special environment settings, and the skills-list response shows that cwd-based discovery was skipped.

*Call graph*: calls 2 internal fn (new_with_env, write_skill); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `skills_list_accepts_relative_cwds`  (lines 455–480)

```
async fn skills_list_accepts_relative_cwds() -> Result<()>
```

**Purpose**: Checks that the skills-list request accepts a relative working-directory path instead of requiring an absolute one. This keeps the protocol friendly to clients that naturally pass relative paths.

**Data flow**: The test creates a relative directory inside the temporary Codex home, starts the server, sends that relative path as the requested cwd, and verifies the response keeps the same relative path and reports no errors.

**Call relations**: This is a focused protocol-shape test. It starts a normal test server, sends one skills-list request, and inspects the returned entry to make sure path handling did not reject or rewrite the relative cwd.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, from, timeout, vec!).


##### `skills_list_preserves_requested_cwd_order`  (lines 483–517)

```
async fn skills_list_preserves_requested_cwd_order() -> Result<()>
```

**Purpose**: Checks that when a client asks for skills for multiple working directories, the server returns results in the same order. This avoids forcing clients to guess which result belongs to which request position.

**Data flow**: The test creates two temporary working directories, starts the server, sends both paths in order, reads the response, and compares the returned cwd list with the original order.

**Call relations**: It exercises the multi-cwd part of the skills-list request. The app server does the lookup work, and the test checks that any internal parallelism or caching does not reorder the final response.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, timeout, vec!).


##### `skills_list_uses_cached_result_until_force_reload`  (lines 520–595)

```
async fn skills_list_uses_cached_result_until_force_reload() -> Result<()>
```

**Purpose**: Checks that normal skill-list requests reuse cached results, and that `force_reload` is needed to see newly created workspace skills. This makes the server’s caching behavior explicit and predictable.

**Data flow**: The test first requests skills for an empty cwd with `force_reload: false`, which seeds the cache. It then writes a new skill into that cwd, asks again without forcing reload and confirms the new skill is still hidden, then asks with `force_reload: true` and confirms the new skill appears.

**Call relations**: This test drives the server through three skill-list requests against the same cwd. The filesystem changes between requests, and the response differences show exactly when the server trusts its cache versus rescanning disk.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `skills_extra_roots_set_updates_process_runtime_roots`  (lines 598–739)

```
async fn skills_extra_roots_set_updates_process_runtime_roots() -> Result<()>
```

**Purpose**: Checks that clients can add, replace, and clear extra skill roots while the server is running, and that those roots do not persist after restarting the server. This supports temporary, per-process skill discovery.

**Data flow**: The test creates an extra skills directory containing a runtime skill, starts the server, sends a request to set that directory as an extra root, waits for a change notification, and confirms the skill appears. It then replaces the root with a missing directory and later clears the roots, checking each time that the skill disappears. Finally it restarts the server and confirms the runtime root was not saved permanently.

**Call relations**: This test uses `expect_skills_changed_notification` after each root-setting request, because clients should be told that available skills may have changed. It connects the extra-roots protocol request to the later skills-list response and to restart behavior.

*Call graph*: calls 2 internal fn (new, expect_skills_changed_notification); 10 external calls (new, new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `skills_changed_notification_is_emitted_after_skill_change`  (lines 742–849)

```
async fn skills_changed_notification_is_emitted_after_skill_change() -> Result<()>
```

**Purpose**: Checks that editing an existing skill file causes the server to notify clients and return updated skill details. This protects live update behavior, where users should not need to restart the app after changing a skill.

**Data flow**: The test starts a mock assistant backend, writes config and an initial `demo` skill, starts the server, and confirms the original description appears. It starts a thread so the server is actively watching, rewrites the skill file with a new description, waits for a `skills/changed` notification, then asks for skills again and checks that the updated description is returned.

**Call relations**: This test ties together file watching, notification delivery, and cache invalidation. The helper writes the first skill, the test server sends and receives protocol messages, and the final skills-list request proves the notification corresponded to real refreshed data.

*Call graph*: calls 2 internal fn (new_with_env, write_skill); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, write_mock_responses_config_toml_with_chatgpt_base_url, assert!, assert_eq!, from_value, write, timeout (+1 more)).


### `app-server/tests/suite/v2/executor_skills.rs`

`test` · `test run`

This is an integration test for the app server’s skill-selection behavior. A “skill” here is a small instruction file, `SKILL.md`, that tells the model how to use a named capability. The test builds a miniature world: a fake model server, a temporary Codex home folder, a local skill, and a separate plugin folder that also defines a deploy skill. The important case is that both skills collide on the same final name, `demo-plugin:deploy`, but the selected executor root should win.

The test starts the app server with a config that points model traffic at the fake server. It then creates a local skill containing one marker string and a plugin skill containing a different marker string. Next, it starts a thread while selecting the plugin folder as a capability root. After that, it sends a user turn asking to use the skill.

Finally, it inspects what the app server sent to the fake model. It confirms three things: the developer-facing instructions mention the selected skill name, exactly one skill block was included for the user, and that block contains the plugin skill marker rather than the local skill marker. Without this behavior, the model might receive the wrong instructions when local and plugin skills share names, which could make it use the wrong tool or follow the wrong procedure.

#### Function details

##### `selected_executor_root_exposes_plugin_skill`  (lines 24–148)

```
async fn selected_executor_root_exposes_plugin_skill() -> Result<()>
```

**Purpose**: This test proves that a plugin skill selected through an executor capability root is the one shown to the model, even when a local skill has a colliding name. It protects against a subtle bug where the app might pick the wrong `SKILL.md` file and send incorrect instructions.

**Data flow**: The test starts with no real server state, then creates temporary folders and files for configuration, a local skill, and a plugin skill. It starts a mock model server that returns a simple streamed response, launches a test app server using the temporary Codex home, starts a thread with the plugin folder selected as a capability root, and sends a turn asking to use the skill. At the end, it reads the recorded mock-model request and checks that the visible skill text contains the plugin marker, contains the expected plugin-qualified name, and does not contain the local skill marker.

**Call relations**: During the test, helper code starts the mock response server, mounts a one-time streamed response, creates the test app server, initializes it, sends JSON-RPC-style thread and turn requests, and converts the thread-start response into a typed response. Once the app server has completed the turn, the test asks the mock server for the single model request it received and uses assertions to verify that the larger app flow chose the correct skill instructions.

*Call graph*: calls 4 internal fn (new, mount_sse_once, sse, start_mock_server); 11 external calls (default, new, Integer, to_response, assert!, assert_eq!, format!, create_dir_all, write, timeout (+1 more)).


### MCP servers, tools, and resources
These suites exercise MCP integration end to end, from server status and executor-scoped exposure to direct tool calls, elicitation forwarding, and resource access.

### `app-server/tests/suite/v2/executor_mcp.rs`

`test` · `integration test run`

This is an integration test: it starts a real test app server, creates temporary configuration files, and talks to the server the way a client would. The feature under test is MCP, the Model Context Protocol, which lets the app expose external tools to the model. Here, a plugin declares an MCP server that should run through a chosen execution environment. The key safety rule is that this plugin-provided tool must not leak into unrelated threads, much like a meeting room’s private equipment should only be available to people in that room.

The test builds a temporary Codex home directory, writes a mock model provider config, and defines an executor environment with a special environment variable. It then creates a fake plugin folder containing a `.mcp.json` file that points to a stdio-based MCP server, meaning the tool server communicates over standard input and output rather than a network port.

After starting the app server, the test opens one thread with that plugin selected. It then changes configuration on disk and asks the server to reload MCP settings, proving global MCP refresh still works. Next, it simulates model responses that request the plugin MCP echo tool and checks that the tool output includes both the echoed message and the executor-only environment value. Finally, it confirms the plugin MCP server appears in the selected thread but not in a new unselected thread.

#### Function details

##### `selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread`  (lines 34–219)

```
async fn selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread() -> Result<()>
```

**Purpose**: This is the main test case. It proves that a plugin’s stdio MCP server is available to the thread that selected the plugin and executor, while staying hidden from threads that did not select it.

**Data flow**: It starts with temporary folders, mock server addresses, and generated config files. It writes an executor definition, creates a fake plugin with MCP settings, starts a test app server, opens a selected thread, reloads MCP configuration, and feeds mocked model events that ask to call the MCP echo tool. The result is a set of assertions: the model saw and used the expected plugin tool, the tool ran with the executor environment variable, the refreshed global MCP server works, and the plugin MCP server is absent from an unrelated thread.

**Call relations**: During the test, it uses `start_thread` to create both the selected and unselected conversations. It also uses `mcp_server_names` near the end to ask the app server which MCP servers each thread can see. Around those helpers, it drives the larger scenario by creating the mock response server, mounting fake model event streams, sending app-server requests, waiting for responses, and checking the observed results.

*Call graph*: calls 4 internal fn (new, start_thread, mount_sse_sequence, start_mock_server); 16 external calls (new, default, new, Integer, to_response, write_mock_responses_config_toml, assert!, assert_eq!, format!, json! (+6 more)).


##### `mcp_server_names`  (lines 221–244)

```
async fn mcp_server_names(
    app_server: &mut TestAppServer,
    thread_id: String,
) -> Result<Vec<String>>
```

**Purpose**: This helper asks the running test app server which MCP servers are visible for one specific thread. It returns just the server names so the test can easily check whether a plugin server is present or absent.

**Data flow**: It receives a mutable connection to the test app server and a thread ID. It sends a list-status request scoped to that thread, waits for the matching response with a timeout, converts the raw response into a typed `ListMcpServerStatusResponse`, and then turns the returned server records into a simple list of names.

**Call relations**: The main test calls this after exercising tool calls and configuration reload. It uses the app server’s request and response helpers to perform the query, then hands back a compact list that the main test can assert against.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_list_mcp_server_status_request); 3 external calls (Integer, to_response, timeout).


##### `start_thread`  (lines 246–264)

```
async fn start_thread(
    app_server: &mut TestAppServer,
    selected_capability_roots: Option<Vec<SelectedCapabilityRoot>>,
) -> Result<String>
```

**Purpose**: This helper starts a new app-server thread for the test and returns its ID. It can optionally include selected capability roots, which are the plugin or environment-backed capabilities the new thread should be allowed to use.

**Data flow**: It receives a mutable test app server and an optional list of selected capability roots. It sends a thread-start request using a mock model name, waits for the response with a timeout, converts the raw response into a `ThreadStartResponse`, and returns the newly created thread’s ID.

**Call relations**: The main test calls this first to create a thread that selects the executor plugin, and later to create a plain thread with no selected plugin. By returning only the thread ID, it gives the rest of the test the handle needed to start turns and query thread-specific MCP server visibility.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 1 (selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread); 4 external calls (default, Integer, to_response, timeout).


### `app-server/tests/suite/v2/mcp_server_status.rs`

`test` · `test run`

This is a test file, but it builds a realistic miniature world. It starts temporary MCP servers on local network ports, writes temporary configuration files, starts the app server, asks it for MCP server status, and checks the answer. In plain terms, it verifies that when a user asks “what outside tools are available?”, the app reports the real server names, real tool names, and useful server details without accidentally renaming or losing anything.

The file defines two fake MCP servers. McpStatusServer is a normal, quick server that advertises one tool and some server information. SlowInventoryServer also advertises one tool, but deliberately waits before listing resources and resource templates. That delay is used to prove that a “tools and auth only” status request does not waste time asking for slower inventory data it does not need.

The tests also cover project-local configuration. A thread started in a trusted workspace can see MCP servers declared in that workspace’s .codex/config.toml, while a request without that thread should not. Another test checks a subtle naming issue: server names that become similar after internal “safe name” cleanup, such as dashes versus underscores, must still be reported as separate servers. The helper functions start and stop the temporary MCP servers so each test is isolated.

#### Function details

##### `mcp_server_status_list_returns_raw_server_and_tool_names`  (lines 46–115)

```
async fn mcp_server_status_list_returns_raw_server_and_tool_names() -> Result<()>
```

**Purpose**: This test checks that the status API reports the MCP server name and tool name exactly as configured and advertised. It protects against accidental name cleanup or rewriting leaking into the user-facing status response.

**Data flow**: It starts a mock app backend and a temporary MCP server whose tool is named “look-up.raw”. It writes a temporary app config that points to that MCP server, starts the test app server, sends a status-list request, then turns the returned message into a typed response. The expected result is one server named “some-server”, one tool named “look-up.raw”, and server information whose title is “Lookup Server”. It also stops the temporary MCP server task at the end.

**Call relations**: The async test runner invokes this test. Inside the test, start_mcp_server creates the local MCP endpoint, the test support code creates the fake app environment, and the app server is asked for MCP status. McpStatusServer::get_info and McpStatusServer::list_tools are reached indirectly when the app server contacts the temporary MCP server.

*Call graph*: calls 2 internal fn (new, start_mcp_server); 12 external calls (new, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format!, read_to_string (+2 more)).


##### `mcp_server_status_list_uses_thread_project_local_config`  (lines 118–207)

```
async fn mcp_server_status_list_uses_thread_project_local_config() -> Result<()>
```

**Purpose**: This test proves that MCP servers from a project’s local configuration are only used when the status request is tied to a thread running in that project. It matters because project-specific tool access should not leak into unrelated requests.

**Data flow**: It creates a temporary app home and a temporary workspace, marks that workspace as trusted, starts the app server, and starts a thread whose current directory is the workspace. After the thread exists, it writes a project-local .codex/config.toml that defines an MCP server. A status request without a thread id returns no servers. A status request with the thread id returns the project server and its advertised tool.

**Call relations**: The async test runner invokes this test. It uses start_mcp_server to create the local MCP endpoint, set_project_trust_level to make project-local config acceptable, and the TestAppServer helper to send both thread-start and MCP-status requests. The temporary MCP server’s trait methods are called indirectly during the threaded status request.

*Call graph*: calls 3 internal fn (new, start_mcp_server, set_project_trust_level); 13 external calls (new, default, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format! (+3 more)).


##### `McpStatusServer::get_info`  (lines 215–219)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: This tells MCP clients what this fake server can do and what it is called. In these tests, it advertises tool support and includes readable server metadata such as the title “Lookup Server”.

**Data flow**: It reads no outside input beyond the server instance. It builds a ServerInfo value that says the server supports tools and identifies itself as a lookup server version 1.0.0 with a human title. That ServerInfo is returned to whoever is connecting to the fake MCP server.

**Call relations**: The rmcp server framework calls this when the app server connects and asks about the temporary MCP server. The result feeds the app server’s status response, which is why the tests can check that server_info.title appears correctly.

*Call graph*: 3 external calls (new, builder, new).


##### `McpStatusServer::list_tools`  (lines 221–244)

```
async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListTools
```

**Purpose**: This returns the single test tool that the fake MCP server offers. It gives the app server something concrete to discover during status listing.

**Data flow**: It receives an optional paging request and a request context, but this test server ignores both. It builds a very small JSON input schema, creates one read-only tool using the tool name stored in the server, and returns that one tool with no next page.

**Call relations**: The rmcp framework calls this when the app server asks the fake MCP server for its tools. The status-list tests then inspect the app server’s response to make sure this exact tool name is present.

*Call graph*: 8 external calls (new, Borrowed, Owned, new, json!, new, from_value, vec!).


##### `SlowInventoryServer::get_info`  (lines 253–260)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: This tells clients that the slow fake server supports both tools and resources. The extra resource capability is important because it gives the app server a chance to make slow inventory calls, which one test verifies it avoids when asked for tools only.

**Data flow**: It reads no outside input and builds a ServerInfo value. That value advertises tool support and resource support, then returns it to the MCP client.

**Call relations**: The rmcp framework calls this when the app server connects to the slow test MCP server. Its advertised capabilities set up the later choice: the app server could ask for resources, but in the tools-only status test it should not.

*Call graph*: 2 external calls (builder, new).


##### `SlowInventoryServer::list_tools`  (lines 262–285)

```
async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData>
```

**Purpose**: This returns the slow server’s single tool quickly. It is intentionally fast so the test can show that the tools-only status path completes without waiting on resource inventory.

**Data flow**: It ignores the paging request and request context. It creates a simple JSON input schema, builds one read-only tool using the stored tool name, and returns that tool with no continuation cursor.

**Call relations**: The app server reaches this through the rmcp framework while answering a tools-and-auth-only status request. The returned tool is enough for the test to verify success without involving the deliberately slow resource methods.

*Call graph*: 8 external calls (new, Borrowed, Owned, new, json!, new, from_value, vec!).


##### `SlowInventoryServer::list_resources`  (lines 287–298)

```
async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourcesResult, rmcp::ErrorD
```

**Purpose**: This simulates a slow MCP resource listing. It exists so the test can detect whether the app server is doing unnecessary work when only tool information was requested.

**Data flow**: It receives the usual MCP request information but does not use it. It waits for two seconds, then returns an empty list of resources. The wait is the important output in practice: if the app server calls this during the fast path, the test would time out.

**Call relations**: The rmcp framework would call this if the app server asked the slow test server for resources. In the tools-and-auth-only test, the app server should avoid this method, proving that it does not block on unneeded inventory.

*Call graph*: 3 external calls (from_secs, new, sleep).


##### `SlowInventoryServer::list_resource_templates`  (lines 300–311)

```
async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourceTemplatesRes
```

**Purpose**: This simulates a slow listing of resource templates, which are reusable patterns for MCP resources. Like list_resources, it is a tripwire for unnecessary work.

**Data flow**: It ignores the incoming request details, sleeps for two seconds, and then returns an empty list of resource templates. If this method is called during a supposedly quick tools-only status request, the response would be too slow.

**Call relations**: The rmcp framework would call this only if the app server asks for resource templates. The tools-and-auth-only test is built so this method should not be reached.

*Call graph*: 3 external calls (from_secs, new, sleep).


##### `mcp_server_status_list_tools_and_auth_only_skips_slow_inventory_calls`  (lines 315–372)

```
async fn mcp_server_status_list_tools_and_auth_only_skips_slow_inventory_calls() -> Result<()>
```

**Purpose**: This test checks that a status request asking only for tools and authentication-related information does not also fetch slow resource data. It protects the user experience: a quick status view should not hang because an unrelated inventory call is slow.

**Data flow**: It starts a slow fake MCP server, writes app configuration pointing at it, initializes the test app server, and sends a status-list request with the detail level set to ToolsAndAuthOnly. It waits only a short time for the response. The expected response contains the tool, but has empty resource and resource-template lists, showing that the slow resource methods were skipped.

**Call relations**: The async test runner invokes this test. It uses start_slow_inventory_mcp_server to create the special delayed MCP endpoint. During the app server’s status lookup, SlowInventoryServer::list_tools should be called, while SlowInventoryServer::list_resources and SlowInventoryServer::list_resource_templates should not be needed.

*Call graph*: calls 2 internal fn (new, start_slow_inventory_mcp_server); 13 external calls (new, from_millis, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format! (+3 more)).


##### `mcp_server_status_list_keeps_tools_for_sanitized_name_collisions`  (lines 375–451)

```
async fn mcp_server_status_list_keeps_tools_for_sanitized_name_collisions() -> Result<()>
```

**Purpose**: This test guards against losing tools when two server names look similar after internal cleanup. For example, “some-server” and “some_server” must remain distinct in the status response.

**Data flow**: It starts two temporary MCP servers, one with a dash-related tool name and one with an underscore-related tool name. It writes both servers into the temporary config, starts the app server, asks for MCP status, and groups the response by server name. The expected output has two separate entries, each with its own tool.

**Call relations**: The async test runner invokes this test. It calls start_mcp_server twice to create two local MCP endpoints. The app server contacts both endpoints, and the test checks that the final status response preserves the one-to-one connection between each configured server name and its advertised tool.

*Call graph*: calls 2 internal fn (new, start_mcp_server); 12 external calls (new, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format!, read_to_string (+2 more)).


##### `start_mcp_server`  (lines 453–473)

```
async fn start_mcp_server(tool_name: &str) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: This helper starts a small local MCP server for tests. It saves each test from having to repeat the networking setup needed to expose a fake server over HTTP.

**Data flow**: It takes a tool name. It binds a TCP listener to localhost on an automatically chosen free port, stores the tool name in shared memory, builds an HTTP MCP service that creates McpStatusServer instances, mounts that service at /mcp, and spawns the server in the background. It returns the base URL and a task handle that the test can abort during cleanup.

**Call relations**: The status tests call this when they need a normal fast MCP server. The spawned server later routes MCP framework calls to McpStatusServer::get_info and McpStatusServer::list_tools when the app server connects.

*Call graph*: called by 3 (mcp_server_status_list_keeps_tools_for_sanitized_name_collisions, mcp_server_status_list_returns_raw_server_and_tool_names, mcp_server_status_list_uses_thread_project_local_config); 9 external calls (new, default, new, default, new, bind, serve, format!, spawn).


##### `start_slow_inventory_mcp_server`  (lines 475–495)

```
async fn start_slow_inventory_mcp_server(tool_name: &str) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: This helper starts a local MCP server whose resource inventory calls are intentionally slow. It is used to prove that the app server can avoid slow work when a request only needs tool information.

**Data flow**: It takes a tool name, opens a local TCP listener on a free port, wraps the tool name so background server instances can share it safely, builds an HTTP MCP service backed by SlowInventoryServer, mounts it at /mcp, and runs it in a spawned background task. It returns the server’s base URL plus the task handle for cleanup.

**Call relations**: The tools-and-auth-only test calls this to create the delayed test endpoint. When the app server contacts that endpoint, the rmcp framework can call SlowInventoryServer::get_info and list_tools, while the test is designed to show that the slow resource-listing methods are skipped.

*Call graph*: called by 1 (mcp_server_status_list_tools_and_auth_only_skips_slow_inventory_calls); 9 external calls (new, default, new, default, new, bind, serve, format!, spawn).


### `app-server/tests/suite/v2/mcp_tool.rs`

`test` · `test execution`

These tests build a small fake MCP tool server and then ask the app server to use it, much like setting up a pretend vending machine to check whether the app can press the right buttons and read what comes back. The fake server exposes one tool, an echo tool, but it can behave in several useful ways: it can return a normal result, ask the user for confirmation, ask the user to visit a login URL, or return a very large response. The tests check all of those paths.

The file matters because MCP tool calls cross several boundaries at once: the app server must read configuration, connect over HTTP, attach the right thread information, send tool arguments, receive tool output, and sometimes pause while the MCP server asks the client a question. If this bridge breaks, tools might fail silently, return the wrong data, lose user approval prompts, or flood the client with oversized output.

The helper type `ToolAppsMcpServer` is the fake MCP server used by the tests. `start_mcp_server` launches it on a local temporary port. The individual tests then create a temporary app-server home directory, write test configuration, start a test app server, and send JSON-RPC style requests, meaning structured request-and-response messages encoded as JSON. The final helper waits until a specific MCP tool call is reported as completed.

#### Function details

##### `mcp_server_tool_call_returns_tool_result`  (lines 73–159)

```
async fn mcp_server_tool_call_returns_tool_result() -> Result<()>
```

**Purpose**: This test checks the happy path: the app server calls an MCP tool and returns the tool's text, structured data, and metadata to the client. It proves that a configured MCP server can be reached and that results are translated into the app server's protocol correctly.

**Data flow**: It starts a mock model-response server and a local fake MCP server, writes a temporary configuration that points to both, and starts the test app server. It opens a new thread, sends a tool-call request with the message "hello from app", then reads the app server's response. The expected output is one text item saying "echo: hello from app", structured JSON showing the echoed message and thread id, a non-error flag, and metadata saying the call came from the MCP app.

**Call relations**: This test calls `start_mcp_server` to create the fake external tool service, then drives `TestAppServer` as a client would. The fake server's `ToolAppsMcpServer::call_tool` produces the echo result, and the test verifies that the app server forwards that result back without losing important fields.

*Call graph*: calls 3 internal fn (new, start_mcp_server, start_mock_server); 12 external calls (new, default, new, Integer, to_response, write_mock_responses_config_toml, assert_eq!, format!, json!, read_to_string (+2 more)).


##### `mcp_server_tool_call_returns_error_for_unknown_thread`  (lines 162–188)

```
async fn mcp_server_tool_call_returns_error_for_unknown_thread() -> Result<()>
```

**Purpose**: This test checks that the app server rejects an MCP tool call for a thread that does not exist. It protects against tool calls being run without a valid conversation context.

**Data flow**: It creates a temporary app server with no started thread, then sends a tool-call request using a made-up thread id. Instead of a normal response, it reads an error message from the stream. The test passes only if the error text says the thread was not found.

**Call relations**: Unlike the other tool-call tests, this one does not start the fake MCP server because the request should fail before any outside tool is contacted. It verifies the app server's first gate: checking that the conversation thread exists before dispatching work.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, json!, timeout).


##### `mcp_server_tool_call_round_trips_elicitation`  (lines 191–298)

```
async fn mcp_server_tool_call_round_trips_elicitation() -> Result<()>
```

**Purpose**: This test checks that a tool can ask the client a form-style question and then continue after the client answers. In MCP this is called elicitation, which means the tool pauses to request extra user input or approval.

**Data flow**: It starts the mock response server, the fake MCP server, and the test app server with the fake MCP server in its configuration. It starts a thread, then calls the echo tool with the special message "confirm". The fake tool turns that into a request asking, "Allow this request?" with a boolean field named `confirmed`. The test reads that server-to-client request, replies with acceptance and `confirmed: true`, then waits for the original tool call to finish. The final output should be text saying "accepted".

**Call relations**: This test depends on `start_mcp_server` to run the fake MCP service. Inside that service, `ToolAppsMcpServer::call_tool` notices the trigger message and asks its peer for elicitation. The app server must convert that MCP elicitation into its own client-facing request, accept the test's reply, and deliver the answer back to the MCP tool so the original call can complete.

*Call graph*: calls 3 internal fn (new, start_mcp_server, start_mock_server); 18 external calls (new, new, default, builder, Boolean, new, Integer, to_response, write_mock_responses_config_toml, assert_eq! (+8 more)).


##### `mcp_server_tool_call_forwards_url_elicitation`  (lines 301–401)

```
async fn mcp_server_tool_call_forwards_url_elicitation() -> Result<()>
```

**Purpose**: This test checks that a tool can ask the client to open or approve a URL-based flow, such as a login page. It makes sure the app server forwards the URL, message, and elicitation id correctly.

**Data flow**: It sets up the mock response server, fake MCP server, temporary configuration, and test app server. After starting a thread, it calls the tool with the special message "auth". The fake tool asks for URL elicitation with a GitHub-style login message, a URL, and an id. The test verifies that the app server sends the client the same information, replies with acceptance, and then checks that the tool call finishes with text saying "accepted".

**Call relations**: This follows the same larger path as the form elicitation test, using `start_mcp_server` and the fake server's `ToolAppsMcpServer::call_tool`. The difference is the kind of prompt being forwarded: the app server must carry a URL prompt rather than a form schema, then return the client's decision to the tool.

*Call graph*: calls 3 internal fn (new, start_mcp_server, start_mock_server); 14 external calls (new, default, new, Integer, to_response, write_mock_responses_config_toml, assert_eq!, format!, json!, panic! (+4 more)).


##### `mcp_tool_call_completion_notification_contains_truncated_large_result`  (lines 404–534)

```
async fn mcp_tool_call_completion_notification_contains_truncated_large_result() -> Result<()>
```

**Purpose**: This test checks that very large MCP tool results are shortened before they appear in completion notifications. That prevents huge tool output from overwhelming the client or making stored conversation items too large.

**Data flow**: It prepares a mock model response that asks the app server to call the MCP tool with the special message "large". The fake MCP server returns oversized text and structured data. The test starts a thread and a turn, waits for the matching MCP tool-call completion notification, and inspects the completed item. The expected result is marked completed, has no error, and contains a text representation that mentions truncation and stays under the expected size limits. The test also serializes the item to make sure the whole JSON form remains bounded.

**Call relations**: This test uses `start_mcp_server` to provide the fake tool and `wait_for_mcp_tool_call_completed` to ignore unrelated item notifications until the specific tool call appears. The fake server's `ToolAppsMcpServer::call_tool` creates the oversized response, while the app server is responsible for trimming it before sending the completion notification.

*Call graph*: calls 3 internal fn (new, start_mcp_server, wait_for_mcp_tool_call_completed); 17 external calls (new, default, new, Integer, create_mock_responses_server_sequence, to_response, write_mock_responses_config_toml, assert!, assert_eq!, format! (+7 more)).


##### `ToolAppsMcpServer::get_info`  (lines 540–542)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: This method tells MCP clients what the fake server can do. Here it advertises that the server supports tools.

**Data flow**: It receives no meaningful input beyond the fake server object itself. It builds a server information value with tool support enabled and returns that to whoever is connecting.

**Call relations**: The MCP service calls this when a client, in these tests the app server, connects and asks about capabilities. Its answer allows the app server to discover that it can list and call tools on this test server.

*Call graph*: 2 external calls (builder, new).


##### `ToolAppsMcpServer::list_tools`  (lines 544–572)

```
async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData>
```

**Purpose**: This method describes the fake server's available tool. It exposes one read-only echo tool that accepts a JSON object with an optional string message.

**Data flow**: It ignores pagination and request context, builds a JSON input schema describing the accepted `message` field, creates a tool named `echo_tool`, marks it read-only, and returns it in a tool list. If the schema cannot be built, it returns an MCP internal error.

**Call relations**: The app server calls this during MCP discovery so it knows which tools are available. Later tests rely on this advertised tool name when they ask the app server to call `echo_tool`.

*Call graph*: 7 external calls (new, Borrowed, new, json!, new, from_value, vec!).


##### `ToolAppsMcpServer::call_tool`  (lines 574–665)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, rmcp::ErrorData>
```

**Purpose**: This method is the fake tool's behavior for all of the tests. Depending on the incoming `message`, it either echoes text, returns a huge result, asks for a form confirmation, or asks for a URL-based approval.

**Data flow**: It receives a tool-call request and request context from the MCP framework. It checks that the requested tool name is the expected test tool, reads the `message` argument, and reads the thread id from context metadata. For a normal message, it returns text plus structured JSON and metadata. For the large-message trigger, it returns deliberately oversized content. For the confirmation trigger, it asks the client for a boolean form answer and returns text based on accept, decline, or cancel. For the URL trigger, it asks the client to approve a login URL and returns text based on the answer.

**Call relations**: The local MCP service invokes this whenever the app server calls the fake tool. It is the source of the different scenarios that the tests assert: normal results, large-result truncation, form elicitation, and URL elicitation.

*Call graph*: 9 external calls (new, builder, new, Boolean, assert_eq!, json!, structured, success, vec!).


##### `start_mcp_server`  (lines 668–683)

```
async fn start_mcp_server() -> Result<(String, JoinHandle<()>)>
```

**Purpose**: This helper starts the fake MCP server on a local random port for tests that need a real HTTP endpoint. It returns the base URL and a task handle that the test can stop later.

**Data flow**: It binds a TCP listener to localhost with port `0`, which asks the operating system to choose an unused port. It creates an MCP HTTP service backed by `ToolAppsMcpServer`, mounts it under `/mcp`, starts an Axum web server in a background Tokio task, and returns the URL plus the background task handle.

**Call relations**: The main MCP integration tests call this during setup before they write app-server configuration. The returned URL is inserted into the temporary config, and the returned handle is aborted at the end of each test so the temporary server does not keep running.

*Call graph*: called by 4 (mcp_server_tool_call_forwards_url_elicitation, mcp_server_tool_call_returns_tool_result, mcp_server_tool_call_round_trips_elicitation, mcp_tool_call_completion_notification_contains_truncated_large_result); 9 external calls (new, default, new, default, new, bind, serve, format!, spawn).


##### `wait_for_mcp_tool_call_completed`  (lines 685–703)

```
async fn wait_for_mcp_tool_call_completed(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemCompletedNotification>
```

**Purpose**: This helper waits until the app server reports that a specific MCP tool call has completed. It filters the stream so a test does not accidentally react to the wrong notification.

**Data flow**: It repeatedly reads `item/completed` notifications from the test app server, with a timeout each time. If a notification has no parameters, it skips it. If it has parameters, it turns them from JSON into an `ItemCompletedNotification` and checks whether the item is an MCP tool call with the requested id. When it finds the matching call, it returns that completed notification.

**Call relations**: The large-result test calls this after starting a turn that should trigger an MCP tool call. This helper sits between the noisy notification stream and the test assertion, handing back only the completion event for the call id the test cares about.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (mcp_tool_call_completion_notification_contains_truncated_large_result); 3 external calls (matches!, from_value, timeout).


### `app-server/tests/suite/v2/mcp_server_elicitation.rs`

`test` · `integration test run`

This is an integration test for MCP elicitation. MCP, or Model Context Protocol, is a way for the app server to talk to external tools. “Elicitation” means the tool pauses and asks the user or client for a piece of information, like “Allow this request?” Without this test, a connector tool might ask for confirmation but the app server could fail to show that question to the client, fail to send the answer back, or resume the model turn in the wrong order.

The test sets up two fake services. One fake service pretends to be the model provider and streams three responses: a warmup message, a tool call, and a final completion. The other fake service pretends to be an Apps MCP server with a calendar connector. That calendar tool asks for a boolean confirmation before returning its result.

The test then starts a real test app server, writes temporary configuration and authentication files, starts a thread, warms up connector discovery, and sends a user message that references the calendar app. When the model requests the calendar tool, the fake MCP server asks for confirmation. The app server turns that into a JSON-RPC request to the client. The test replies “accepted” with `confirmed: true`, then checks that the app server reports the request as resolved before the turn completes. Finally, it checks that the model received the tool output as expected.

#### Function details

##### `mcp_server_elicitation_round_trip`  (lines 76–300)

```
async fn mcp_server_elicitation_round_trip() -> Result<()>
```

**Purpose**: This is the main end-to-end test. It proves that a calendar MCP tool can ask the client for confirmation, receive the answer, return tool output, and let the model turn finish successfully.

**Data flow**: It starts with temporary fake servers, temporary configuration, and fake ChatGPT authentication. It sends thread and turn requests into the test app server, waits for responses and notifications, answers the elicitation request with `confirmed: true`, and then inspects both the app server messages and the fake model-provider requests. The final result is either success, meaning the full round trip worked, or a test failure showing where the contract broke.

**Call relations**: This test drives the whole file. It calls `start_apps_server` to create the fake Apps MCP server and `write_config_toml` to point the app server at the fake services. It also uses the response mock server to script model behavior, then watches the app server stream for the elicitation request, the request-resolved notification, and the completed turn.

*Call graph*: calls 6 internal fn (new, new, start_apps_server, write_config_toml, mount_sse_sequence, start_mock_server); 18 external calls (new, default, builder, Boolean, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq! (+8 more)).


##### `ElicitationAppsMcpServer::get_info`  (lines 312–315)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: This tells MCP clients what this fake server can do. In this test, it announces that the server supports tools and uses the expected MCP protocol version.

**Data flow**: It receives no meaningful input beyond the server object itself. It builds a small server information object with tool capability enabled and returns that to whoever is connecting over MCP.

**Call relations**: The fake MCP service created in `start_apps_server` uses this method during MCP setup. It is part of making the test server look like a real Apps MCP server before tools are listed or called.

*Call graph*: 2 external calls (builder, new).


##### `ElicitationAppsMcpServer::list_tools`  (lines 317–347)

```
async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData>
```

**Purpose**: This advertises one fake calendar tool to the app server. The tool is marked as read-only and tagged with connector metadata so the app server can associate it with the calendar app.

**Data flow**: It receives the tool-list request and request context, but does not need details from either one. It creates an empty-object input schema, builds a tool named `calendar_confirm_action`, adds calendar connector metadata, and returns a list containing that one tool.

**Call relations**: After `start_apps_server` registers `ElicitationAppsMcpServer` with the HTTP MCP service, the app server can call this method while discovering available connector tools. The tool it returns is the one later invoked during `mcp_server_elicitation_round_trip`.

*Call graph*: 8 external calls (new, Borrowed, new, new, json!, new, from_value, vec!).


##### `ElicitationAppsMcpServer::call_tool`  (lines 349–384)

```
async fn call_tool(
        &self,
        _request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, rmcp::ErrorData>
```

**Purpose**: This is the fake calendar tool’s behavior. Instead of doing real calendar work, it asks the client to confirm the action and then returns text saying whether the request was accepted, declined, or cancelled.

**Data flow**: It receives a tool-call request and an MCP request context. It builds a schema asking for one boolean field named `confirmed`, sends an elicitation request through the MCP peer, waits for the response, checks that an accepted response contains `confirmed: true`, and returns a tool result such as the text `accepted`.

**Call relations**: This method is reached when the model’s streamed response asks to call the calendar tool advertised by `list_tools`. Its elicitation request is the key event that `mcp_server_elicitation_round_trip` expects the app server to forward to the client; once the test client answers, this method produces the tool output that is sent back to the model.

*Call graph*: 6 external calls (new, builder, Boolean, assert_eq!, success, vec!).


##### `start_apps_server`  (lines 387–416)

```
async fn start_apps_server() -> Result<(String, JoinHandle<()>)>
```

**Purpose**: This starts a local fake Apps server for the test. It serves both connector-directory endpoints and an MCP endpoint, so the app server can discover the calendar connector and call its tool.

**Data flow**: It creates expected authentication values, binds a local TCP port, builds an MCP HTTP service around `ElicitationAppsMcpServer`, and creates an Axum router with directory-list routes plus the MCP service path. It returns the base URL and a background task handle, which the test later aborts for cleanup.

**Call relations**: `mcp_server_elicitation_round_trip` calls this during setup. The router it creates sends directory requests to `list_directory_connectors` and MCP tool traffic to the `ElicitationAppsMcpServer` methods.

*Call graph*: called by 1 (mcp_server_elicitation_round_trip); 10 external calls (new, default, new, default, new, bind, get, serve, format!, spawn).


##### `list_directory_connectors`  (lines 418–458)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<serde_json::Value>, StatusCode>
```

**Purpose**: This is the fake Apps directory endpoint. It returns one calendar connector only when the app server sends the expected token, account id, and query option.

**Data flow**: It receives shared server state, HTTP headers, and the request URI. It checks the authorization header, the `chatgpt-account-id` header, and whether the query includes `external_logos=true`. If authentication fails it returns unauthorized, if the query is wrong it returns bad request, and otherwise it returns JSON describing the calendar connector.

**Call relations**: The router built in `start_apps_server` uses this function for both directory-list routes. During the main test, the app server calls these routes while discovering available apps before it tries to use the calendar tool.

*Call graph*: 4 external calls (get, query, Json, json!).


##### `write_config_toml`  (lines 460–489)

```
fn write_config_toml(
    codex_home: &std::path::Path,
    responses_server_uri: &str,
    apps_server_url: &str,
) -> std::io::Result<()>
```

**Purpose**: This writes the temporary configuration file that makes the app server talk to the fake services instead of real external systems. It also turns on the apps feature needed by the test.

**Data flow**: It receives a temporary Codex home directory, the fake model-provider URL, and the fake Apps server URL. It formats those values into a `config.toml` file with mock model settings, app support enabled, file-based OAuth credentials, and retry counts set to zero, then writes that file to disk.

**Call relations**: `mcp_server_elicitation_round_trip` calls this before starting the test app server. The configuration it writes is what connects the later thread and turn requests to the mock response server and the fake Apps MCP server.

*Call graph*: called by 1 (mcp_server_elicitation_round_trip); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/mcp_resource.rs`

`test` · `test run`

This is a test file for MCP resource reading. MCP, or Model Context Protocol, is a standard way for a tool server to offer named resources, a bit like a library catalog where each item has an address and contents. These tests create a fake Codex Apps MCP server, point a real test app server at it, and then verify that resource reading works end to end.

The fake server offers a normal text-and-binary resource, plus a paginated list of skill-like resources. A “skill” here is a packaged prompt/resource that can be shown to the model when the user asks for it. The tests check that the app server discovers only valid skill resources, escapes descriptions safely, includes the right instructions, reads referenced skill files, caches repeated reads, and refreshes discovery after MCP reload.

The file also protects against two important mistakes. First, if a local executor is present, orchestrator-only skills must not be exposed to the model. Second, if a client asks to read a resource for a thread that does not exist, the server must return a clear error instead of silently continuing. The helper types count calls to the fake MCP server so the tests can prove caching and refresh behavior, not just final output.

#### Function details

##### `mcp_resource_read_returns_resource_contents`  (lines 87–128)

```
async fn mcp_resource_read_returns_resource_contents() -> Result<()>
```

**Purpose**: This test proves that a resource read request through the app server returns the exact text and binary contents supplied by an MCP server. It checks the normal end-to-end path with an existing thread.

**Data flow**: It starts a mock model server, starts the fake Apps MCP server, and starts a test app server configured to use both. It creates a thread, sends a resource-read request for the test URI, then compares the returned response with the expected text and blob contents. At the end it stops the fake Apps MCP server task.

**Call relations**: This test relies on start_resource_apps_mcp_server to provide the fake MCP resource provider and start_resource_test_app_server to build a configured app server. It then uses the app server test client to send requests and uses expected_resource_read_response as the trusted shape of the answer.

*Call graph*: calls 3 internal fn (start_resource_apps_mcp_server, start_resource_test_app_server, start_mock_server); 5 external calls (default, Integer, to_response, assert_eq!, timeout).


##### `orchestrator_skill_can_read_referenced_resource_without_an_executor`  (lines 131–364)

```
async fn orchestrator_skill_can_read_referenced_resource_without_an_executor() -> Result<()>
```

**Purpose**: This test checks that orchestrator-provided skills can be discovered and used even when no executor environment is attached to the thread. It also verifies that a skill can read a referenced resource and that repeated reads are cached.

**Data flow**: It starts fake model and Apps MCP servers, creates a thread with an empty environment list, and feeds the mock model a planned sequence of responses: list skills, read a skill reference, read it again, and finish. The test then inspects the model requests to confirm the skill catalog was added, the skill body was included, the reference read output was returned, and the repeated read matched the cached result. It also compares server call counters before and after an MCP reload to prove what was fetched again.

**Call relations**: This is the broadest test in the file. It uses start_resource_apps_mcp_server for fake resource discovery, start_resource_test_app_server for the app server setup, and ResourceAppsMcpCalls::snapshot to check how often the fake MCP server was contacted. It indirectly exercises ResourceAppsMcpServer::list_resources and ResourceAppsMcpServer::read_resource through the running HTTP MCP service.

*Call graph*: calls 4 internal fn (start_resource_apps_mcp_server, start_resource_test_app_server, mount_sse_sequence, start_mock_server); 9 external calls (default, new, Integer, to_response, assert!, assert_eq!, format!, timeout, vec!).


##### `local_executor_does_not_expose_orchestrator_skills`  (lines 367–437)

```
async fn local_executor_does_not_expose_orchestrator_skills() -> Result<()>
```

**Purpose**: This test makes sure orchestrator-only skills are not shown to the model when the thread is using the normal local executor setup. That prevents skills meant for one authority from leaking into the wrong execution mode.

**Data flow**: It starts the fake model server, fake Apps MCP server, and configured test app server. It creates a normal thread, sends a user message asking for the test skill, then inspects the single model request. The expected result is that no skills tools are available and no skill name or skill body appears in the messages sent to the model.

**Call relations**: Like the other end-to-end tests, it uses start_resource_apps_mcp_server and start_resource_test_app_server for setup. It contrasts with orchestrator_skill_can_read_referenced_resource_without_an_executor by proving that the same fake skill source is ignored in a different thread mode.

*Call graph*: calls 5 internal fn (start_resource_apps_mcp_server, start_resource_test_app_server, mount_sse_once, sse, start_mock_server); 6 external calls (default, Integer, to_response, assert!, timeout, vec!).


##### `mcp_resource_read_returns_resource_contents_without_thread`  (lines 440–490)

```
async fn mcp_resource_read_returns_resource_contents_without_thread() -> Result<()>
```

**Purpose**: This test proves that clients can read an MCP resource without tying the request to a particular conversation thread. That matters for simple resource browsing or UI features that happen outside an active thread.

**Data flow**: It starts the fake Apps MCP server, writes a temporary app-server configuration and authentication file, initializes a test app server, and sends a resource-read request with no thread ID. The response is decoded and compared with the same expected text-and-blob resource contents used by the threaded test.

**Call relations**: It uses start_resource_apps_mcp_server for the fake MCP endpoint and expected_resource_read_response for the expected result. Unlike mcp_resource_read_returns_resource_contents, it builds the test configuration directly in the test because it does not need the mock model provider.

*Call graph*: calls 3 internal fn (new, new, start_resource_apps_mcp_server); 7 external calls (new, Integer, write_chatgpt_auth, assert_eq!, format!, write, timeout).


##### `mcp_resource_read_returns_error_for_unknown_thread`  (lines 493–553)

```
async fn mcp_resource_read_returns_error_for_unknown_thread() -> Result<()>
```

**Purpose**: This test checks the failure path for a resource-read request that names a thread ID the app server does not know. The correct behavior is a clear “thread not found” error.

**Data flow**: It creates a temporary configuration, starts the app server in-process, sends a resource-read request with a made-up thread ID, then shuts the server down. Instead of accepting any successful response, it extracts the error and checks that the message says the thread was not found.

**Call relations**: This test does not start the fake Apps MCP server because the request should fail before any resource server is contacted. It uses the in-process app server startup path so the negative test can run without an external child process.

*Call graph*: calls 5 internal fn (start, default, without_managed_config_for_tests, default_for_tests, new); 8 external calls (new, new, new, bail!, Integer, default, assert!, default).


##### `start_resource_test_app_server`  (lines 555–599)

```
async fn start_resource_test_app_server(
    apps_server_url: &str,
    responses_server_uri: &str,
) -> Result<(TempDir, TestAppServer)>
```

**Purpose**: This helper creates a temporary app-server home directory configured for these resource and skill tests. It saves the test from repeating setup code for config files, authentication, and initialization.

**Data flow**: It receives the fake Apps MCP server URL and mock model server URL. It writes a config file that enables Apps and skill instructions, writes fake ChatGPT authentication data, starts a TestAppServer from that temporary directory, waits for initialization, and returns both the temporary directory and the running test client.

**Call relations**: The main end-to-end tests call this after starting their fake servers. It prepares the app server so those tests can focus on user-level actions such as starting threads, sending turns, and reading resources.

*Call graph*: calls 2 internal fn (new, new); called by 3 (local_executor_does_not_expose_orchestrator_skills, mcp_resource_read_returns_resource_contents, orchestrator_skill_can_read_referenced_resource_without_an_executor); 5 external calls (new, write_chatgpt_auth, format!, write, timeout).


##### `start_resource_apps_mcp_server`  (lines 601–624)

```
async fn start_resource_apps_mcp_server() -> Result<(String, Arc<ResourceAppsMcpCalls>, JoinHandle<()>)>
```

**Purpose**: This helper starts a small fake Codex Apps MCP server over HTTP. It gives the tests a predictable resource provider without depending on a real external service.

**Data flow**: It binds a local TCP port, creates shared counters for resource-list and resource-read calls, wraps ResourceAppsMcpServer in an MCP HTTP service, mounts that service under the expected Apps path, and spawns an Axum web server task. It returns the server URL, the shared call counters, and the task handle so tests can stop it later.

**Call relations**: Most tests call this before starting the app server, because the app server configuration needs the URL. The spawned service uses ResourceAppsMcpServer::get_info, ResourceAppsMcpServer::list_resources, and ResourceAppsMcpServer::read_resource when the app server talks to it.

*Call graph*: called by 4 (local_executor_does_not_expose_orchestrator_skills, mcp_resource_read_returns_resource_contents, mcp_resource_read_returns_resource_contents_without_thread, orchestrator_skill_can_read_referenced_resource_without_an_executor); 11 external calls (clone, new, default, new, default, new, bind, default, serve, format! (+1 more)).


##### `expected_resource_read_response`  (lines 626–643)

```
fn expected_resource_read_response() -> McpResourceReadResponse
```

**Purpose**: This helper builds the exact resource-read response that the tests expect for the normal test URI. It keeps the expected text and binary contents in one place.

**Data flow**: It reads the file-level test constants for the text resource URI, blob resource URI, MIME types, text body, and base64 blob body. It returns an McpResourceReadResponse containing one text item and one blob item.

**Call relations**: The resource-read tests use this helper when comparing actual app-server responses. It mirrors the normal-resource branch of ResourceAppsMcpServer::read_resource.

*Call graph*: 1 external calls (vec!).


##### `ResourceAppsMcpCalls::snapshot`  (lines 653–659)

```
fn snapshot(&self) -> ResourceAppsMcpCallCounts
```

**Purpose**: This method captures the current fake MCP server call counts in an easy-to-compare struct. Tests use it to prove how many times resources were listed or read.

**Data flow**: It reads three atomic counters: resource-list calls, main skill prompt reads, and reference reads. It copies those numbers into a ResourceAppsMcpCallCounts value, leaving the original counters unchanged.

**Call relations**: The orchestrator skill test calls this after model turns and after MCP reload. The counters are increased by ResourceAppsMcpServer::list_resources and ResourceAppsMcpServer::read_resource while the fake server is serving requests.

*Call graph*: 1 external calls (load).


##### `ResourceAppsMcpServer::get_info`  (lines 675–678)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: This method tells MCP clients what the fake server supports. In this test server, it advertises resource support and a specific MCP protocol version.

**Data flow**: It takes no outside input beyond the server object itself. It builds and returns ServerInfo saying that resources are enabled and that the server speaks the 2025-06-18 protocol version.

**Call relations**: The MCP service created in start_resource_apps_mcp_server uses this when a client initializes or inspects the fake server. It allows the app server under test to treat the fake server like a real resource-capable MCP server.

*Call graph*: 2 external calls (builder, new).


##### `ResourceAppsMcpServer::list_resources`  (lines 680–726)

```
async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, rmcp::ErrorData>
```

**Purpose**: This method provides a paginated fake resource catalog for the tests. It is designed to include one ignored resource, one valid skill resource, and then a simulated later-page failure.

**Data flow**: It receives optional pagination information from the MCP request and increments the list counter. With no cursor, it returns an ignored non-skill resource and a cursor for the next page. With the skills-page cursor, it returns the valid demo skill and a cursor for a failing page. With the failing-page cursor, it returns an internal error; any other cursor returns an invalid-parameter error.

**Call relations**: The app server reaches this through the fake MCP service started by start_resource_apps_mcp_server. The orchestrator skill test depends on this staged catalog to check filtering, warning creation, pagination, and call counts.

*Call graph*: 3 external calls (internal_error, invalid_params, vec!).


##### `ResourceAppsMcpServer::read_resource`  (lines 728–777)

```
async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, rmcp::ErrorData>
```

**Purpose**: This method returns fake resource contents for the URIs used in the tests. It covers the skill main prompt, a skill reference document, and the ordinary text-plus-binary test resource.

**Data flow**: It receives a resource URI and checks it against known constants. For the skill main prompt it increments the main-prompt counter and returns the skill markdown. For the reference URI it increments the reference counter and returns the reference text. For the normal test URI it returns both a markdown text resource and a base64-encoded binary resource. Any unknown URI becomes a resource-not-found error.

**Call relations**: The app server calls this indirectly through the fake MCP HTTP service. The resource-read tests verify its normal test-resource output, while the orchestrator skill test uses its skill prompt and reference branches and then checks the counters through ResourceAppsMcpCalls::snapshot.

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

**Purpose**: This helper builds a Resource entry for the fake MCP catalog. It packages the URI, display name, description, MIME type, and skill metadata into the format expected by the MCP library.

**Data flow**: It receives string fields describing one resource. It creates a raw resource with description and MIME type, attaches metadata produced by skill_resource_meta, wraps it as a Resource, and returns it.

**Call relations**: ResourceAppsMcpServer::list_resources uses this to create both the ignored resource and the valid skill resource. It delegates metadata creation to skill_resource_meta so the plugin and skill names are encoded consistently.

*Call graph*: calls 1 internal fn (skill_resource_meta); 2 external calls (new, new).


##### `skill_resource_meta`  (lines 797–802)

```
fn skill_resource_meta(plugin_name: &str, skill_name: &str) -> Meta
```

**Purpose**: This helper creates the metadata attached to a fake skill resource. The metadata names the plugin and the skill so the app server can recognize and label the skill correctly.

**Data flow**: It receives a plugin name and a skill name. It puts them into a small JSON-style map under plugin_name and skill_name, wraps that map as MCP Meta data, and returns it.

**Call relations**: skill_resource calls this whenever it builds a catalog resource. The app server later reads this metadata from the fake MCP listing while deciding whether a resource is a usable skill.

*Call graph*: called by 1 (skill_resource); 3 external calls (json!, Meta, from_iter).


### Command and shell execution
These tests validate the app server's command-execution surfaces, including generic command RPCs, thread shell commands, and the specialized zsh-fork turn-start path.

### `app-server/tests/suite/v2/command_exec.rs`

`test` · `test run`

This is a safety net for one of the app server's most sensitive abilities: running commands on the user's machine. If this behavior is wrong, clients might get stuck processes, miss command output, bypass permission settings, or accidentally leave long-running jobs behind. The tests start a temporary app server setup, send JSON-RPC requests (a request-and-response message format using JSON), and then check that the replies and notifications match what a real client would need.

The file covers two styles of command execution. In the older buffered style, the server waits for the command to finish and returns all stdout and stderr in the final response. In the streaming style, the server sends output as small `command/exec/outputDelta` notifications while the command is still running, a bit like watching text appear in a terminal window. The tests also cover writing to stdin, using a TTY (a terminal-like session), resizing that terminal, and stopping a running command.

Several tests focus on boundaries and safety: bad option combinations are rejected, environment variables are merged or unset correctly, permission profiles are honored, network proxy settings do not leak between profiles, and process IDs only work on the connection that created them. Helper functions at the bottom collect streamed output, edit temporary config files, and wait for real operating-system processes to appear or disappear.

#### Function details

##### `command_exec_without_streams_can_be_terminated`  (lines 41–88)

```
async fn command_exec_without_streams_can_be_terminated() -> Result<()>
```

**Purpose**: Tests that a non-streaming command with a client-supplied process ID can still be stopped before it finishes. This matters because even commands that do not stream output should not become impossible to cancel.

**Data flow**: It starts a temporary test server, sends a long `sleep 30` command, then sends a terminate request for the same process ID. It expects the terminate request to return success, and the original command to finish with a non-zero exit code and no captured output.

**Call relations**: This test uses the shared test server setup helpers, sends command requests through `TestAppServer`, and converts the final JSON response with `to_response`. It does not use this file's streaming helpers because the command deliberately has streaming turned off.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, assert_ne!, timeout, vec!).


##### `command_exec_without_process_id_keeps_buffered_compatibility`  (lines 91–135)

```
async fn command_exec_without_process_id_keeps_buffered_compatibility() -> Result<()>
```

**Purpose**: Tests that the old buffered command behavior still works when no process ID is provided. This preserves compatibility for clients that only want a simple final result.

**Data flow**: It runs a shell command that writes one string to stdout and another to stderr. The server returns one final `CommandExecResponse`, and the test checks that the exit code is zero and both text buffers are present.

**Call relations**: This follows the common pattern of creating a temporary config, initializing `TestAppServer`, sending `command/exec`, and decoding the final response. It stands apart from the streaming tests by confirming that no process ID is still valid for non-streaming use.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_env_overrides_merge_with_server_environment_and_support_unset`  (lines 138–194)

```
async fn command_exec_env_overrides_merge_with_server_environment_and_support_unset() -> Result<()>
```

**Purpose**: Tests how requested environment variables combine with the server's existing environment. It proves that a command can override a variable, add a new one, and remove one for the child process.

**Data flow**: It starts the test app with one baseline environment variable, then sends a command with an `env` map that changes that variable, adds another, and unsets `RUST_LOG`. The command prints the resulting values, and the test checks that the output reflects the requested merge plus the server-provided `CODEX_HOME`.

**Call relations**: This uses `TestAppServer::new_with_env` to shape the server-side starting environment before calling `command/exec`. The result is read through the same buffered-response path used by other non-streaming tests.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 9 external calls (from, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_accepts_permission_profile`  (lines 197–241)

```
async fn command_exec_accepts_permission_profile() -> Result<()>
```

**Purpose**: Tests that `command/exec` accepts a named permission profile. A permission profile is a predefined set of rules that says what the command may access.

**Data flow**: It sends a simple command with the built-in read-only permission profile selected. The command prints `profile`, and the test expects a normal successful response with that output.

**Call relations**: This is an acceptance test for the parameter itself. Later tests in the same file check more detailed permission-profile behavior, including network proxy and filesystem-root effects.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_permission_profile_starts_selected_network_proxy`  (lines 244–292)

```
async fn command_exec_permission_profile_starts_selected_network_proxy() -> Result<()>
```

**Purpose**: Tests that choosing a permission profile with network access starts the matching network proxy. The proxy is represented here by an environment marker exposed to the command.

**Data flow**: It edits the temporary config to add a `networked` profile, runs a command under that profile, and has the command print `CODEX_NETWORK_PROXY_ACTIVE` or `unset`. The expected output is `1`, meaning the selected profile activated the proxy.

**Call relations**: This test relies on `insert_networked_permission_profile_config` to add the special profile to the test config. It then uses the normal command execution path and checks the buffered response.

*Call graph*: calls 3 internal fn (new, insert_networked_permission_profile_config, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_permission_profile_does_not_reuse_default_network_proxy`  (lines 295–340)

```
async fn command_exec_permission_profile_does_not_reuse_default_network_proxy() -> Result<()>
```

**Purpose**: Tests that a network proxy enabled for the default permission profile does not accidentally apply to a different selected profile. This prevents permission settings from leaking between profiles.

**Data flow**: It configures `networked` as the default profile, then explicitly runs the command under the built-in read-only profile. The command prints whether the network proxy marker is set, and the test expects `unset`.

**Call relations**: Like the previous network-proxy test, it uses `insert_networked_permission_profile_config`, but it selects a different profile at request time. The contrast between the two tests verifies that profile choice is respected per command.

*Call graph*: calls 3 internal fn (new, insert_networked_permission_profile_config, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_permission_profile_project_roots_use_command_cwd`  (lines 344–402)

```
async fn command_exec_permission_profile_project_roots_use_command_cwd() -> Result<()>
```

**Purpose**: Tests that workspace-root permissions are based on the command's working directory, not simply the server's own current directory. This matters because a command run in a subfolder should not automatically gain write access to its parent.

**Data flow**: It creates a `command-cwd` directory and configures a profile that allows writes to workspace roots. The command runs from that directory, writes `child.txt` inside it, and attempts to write `../parent.txt`; the test expects the child file to exist and the parent file not to exist.

**Call relations**: This Unix-only test uses `insert_command_exec_config` to add a custom filesystem permission profile. It then exercises the same `command/exec` request path, but with a non-default `cwd` and a permission profile.

*Call graph*: calls 3 internal fn (new, insert_command_exec_config, create_config_toml); 10 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, create_dir, timeout, vec!).


##### `command_exec_returns_error_when_local_environment_is_disabled`  (lines 405–441)

```
async fn command_exec_returns_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: Tests that command execution fails cleanly when the local execution environment is disabled. Instead of trying to run a command anyway, the server should tell the client what is wrong.

**Data flow**: It starts the app with the execution-server URL environment variable set to `none`, then sends a simple `true` command. The result is an error response whose message must be `local environment is not configured`.

**Call relations**: This uses `TestAppServer::new_with_env` to simulate a disabled local environment. It reads an error message rather than decoding a normal `CommandExecResponse`.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_sandbox_policy_with_permission_profile`  (lines 444–479)

```
async fn command_exec_rejects_sandbox_policy_with_permission_profile() -> Result<()>
```

**Purpose**: Tests that callers cannot provide both a sandbox policy and a permission profile in the same command request. These are two different ways to describe safety rules, and mixing them would be ambiguous.

**Data flow**: It sends a command with `sandboxPolicy` set to full access and `permissionProfile` set to read-only. The server rejects the request and returns the exact expected validation error.

**Call relations**: This is one of several parameter-validation tests. It uses the normal initialized test server, but expects `read_stream_until_error_message` instead of a successful command result.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_disable_timeout_with_timeout_ms`  (lines 482–517)

```
async fn command_exec_rejects_disable_timeout_with_timeout_ms() -> Result<()>
```

**Purpose**: Tests that a command cannot both set a timeout and say that timeouts are disabled. This catches a contradictory request before any process is started.

**Data flow**: It sends a command with `disable_timeout` set to true and `timeout_ms` set to 1000. The server returns an error explaining that both options cannot be set together.

**Call relations**: This belongs to the validation group of tests. It follows the same setup as other command tests, then checks the server's error response.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_disable_output_cap_with_output_bytes_cap`  (lines 520–555)

```
async fn command_exec_rejects_disable_output_cap_with_output_bytes_cap() -> Result<()>
```

**Purpose**: Tests that a command cannot both set a maximum output size and say that the output cap is disabled. The two options conflict, so the server should reject them.

**Data flow**: It sends a command with `output_bytes_cap` set to 1024 and `disable_output_cap` set to true. The expected result is a validation error naming those two conflicting options.

**Call relations**: This is another request-shape validation test. It does not need to observe a running process because the request should fail before execution starts.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_negative_timeout_ms`  (lines 558–593)

```
async fn command_exec_rejects_negative_timeout_ms() -> Result<()>
```

**Purpose**: Tests that negative timeout values are rejected. A timeout is a duration, so a negative number would not make sense.

**Data flow**: It sends a command request with `timeout_ms` set to `-1`. The server responds with an error saying the timeout must be non-negative.

**Call relations**: This uses the same validation-test pattern as the conflicting-option tests: initialize the test app, send a deliberately bad request, and assert the exact error message.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_without_process_id_rejects_streaming`  (lines 596–631)

```
async fn command_exec_without_process_id_rejects_streaming() -> Result<()>
```

**Purpose**: Tests that streaming output requires a client-supplied process ID. The process ID is how later output, writes, resizes, and termination requests are tied to the right running command.

**Data flow**: It sends a `cat` command with streaming enabled but no `process_id`. The server rejects the request with an error saying that TTY or streaming mode requires a process ID.

**Call relations**: This bridges validation and streaming behavior. It confirms that the server enforces the identifier needed by the streaming helpers and follow-up command APIs.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_non_streaming_respects_output_cap`  (lines 634–678)

```
async fn command_exec_non_streaming_respects_output_cap() -> Result<()>
```

**Purpose**: Tests that non-streaming command output is trimmed to the requested byte cap. This prevents huge stdout or stderr from being returned in one large response.

**Data flow**: It runs a command that prints six characters to stdout and six to stderr, while setting the output cap to five bytes. The final response should contain only the first five characters from each stream.

**Call relations**: This uses buffered command execution and `to_response` to inspect the final result. It complements the streaming cap test, which checks live output behavior instead of final buffering.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_streaming_does_not_buffer_output`  (lines 681–742)

```
async fn command_exec_streaming_does_not_buffer_output() -> Result<()>
```

**Purpose**: Tests that streamed command output is sent as live notifications and not repeated in the final response. This avoids sending the same data twice to streaming clients.

**Data flow**: It starts a command that prints text and then sleeps, with streaming enabled and an output cap of five bytes. The test collects output notifications until stdout is capped at `abcde`, terminates the command, then checks that the final response has empty stdout and stderr.

**Call relations**: This test calls `collect_command_exec_output_until` through the `Mcp` reader path to watch notifications. It then uses the terminate request and final response path to confirm the command's end state.

*Call graph*: calls 3 internal fn (new, collect_command_exec_output_until, create_config_toml); 10 external calls (new, new, Integer, Mcp, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, assert_ne!, timeout, vec!).


##### `command_exec_pipe_streams_output_and_accepts_write`  (lines 745–818)

```
async fn command_exec_pipe_streams_output_and_accepts_write() -> Result<()>
```

**Purpose**: Tests a pipe-style command that streams stdout and stderr and also accepts input from the client. This models an interactive process that waits for the user to type something.

**Data flow**: It starts a shell command that prints initial stdout and stderr, reads one line from stdin, then echoes that line to both streams. The test waits for the initial output, sends base64-encoded `hello\n`, closes stdin, waits for the echoed output, and expects a successful final response with no buffered output.

**Call relations**: This uses `wait_for_command_exec_outputs_contains` to observe streamed output before and after the write request. It verifies that `command/exec/write` works together with a streaming `command/exec` process.

*Call graph*: calls 3 internal fn (new, wait_for_command_exec_outputs_contains, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_tty_implies_streaming_and_reports_pty_output`  (lines 821–889)

```
async fn command_exec_tty_implies_streaming_and_reports_pty_output() -> Result<()>
```

**Purpose**: Tests that requesting a TTY creates a real terminal-like session and automatically produces streamed output. A TTY, or pseudo-terminal, is needed for programs that behave differently when attached to a terminal.

**Data flow**: It starts a shell command that checks whether stdin is a terminal, waits for a line, and prints it back. The test waits for `tty\n`, sends base64-encoded `world\n`, then waits for `echo:world\n` and confirms the final response is successful with empty buffered output.

**Call relations**: This uses `wait_for_command_exec_output_contains` twice to observe the TTY output. It also exercises `command/exec/write`, showing that TTY mode supports interactive input.

*Call graph*: calls 3 internal fn (new, wait_for_command_exec_output_contains, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_tty_supports_initial_size_and_resize`  (lines 892–977)

```
async fn command_exec_tty_supports_initial_size_and_resize() -> Result<()>
```

**Purpose**: Tests that a TTY starts with the requested rows and columns and can be resized while the command is running. This matters for full-screen or layout-sensitive terminal programs.

**Data flow**: It starts a TTY command with an initial size of 31 rows by 101 columns and prints `stty size`. After seeing that size in streamed output, it sends a resize request to 45 by 132, writes a line to let the command continue, and checks that the command reports the new size.

**Call relations**: This test combines `command/exec`, `command/exec/resize`, `command/exec/write`, and the streamed-output helper. It confirms that terminal sizing information flows from client requests into the running process.

*Call graph*: calls 3 internal fn (new, wait_for_command_exec_output_contains, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process`  (lines 980–1062)

```
async fn command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process() -> Result<()>
```

**Purpose**: Tests that process IDs belong only to the WebSocket connection that created them, and that closing that connection stops its running command. This prevents one client from controlling another client's process and avoids orphaned processes.

**Data flow**: It starts a real WebSocket app-server process, connects two clients, and starts a long-running command from the first client using process ID `shared-process`. The second client tries to terminate that same ID and receives an error. Then the first client disconnects, and the test waits until the operating-system process disappears.

**Call relations**: This is the broadest integration test in the file. It uses WebSocket helpers, `read_initialize_response`, `collect_command_exec_output_until` with the WebSocket reader path, `wait_for_process_marker`, and `assert_no_message` to verify connection isolation and cleanup.

*Call graph*: calls 10 internal fn (collect_command_exec_output_until, read_initialize_response, wait_for_process_marker, assert_no_message, connect_websocket, create_config_toml, read_jsonrpc_message, send_initialize_request, send_request, spawn_websocket_server); 9 external calls (from_millis, new, new, Integer, Websocket, create_mock_responses_server_sequence_unchecked, assert_eq!, format!, json!).


##### `read_command_exec_delta`  (lines 1064–1071)

```
async fn read_command_exec_delta(
    mcp: &mut TestAppServer,
) -> Result<CommandExecOutputDeltaNotification>
```

**Purpose**: Reads the next `command/exec/outputDelta` notification from the in-process test app connection. An output delta is one small chunk of stdout or stderr from a running command.

**Data flow**: It asks `TestAppServer` to wait until a notification with method `command/exec/outputDelta` arrives. It then passes that notification to `decode_delta_notification`, which turns the JSON into a typed Rust value.

**Call relations**: This is used by `collect_command_exec_output_until` when the reader is the `Mcp` test-app connection. It is the local-server counterpart to `read_command_exec_delta_ws`.

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

**Purpose**: Waits until one chosen output stream, stdout or stderr, contains a specific piece of text. It gives tests a simple way to wait for live command output before taking the next action.

**Data flow**: It receives a test app connection, process ID, stream choice, and expected text. It calls `collect_command_exec_output_until`, accumulating deltas until the selected stream contains the expected text, then returns success.

**Call relations**: TTY-related tests call this helper when they need to wait for one specific stdout message. It delegates all actual notification reading and timeout behavior to `collect_command_exec_output_until`.

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

**Purpose**: Waits until stdout contains one expected string and stderr contains another. This is useful for commands that produce both kinds of output before the test can continue.

**Data flow**: It takes a test app connection, process ID, expected stdout text, and expected stderr text. It collects streamed deltas until both accumulated buffers contain their expected values.

**Call relations**: The pipe-streaming test uses this before and after writing to stdin. Like the single-stream helper, it relies on `collect_command_exec_output_until` for the loop, decoding, and timeout.

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

**Purpose**: Collects streamed command output until a caller-provided condition says to stop. It is the main reusable tool for watching live stdout and stderr in these tests.

**Data flow**: It receives a reader, a process ID, a human-readable description of what it is waiting for, and a stop-check function. Until the timeout expires, it reads output deltas, verifies they belong to the expected process, decodes their base64 text, removes carriage returns, appends text to stdout or stderr, and returns the accumulated output once the stop condition is true.

**Call relations**: Streaming tests and waiting helpers call this function. Depending on the reader variant, it hands off to `read_command_exec_delta` for `TestAppServer` connections or `read_command_exec_delta_ws` for raw WebSocket connections.

*Call graph*: calls 2 internal fn (read_command_exec_delta, read_command_exec_delta_ws); called by 4 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, command_exec_streaming_does_not_buffer_output, wait_for_command_exec_output_contains, wait_for_command_exec_outputs_contains); 6 external calls (now, into, from_utf8, default, assert_eq!, timeout).


##### `read_command_exec_delta_ws`  (lines 1169–1181)

```
async fn read_command_exec_delta_ws(
    stream: &mut super::connection_handling_websocket::WsClient,
) -> Result<CommandExecOutputDeltaNotification>
```

**Purpose**: Reads the next command-output notification from a raw WebSocket client. It skips over unrelated JSON-RPC messages until it finds the output delta notification.

**Data flow**: It repeatedly reads JSON-RPC messages from the WebSocket. When it sees a notification whose method is `command/exec/outputDelta`, it decodes the notification into a typed output-delta value and returns it.

**Call relations**: This is called by `collect_command_exec_output_until` for WebSocket-based tests. It mirrors `read_command_exec_delta`, but works with the lower-level WebSocket test client.

*Call graph*: calls 2 internal fn (decode_delta_notification, read_jsonrpc_message); called by 1 (collect_command_exec_output_until).


##### `decode_delta_notification`  (lines 1183–1190)

```
fn decode_delta_notification(
    notification: JSONRPCNotification,
) -> Result<CommandExecOutputDeltaNotification>
```

**Purpose**: Turns a raw JSON-RPC output notification into a `CommandExecOutputDeltaNotification` value that tests can inspect safely. This keeps JSON parsing in one place.

**Data flow**: It receives a JSON-RPC notification, checks that it has `params`, and deserializes those parameters into the expected command-output-delta type. If the params are missing or malformed, it returns an error with context.

**Call relations**: Both notification readers call this function after finding a `command/exec/outputDelta` message. The collecting helper then uses the decoded process ID, stream name, base64 data, and cap flag.

*Call graph*: called by 2 (read_command_exec_delta, read_command_exec_delta_ws); 1 external calls (from_value).


##### `insert_networked_permission_profile_config`  (lines 1192–1215)

```
fn insert_networked_permission_profile_config(
    codex_home: &Path,
    default_permissions: Option<&str>,
) -> Result<()>
```

**Purpose**: Adds a network-enabled permission profile to the temporary test config file. This lets tests check whether selecting that profile starts the network proxy.

**Data flow**: It receives the temporary `codex_home` path and an optional default profile name. It builds a TOML config snippet enabling the network proxy feature and defining a `networked` profile, then inserts that snippet into the config file.

**Call relations**: The two network-proxy permission-profile tests call this helper. It delegates the actual file editing to `insert_command_exec_config`.

*Call graph*: calls 1 internal fn (insert_command_exec_config); called by 2 (command_exec_permission_profile_does_not_reuse_default_network_proxy, command_exec_permission_profile_starts_selected_network_proxy); 1 external calls (format!).


##### `insert_command_exec_config`  (lines 1217–1227)

```
fn insert_command_exec_config(codex_home: &Path, inserted_config: &str) -> Result<()>
```

**Purpose**: Inserts extra TOML configuration into the generated test config file at a known safe location. This is how tests customize permissions without rewriting the whole config by hand.

**Data flow**: It reads `config.toml` from the temporary home directory, finds the mock provider section marker, places the supplied config text before that marker, and writes the modified file back to disk.

**Call relations**: Permission-profile tests call this directly or through `insert_networked_permission_profile_config`. It supports tests that need custom command-exec settings before the app server starts.

*Call graph*: called by 2 (command_exec_permission_profile_project_roots_use_command_cwd, insert_networked_permission_profile_config); 4 external calls (join, format!, read_to_string, write).


##### `read_initialize_response`  (lines 1229–1241)

```
async fn read_initialize_response(
    stream: &mut super::connection_handling_websocket::WsClient,
    request_id: i64,
) -> Result<()>
```

**Purpose**: Waits for the response to a specific WebSocket initialize request. Initialization is the handshake that gets a client ready to talk to the app server.

**Data flow**: It reads JSON-RPC messages from the WebSocket until it sees a response whose ID matches the requested initialize ID. It ignores unrelated messages and returns once the matching response arrives.

**Call relations**: The connection-scoping test uses this after sending initialize requests for two WebSocket clients. It depends on the shared `read_jsonrpc_message` helper from the WebSocket test support module.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 1 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process); 1 external calls (Integer).


##### `wait_for_process_marker`  (lines 1243–1255)

```
async fn wait_for_process_marker(marker: &str, should_exist: bool) -> Result<()>
```

**Purpose**: Waits until an operating-system process containing a unique marker either appears or disappears. This gives the test evidence that a real child process is alive or has been terminated.

**Data flow**: It receives a marker string and a boolean saying whether the process should exist. Until a five-second deadline, it repeatedly calls `process_with_marker_exists`; if the expected state appears, it returns, otherwise it sleeps briefly and tries again. If the deadline passes, it returns an error.

**Call relations**: The connection-scoping test uses this to confirm that the first WebSocket client's command is running, still running after the second client fails to terminate it, and gone after the first client disconnects.

*Call graph*: calls 1 internal fn (process_with_marker_exists); called by 1 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `process_with_marker_exists`  (lines 1257–1264)

```
fn process_with_marker_exists(marker: &str) -> Result<bool>
```

**Purpose**: Checks the system process list for a command line containing a unique marker string. It is a small operating-system probe used by the process-cleanup test.

**Data flow**: It runs `ps -axo command`, decodes the command-list output as UTF-8 text, and returns true if any line contains the marker. It returns errors if spawning `ps` or decoding its output fails.

**Call relations**: Only `wait_for_process_marker` calls this function. Together they let the WebSocket disconnect test observe real process lifetime from outside the app server.

*Call graph*: called by 1 (wait_for_process_marker); 2 external calls (from_utf8, new).


### `app-server/tests/suite/v2/thread_shell_command.rs`

`test` · `test run`

These tests protect a feature where a client can ask the app server to run a local shell command inside an existing conversation thread. In plain terms, the server is acting like a chat app that also has a small terminal attached. The tests make sure that terminal output is reported live, but does not pollute the normal conversation history later.

The file sets up temporary Codex homes and workspaces, writes a small test configuration, starts a test app server, and talks to it through the same request and notification protocol a real client would use. It uses a mock model server so the tests do not depend on a real AI service.

The main cases cover three important promises. First, when a user shell command runs and finishes, the client sees start, output, and completion notifications, but later calls such as reading the thread, listing turns, or forking the thread do not include command execution items. Second, if the local execution environment is deliberately disabled, the command request returns a clear error instead of trying to run anything. Third, if an assistant turn is already active, a user shell command is attached to that same turn rather than creating confusing extra history. Helper functions wait for specific stream notifications, build cross-platform shell commands, and write the test config file.

#### Function details

##### `thread_shell_command_history_responses_exclude_persisted_command_executions`  (lines 47–181)

```
async fn thread_shell_command_history_responses_exclude_persisted_command_executions() -> Result<()>
```

**Purpose**: This test checks the full life of a user shell command: it starts, streams output, completes successfully, and then is hidden from normal saved thread history. Someone would use this test to catch regressions where terminal command records accidentally appear in conversation reads, turn lists, or forked threads.

**Data flow**: It creates temporary folders, writes a test config, starts a test server, and opens a new thread. It builds a shell command that prints known text, sends that command to the server, waits for the start, output, and completion notifications, and compares them with the expected command source, status, output, and exit code. After the command finishes, it reads the thread, lists its turns, and forks it; in each returned set of turn items it verifies that command execution items have been removed.

**Call relations**: This is one of the main scenario tests in the file. It relies on create_config_toml to make a usable test configuration, current_shell_output_command to produce a command that works on the current operating system shell, the wait_for_command_execution_* helpers to listen to server notifications, and assert_no_command_executions to check the history-filtering rule.

*Call graph*: calls 7 internal fn (new, assert_no_command_executions, create_config_toml, current_shell_output_command, wait_for_command_execution_completed, wait_for_command_execution_output_delta, wait_for_command_execution_started); 11 external calls (default, default, new, Integer, default, create_mock_responses_server_sequence, assert_eq!, create_dir, timeout, unreachable! (+1 more)).


##### `thread_shell_command_returns_error_when_local_environment_is_disabled`  (lines 184–224)

```
async fn thread_shell_command_returns_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: This test proves that shell commands fail safely when local command execution has been turned off. It matters because the server should not silently run commands if the local execution service is unavailable or intentionally disabled.

**Data flow**: It creates a temporary Codex home, writes config pointing to a mock model provider, and starts the test app server with an environment variable set so the execution server URL is effectively disabled. It starts a thread, asks the server to run `pwd`, then reads the error response. The expected result is the clear message: `local environment is not configured`.

**Call relations**: This is a negative-path test. It uses create_config_toml for setup and TestAppServer::new_with_env to start the server with the special environment override. Unlike the other scenario tests, it does not wait for command notifications because no command should actually start.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 9 external calls (default, new, Integer, default, create_mock_responses_server_sequence, assert_eq!, create_dir, timeout, vec!).


##### `thread_shell_command_uses_existing_active_turn`  (lines 227–377)

```
async fn thread_shell_command_uses_existing_active_turn() -> Result<()>
```

**Purpose**: This test checks that a user-triggered shell command joins the currently active turn when the assistant is already working. This prevents the conversation timeline from splitting into confusing separate turns for work that happened at the same time.

**Data flow**: It creates temporary folders, writes config, and prepares mock assistant responses that include an assistant-requested command needing approval. It starts a thread and begins a turn with user text, then waits until the assistant command appears and the server asks the client to approve it. While that turn is still active, it sends a user shell command, waits for that command to start and complete, and checks that its notifications use the same turn id as the active assistant turn. It then declines the assistant command, waits for the turn to complete, reads the thread, and confirms that command execution items are excluded from returned history.

**Call relations**: This is the concurrency-style scenario in the file: an assistant command and a user shell command overlap in the same turn. It uses current_shell_output_command to make a portable user command, wait_for_command_execution_started to catch the assistant command, wait_for_command_execution_started_by_source to find the user command specifically, wait_for_command_execution_completed to confirm it finished, and assert_no_command_executions to verify the later read response stays clean.

*Call graph*: calls 7 internal fn (new, assert_no_command_executions, create_config_toml, current_shell_output_command, wait_for_command_execution_completed, wait_for_command_execution_started, wait_for_command_execution_started_by_source); 14 external calls (default, default, new, Integer, default, create_mock_responses_server_sequence, assert_eq!, panic!, from_value, to_value (+4 more)).


##### `assert_no_command_executions`  (lines 379–386)

```
fn assert_no_command_executions(items: &[ThreadItem], context: &str)
```

**Purpose**: This helper checks that a list of thread items contains no command execution records. It gives the tests a single readable way to express the rule that command runs should not appear in returned conversation history.

**Data flow**: It receives a slice of thread items and a short context label such as `thread/read`. It scans every item and fails the test if any item is a command execution, using the context label in the failure message so the broken API path is easy to identify. It returns nothing when the list is clean.

**Call relations**: The two history-focused tests call this helper after reading, listing, or forking a thread. It does not call back into the server; it only inspects data that the scenario tests have already received.

*Call graph*: called by 2 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn); 1 external calls (assert!).


##### `current_shell_output_command`  (lines 388–404)

```
fn current_shell_output_command(text: &str) -> Result<(String, String)>
```

**Purpose**: This helper builds a simple shell command that prints a chosen piece of text, in a way that works on the current user shell. It avoids making the tests depend on Unix-only command syntax when they may run on Windows shells too.

**Data flow**: It receives the text that should be printed. It asks what the default user shell is, then chooses the right command form: PowerShell uses `Write-Output`, Windows `cmd` uses `echo`, and other shells use `printf` with safe quoting. It returns both the command string to run and the exact output string the test should expect, including the right line ending for that shell.

**Call relations**: The shell-command scenario tests call this before sending a user shell command to the app server. Its output feeds directly into the request body, and its expected output is later compared with streamed and aggregated command output.

*Call graph*: calls 1 internal fn (default_user_shell); called by 2 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn); 2 external calls (format!, try_quote).


##### `wait_for_command_execution_started`  (lines 406–426)

```
async fn wait_for_command_execution_started(
    mcp: &mut TestAppServer,
    expected_id: Option<&str>,
) -> Result<ItemStartedNotification>
```

**Purpose**: This helper waits until the server reports that a command execution item has started. It can wait for any command, or for one with a specific id.

**Data flow**: It receives the test app server connection and an optional expected command id. It repeatedly reads `item/started` notifications from the stream, converts each notification body into a structured item-started message, ignores anything that is not a command execution, and returns the first command execution whose id matches the request. The stream position advances as messages are consumed.

**Call relations**: The main tests use this helper after sending commands or starting assistant turns, because command start messages arrive asynchronously. wait_for_command_execution_started_by_source also builds on it, first finding command starts and then filtering by whether the source is the assistant or the user shell.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn, wait_for_command_execution_started_by_source); 1 external calls (from_value).


##### `wait_for_command_execution_started_by_source`  (lines 428–441)

```
async fn wait_for_command_execution_started_by_source(
    mcp: &mut TestAppServer,
    expected_source: CommandExecutionSource,
) -> Result<ItemStartedNotification>
```

**Purpose**: This helper waits for a command execution start notification from a particular source, such as the user shell rather than the assistant. It is useful when several command-related events may be happening in the same turn.

**Data flow**: It receives the test app server connection and the expected command source. It repeatedly calls wait_for_command_execution_started to get the next command-start notification, checks the item’s source field, and returns only when the source matches. Notifications from other sources are consumed and skipped.

**Call relations**: The active-turn test calls this after sending a user shell command while an assistant command is already pending. It lets the test focus on the user shell command without being confused by the earlier assistant command.

*Call graph*: calls 1 internal fn (wait_for_command_execution_started); called by 1 (thread_shell_command_uses_existing_active_turn).


##### `wait_for_command_execution_completed`  (lines 443–463)

```
async fn wait_for_command_execution_completed(
    mcp: &mut TestAppServer,
    expected_id: Option<&str>,
) -> Result<ItemCompletedNotification>
```

**Purpose**: This helper waits until the server reports that a command execution item has completed. It can wait for any completed command or for a specific command id.

**Data flow**: It receives the test app server connection and an optional expected command id. It repeatedly reads `item/completed` notifications, parses each notification body, skips non-command items, and returns the first command completion whose id matches the requested id if one was provided. The returned notification includes details such as final status, output, and exit code.

**Call relations**: The scenario tests call this after seeing a command start, so they can assert the final outcome. It pairs with wait_for_command_execution_started: one confirms the command entered the timeline, and the other confirms it finished with the expected result.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn); 1 external calls (from_value).


##### `wait_for_command_execution_output_delta`  (lines 465–482)

```
async fn wait_for_command_execution_output_delta(
    mcp: &mut TestAppServer,
    item_id: &str,
) -> Result<CommandExecutionOutputDeltaNotification>
```

**Purpose**: This helper waits for a live chunk of output from a specific command execution. It checks that streaming output is delivered before or during completion, not only stored at the end.

**Data flow**: It receives the test app server connection and the command item id to watch. It repeatedly reads `item/commandExecution/outputDelta` notifications, parses each one, and ignores output for other command ids. When it finds a delta for the requested command, it returns that output notification to the caller.

**Call relations**: The first scenario test uses this after the user command starts and before checking completion. That lets the test prove both halves of the behavior: live output is streamed to clients, and final aggregated output is also recorded in the completion notification.

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

**Purpose**: This helper writes the small `config.toml` file needed by the test app server. It points the server at the mock model provider and sets policy choices such as command approval behavior and feature flags.

**Data flow**: It receives the temporary Codex home path, the mock server URI, an approval policy string, and a map of feature flags. It turns enabled or disabled features into TOML lines, fills a configuration template with the model, provider URL, sandbox mode, approval policy, retry settings, and feature section, then writes the result to `config.toml` under the Codex home directory. It returns an I/O result showing whether the file write succeeded.

**Call relations**: All three scenario tests call this during setup before starting TestAppServer. The rest of each test depends on this file being present, because it tells the server to use the mock responses endpoint rather than a real model provider.

*Call graph*: called by 3 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_returns_error_when_local_environment_is_disabled, thread_shell_command_uses_existing_active_turn); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/turn_start_zsh_fork.rs`

`test` · `integration test run`

These are integration tests: they start a real test app server, point it at a fake model server, and watch the messages that come back. The goal is to prove that the “zsh fork” shell path behaves correctly when the model asks to run a command. A shell command here is not just a string; it becomes a visible thread item, may require user approval, may be interrupted, and may contain smaller subcommands that also need approval.

The tests build a temporary Codex home and workspace, copy the app server binary and a test zsh executable into a package-shaped folder, then write a test config file that turns the zsh-fork feature on. The fake model server returns scripted Server-Sent Events, meaning streamed model responses over HTTP. The test client then starts a thread, starts a turn, and reads JSON-RPC messages from the app server.

A useful analogy is a rehearsal stage: the fake model reads its lines, the app server performs the shell action, and the test watches whether the right permission prompts and completion messages appear. Without these tests, changes to command execution could silently break important safety behavior, such as declining a dangerous command or stopping a parent shell when a subcommand is rejected.

#### Function details

##### `turn_start_shell_zsh_fork_executes_command_v2`  (lines 50–176)

```
async fn turn_start_shell_zsh_fork_executes_command_v2() -> Result<()>
```

**Purpose**: This test proves that, when zsh-fork execution is enabled, a model-requested shell command is actually launched through the packaged zsh path. It also checks that an active command can be interrupted cleanly.

**Data flow**: It creates temporary folders for configuration and workspace, finds the test zsh executable, scripts a fake model response that asks to run a long-lived shell command, and writes a config enabling the zsh-fork feature. It starts the app server, starts a thread and turn, waits until a command-execution item appears, checks that the command string includes the packaged zsh and expected shell command, then interrupts the turn. The output is not a returned value but a passed test: the observed app-server messages match the expected behavior.

**Call relations**: This is one of the main test cases. It uses find_test_zsh_path to locate the zsh artifact, create_config_toml to write the test settings, and create_zsh_test_mcp_process to launch the app server in the right environment. It also depends on command_packaged_zsh_path indirectly through its assertion about the command path.

*Call graph*: calls 4 internal fn (create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path, sse); 16 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, create_shell_command_sse_response, assert!, assert_eq!, eprintln!, format! (+6 more)).


##### `turn_start_shell_zsh_fork_exec_approval_decline_v2`  (lines 179–312)

```
async fn turn_start_shell_zsh_fork_exec_approval_decline_v2() -> Result<()>
```

**Purpose**: This test checks the safety path where the app server asks the client for permission to run a shell command, and the client says no. It verifies that the command is marked as declined and does not produce an exit code or command output.

**Data flow**: It sets up a temporary Codex home and workspace, scripts the fake model to request a Python command, and writes a config with an approval policy that treats the command as untrusted. After starting a thread and turn, it waits for a command approval request from the app server, sends back a Decline decision, and then reads the completed command item. The before state is a pending command needing permission; the after state is a completed command item whose status is Declined, followed by turn completion.

**Call relations**: This test follows the same setup path as the other zsh-fork tests through find_test_zsh_path, create_config_toml, and create_zsh_test_mcp_process. It focuses on the approval-response branch where the app server receives a CommandExecutionApprovalDecision::Decline and must report the rejected command back to the client.

*Call graph*: calls 3 internal fn (create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path); 16 external calls (from, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, eprintln!, panic!, from_value (+6 more)).


##### `turn_start_shell_zsh_fork_exec_approval_cancel_v2`  (lines 315–443)

```
async fn turn_start_shell_zsh_fork_exec_approval_cancel_v2() -> Result<()>
```

**Purpose**: This test checks the slightly different safety path where the client cancels the approval prompt instead of simply declining it. It confirms that the command is still treated as declined, while the whole turn is marked as interrupted.

**Data flow**: It prepares a temporary test setup, scripts a fake model command, and starts the app server with zsh-fork enabled and approval required. When the app server asks for command approval, the test replies with Cancel. The command item changes from pending approval to Declined, and the turn completion message reports an Interrupted status.

**Call relations**: Like the other approval tests, it relies on find_test_zsh_path, create_config_toml, and create_zsh_test_mcp_process for setup. It then drives the app-server protocol by replying to the approval request, testing how the server translates a Cancel decision into both command and turn status.

*Call graph*: calls 3 internal fn (create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path); 15 external calls (from, default, new, Integer, create_mock_responses_server_sequence, assert_eq!, eprintln!, panic!, from_value, to_value (+5 more)).


##### `turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2`  (lines 446–740)

```
async fn turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2() -> Result<()>
```

**Purpose**: This test checks a more subtle safety case: a parent shell command contains multiple subcommands, and rejecting one subcommand should cause the parent command to be treated as declined or the turn to stop. This matters because dangerous work can be hidden inside a larger shell line.

**Data flow**: It creates two files, asks the fake model to run a shell command that removes both, and enables zsh-fork with approval checks. The test accepts the parent command and the first targeted remove subcommand, then cancels the second targeted remove subcommand. It records the approval IDs and command strings to confirm the two subcommands were separately noticed, then waits for either the parent command to complete as Declined or the turn to complete after interruption. The result is a passed test if rejection of the nested command is reflected in the parent command or turn outcome.

**Call relations**: This is the most complex test in the file. It uses find_test_zsh_path to locate zsh, supports_exec_wrapper_intercept to skip zsh builds that cannot intercept subcommands, create_config_toml for the feature setup, create_zsh_test_mcp_process to run the app server, and command_packaged_zsh_path to identify the parent zsh command in approval prompts.

*Call graph*: calls 6 internal fn (command_packaged_zsh_path, create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path, supports_exec_wrapper_intercept, sse); 22 external calls (from, default, new, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, assert_ne!, eprintln! (+12 more)).


##### `create_zsh_test_mcp_process`  (lines 742–755)

```
async fn create_zsh_test_mcp_process(
    codex_home: &Path,
    zdotdir: &Path,
    zsh_path: &Path,
) -> Result<TestAppServer>
```

**Purpose**: This helper starts a test app server that uses the packaged zsh copy prepared for these tests. It also sets ZDOTDIR, the directory zsh uses for startup files, so the shell starts in a controlled test workspace.

**Data flow**: It receives paths for the Codex home, zsh startup directory, and zsh executable. It first builds a package-like app-server layout with create_test_package_app_server, converts the zsh startup directory path to text, and then starts TestAppServer with an environment variable pointing zsh at that directory. It returns a running TestAppServer object that the tests can send protocol messages to.

**Call relations**: All four test cases call this after writing config and finding zsh. It hands off the actual process launch to TestAppServer::new_with_program_and_env, after create_test_package_app_server has prepared the files that process will run from.

*Call graph*: calls 2 internal fn (new_with_program_and_env, create_test_package_app_server); called by 4 (turn_start_shell_zsh_fork_exec_approval_cancel_v2, turn_start_shell_zsh_fork_exec_approval_decline_v2, turn_start_shell_zsh_fork_executes_command_v2, turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 2 external calls (as_str, to_string_lossy).


##### `create_test_package_app_server`  (lines 757–775)

```
fn create_test_package_app_server(codex_home: &Path, zsh_path: &Path) -> Result<PathBuf>
```

**Purpose**: This helper creates a small fake installed package inside the temporary Codex home. The package contains the app server binary and the zsh executable in the locations the production code expects.

**Data flow**: It takes the temporary Codex home and a source zsh path. It creates package and binary directories, computes where packaged zsh should live, writes a minimal package metadata file, copies the real app-server binary into the package, and copies the chosen zsh executable into the package resources. It returns the path to the copied app-server binary.

**Call relations**: create_zsh_test_mcp_process calls this before starting the test server. Inside, it uses packaged_zsh_path to choose the zsh destination and copy_with_permissions to copy binaries without losing executable permissions.

*Call graph*: calls 2 internal fn (copy_with_permissions, packaged_zsh_path); called by 1 (create_zsh_test_mcp_process); 5 external calls (join, bail!, cargo_bin, create_dir_all, write).


##### `packaged_zsh_path`  (lines 777–784)

```
fn packaged_zsh_path(codex_home: &Path) -> PathBuf
```

**Purpose**: This helper builds the path where the test package should place its zsh executable. It keeps all tests using the same expected package layout.

**Data flow**: It receives the Codex home path and appends the package resource folders ending in zsh/bin/zsh. It returns that full path without touching the disk.

**Call relations**: create_test_package_app_server uses it when copying zsh into the fake package. command_packaged_zsh_path also uses it before turning the path into a canonical, cleaned-up filesystem path for assertions.

*Call graph*: called by 2 (command_packaged_zsh_path, create_test_package_app_server); 1 external calls (join).


##### `command_packaged_zsh_path`  (lines 786–789)

```
fn command_packaged_zsh_path(codex_home: &Path) -> PathBuf
```

**Purpose**: This helper returns the packaged zsh path in the form most likely to appear in command strings. It canonicalizes the path when possible, meaning it resolves filesystem details such as symbolic links.

**Data flow**: It starts with the package path from packaged_zsh_path, asks the operating system for the canonical version, and falls back to the original path if canonicalization fails. It returns the path used for comparing against observed command text.

**Call relations**: The command-launch and subcommand tests use this when checking that approval prompts or command items refer to the packaged zsh, not some unrelated shell. It depends on packaged_zsh_path for the basic location.

*Call graph*: calls 1 internal fn (packaged_zsh_path); called by 1 (turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 1 external calls (canonicalize).


##### `copy_with_permissions`  (lines 791–794)

```
fn copy_with_permissions(source: &Path, destination: &Path) -> std::io::Result<()>
```

**Purpose**: This helper copies a file and then gives the copy the same filesystem permissions as the original. That is important for binaries, because a copied executable must still be runnable.

**Data flow**: It receives a source path and destination path. It copies the bytes from source to destination, reads the source file permissions, and applies those permissions to the destination. It returns success or an I/O error from the filesystem.

**Call relations**: create_test_package_app_server calls this twice: once for the app-server binary and once for the zsh executable. Without it, the test package might contain files that exist but cannot be executed.

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

**Purpose**: This helper writes the app server configuration file used by each test. It points the server at the fake model provider and turns selected feature flags on or off.

**Data flow**: It receives the Codex home, fake server URL, approval policy text, and a map of feature flags. It always disables remote models, adds the requested feature settings, translates feature IDs into config keys, and writes a config.toml file under the Codex home. Its visible output is that new configuration file on disk.

**Call relations**: Each test calls this before starting the app server, because the app server reads this file during startup. The helper is what makes the same binary run in a controlled test mode with zsh-fork enabled, unified exec disabled, shell snapshots disabled, and the model provider replaced by the mock server.

*Call graph*: called by 4 (turn_start_shell_zsh_fork_exec_approval_cancel_v2, turn_start_shell_zsh_fork_exec_approval_decline_v2, turn_start_shell_zsh_fork_executes_command_v2, turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 4 external calls (from, join, format!, write).


##### `find_test_zsh_path`  (lines 843–861)

```
fn find_test_zsh_path() -> Result<Option<std::path::PathBuf>>
```

**Purpose**: This helper locates the test zsh executable used by the suite. If the shared DotSlash artifact is unavailable, it returns no path so the zsh-fork tests can skip instead of failing for an environmental reason.

**Data flow**: It asks for the repository root, checks for the shared zsh DotSlash file, and uses the DotSlash fetch helper to resolve it into a real executable path. If the file is missing or fetching fails, it prints a message and returns None; otherwise it returns Some(path).

**Call relations**: All four tests call this near the start. Its result decides whether the test can run at all, and the returned path is later copied into the fake package by create_test_package_app_server through create_zsh_test_mcp_process.

*Call graph*: called by 4 (turn_start_shell_zsh_fork_exec_approval_cancel_v2, turn_start_shell_zsh_fork_exec_approval_decline_v2, turn_start_shell_zsh_fork_executes_command_v2, turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 3 external calls (repo_root, fetch_dotslash_file, eprintln!).


##### `supports_exec_wrapper_intercept`  (lines 863–873)

```
fn supports_exec_wrapper_intercept(zsh_path: &Path) -> bool
```

**Purpose**: This helper checks whether a particular zsh build supports intercepting executed subcommands through EXEC_WRAPPER. The subcommand-approval test needs that ability to observe and approve or reject nested commands.

**Data flow**: It runs the given zsh with a simple command while setting EXEC_WRAPPER to /usr/bin/false. If zsh honors the wrapper, the simple command fails; if it ignores the wrapper, the command succeeds. The function returns true only when the wrapper appears to affect execution.

**Call relations**: Only the subcommand-decline test calls this. If it returns false, that test skips, because the rest of the test would be asking zsh to report subcommands in a way that this zsh build cannot support.

*Call graph*: called by 1 (turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 1 external calls (new).


### Extension-backed tool execution
These suites cover built-in or extension-backed tool behaviors exposed through turns, including image generation, sleep, web search, and fuzzy file search sessions.

### `app-server/tests/suite/v2/imagegen_extension.rs`

`test` · `test execution`

These are integration tests: they start a real test app server, point it at a fake OpenAI-like server, and then watch the messages that pass between them. The goal is to prove that the image generation tool works in full, not just as isolated code.

The fake server plays two roles. First, it pretends to be the model stream, sending events such as “call the image tool” or “the assistant is done.” Second, it pretends to be the image backend, returning a tiny base64 image. The tests then start a thread and a turn, wait for image-generation completion notifications, and inspect what the app server reports back.

The file checks several important behaviors. A successful generated image should become a completed thread item, be saved to disk, and be sent back to the model with both image data and a visible path hint. A failed image request should still produce a final failed item, so clients do not wait forever. Image edits should use either an attached local image or a recent image URL. The tests also verify “code mode only,” where the image tool is exposed for generated code to call rather than as a normal direct tool.

Without these tests, changes to streaming, tool calling, file saving, or image attachment handling could silently break the image feature.

#### Function details

##### `standalone_image_generation_returns_saved_path_hint_to_model`  (lines 53–148)

```
async fn standalone_image_generation_returns_saved_path_hint_to_model() -> Result<()>
```

**Purpose**: This test proves that a normal image generation request succeeds end to end. It also checks that the model receives both the generated image data and a text hint telling it where the image was saved.

**Data flow**: It starts with a fake model server and a fake image-generation response containing a tiny base64 result. The test writes temporary config and authentication, starts the app server, begins a user turn asking for an image, then waits until an image-generation item is completed. It checks the completed item, reads the saved file from disk, and inspects the second model request to confirm that the image and saved-path hint were sent back.

**Call relations**: This is one of the top-level async tests. It uses create_config_toml to make the temporary app setup, mount_image_response to fake the image backend, start_image_generation_turn to begin the conversation, and wait_for_image_generation_completed to stop at the relevant completion notification.

*Call graph*: calls 8 internal fn (new, new_with_env, create_config_toml, mount_image_response, start_image_generation_turn, wait_for_image_generation_completed, mount_sse_sequence, start_mock_server); 7 external calls (new, write_chatgpt_auth, assert!, assert_eq!, panic!, timeout, vec!).


##### `standalone_image_generation_failure_emits_terminal_item`  (lines 151–226)

```
async fn standalone_image_generation_failure_emits_terminal_item() -> Result<()>
```

**Purpose**: This test proves that a failed image backend call still ends cleanly. Instead of hanging or disappearing, the app server should emit a final image-generation item marked as failed.

**Data flow**: It sets up the fake image endpoint to return an HTTP 500 error. Then it starts the app server, sends a user turn, waits for the image-generation completion notification, and compares it with the expected failed item. It also checks that the next request back to the model contains an error message about the failed image generation.

**Call relations**: This top-level test follows the same path as the success test, but swaps in a failing mock image endpoint. It relies on create_config_toml, start_image_generation_turn, and wait_for_image_generation_completed to drive the app and observe the result.

*Call graph*: calls 7 internal fn (new, new_with_env, create_config_toml, start_image_generation_turn, wait_for_image_generation_completed, mount_sse_sequence, start_mock_server); 10 external calls (given, new, new, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!, method, path).


##### `standalone_image_edit_uses_attached_model_visible_image`  (lines 229–255)

```
async fn standalone_image_edit_uses_attached_model_visible_image() -> Result<()>
```

**Purpose**: This test checks that image editing can use a local image attached by the user. It verifies that the local file is converted into a model-visible data URL before being sent to the image edit endpoint.

**Data flow**: It creates a tiny PNG file in the temporary test home and builds both the tool arguments and the user input that refers to that file. run_image_edit_test drives the server and returns the JSON body sent to the edit endpoint. The test then checks that the prompt is correct and that the first image URL is the expected base64 data URL.

**Call relations**: This is a small top-level test that delegates the shared setup and turn-running work to run_image_edit_test. Its job is to provide the local-image scenario and assert the outgoing edit request.

*Call graph*: calls 1 internal fn (run_image_edit_test); 1 external calls (assert_eq!).


##### `standalone_image_edit_uses_recent_pathless_image`  (lines 258–283)

```
async fn standalone_image_edit_uses_recent_pathless_image() -> Result<()>
```

**Purpose**: This test checks that image editing can use a recent image that has no local file path, only a URL. That matters for images that came from the conversation rather than from disk.

**Data flow**: It supplies a user input containing an image URL and tool arguments asking to include one recent image. run_image_edit_test runs the full flow and returns the JSON body sent to the edit endpoint. The test confirms that the prompt is preserved and that the edit request includes the original image URL.

**Call relations**: Like the attached-image edit test, this top-level test uses run_image_edit_test for the common app-server and mock-server work. It only changes the input shape to cover pathless, URL-based images.

*Call graph*: calls 1 internal fn (run_image_edit_test); 1 external calls (assert_eq!).


##### `standalone_image_generation_is_exposed_in_code_mode_only`  (lines 286–326)

```
async fn standalone_image_generation_is_exposed_in_code_mode_only() -> Result<()>
```

**Purpose**: This test proves that when image generation is configured as “code mode only,” the tool is still advertised to the model in the code-tool namespace. In plain terms, generated code can see the image tool even though direct use is restricted.

**Data flow**: It starts a fake model response that simply completes, writes config with code_mode_only enabled, starts the app server, and begins an image-generation turn. After completion, it inspects the single request sent to the fake model and checks that it mentions the code-mode image tool name.

**Call relations**: This top-level test uses create_config_toml with the CodeModeOnly setting and start_image_generation_turn to trigger a model request. It does not call the image backend; it only verifies that the tool is exposed in the request.

*Call graph*: calls 7 internal fn (new, new_with_env, create_config_toml, start_image_generation_turn, mount_sse_once, sse, start_mock_server); 5 external calls (new, write_chatgpt_auth, assert!, timeout, vec!).


##### `standalone_image_generation_is_callable_from_code_mode_only`  (lines 330–402)

```
async fn standalone_image_generation_is_callable_from_code_mode_only() -> Result<()>
```

**Purpose**: This test proves that the code-mode image tool can actually be called by generated code, not merely advertised. It is skipped on Windows by configuration in the source.

**Data flow**: It sets up a fake model stream where the model runs code that calls tools.image_gen__imagegen. The fake image backend returns a tiny image. After the app server finishes the turn, the test inspects the model requests and confirms that the tool was advertised first, then that the tool output contains image data, a saved-image message, and the expected number of output parts.

**Call relations**: This top-level test combines the code-mode exposure path with a real image-generation mock. It uses mount_image_response for the backend, create_config_toml for code-mode setup, and start_image_generation_turn to start the flow.

*Call graph*: calls 7 internal fn (new, new_with_env, create_config_toml, mount_image_response, start_image_generation_turn, mount_sse_sequence, start_mock_server); 6 external calls (new, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `start_image_generation_turn`  (lines 404–413)

```
async fn start_image_generation_turn(mcp: &mut TestAppServer) -> Result<()>
```

**Purpose**: This helper starts a standard test conversation where the user says “Generate an image.” It keeps the repeated test setup short and consistent.

**Data flow**: It receives a mutable test app server. It builds a simple text input message and passes it to start_turn. Nothing meaningful is returned beyond success or failure.

**Call relations**: Several image-generation tests call this helper when they do not need custom user input. It hands the actual thread and turn setup to start_turn.

*Call graph*: calls 1 internal fn (start_turn); called by 4 (standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_is_exposed_in_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model); 1 external calls (vec!).


##### `run_image_edit_test`  (lines 415–477)

```
async fn run_image_edit_test(
    input: impl FnOnce(&Path) -> Result<(serde_json::Value, Vec<V2UserInput>)>,
) -> Result<serde_json::Value>
```

**Purpose**: This helper runs the shared end-to-end flow for image edit tests. Each caller supplies the exact image-edit arguments and user inputs, while this function handles the fake servers, config, app startup, and result collection.

**Data flow**: It creates a fake server and a temporary app home, asks the caller-provided closure to build tool arguments and user input, then mounts a fake model stream and image-edit endpoint. It starts the app server, sends the turn, waits for image generation to complete, waits for the whole turn to finish, and finally returns the JSON body that was sent to the image edit endpoint.

**Call relations**: The two image-edit tests call this helper with different image sources. Internally it uses mount_image_edit_response, create_config_toml, start_turn, and wait_for_image_generation_completed to exercise the same app-server path each time.

*Call graph*: calls 8 internal fn (new, new_with_env, create_config_toml, mount_image_edit_response, start_turn, wait_for_image_generation_completed, mount_sse_sequence, start_mock_server); called by 2 (standalone_image_edit_uses_attached_model_visible_image, standalone_image_edit_uses_recent_pathless_image); 5 external calls (new, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `start_turn`  (lines 479–506)

```
async fn start_turn(mcp: &mut TestAppServer, input: Vec<V2UserInput>) -> Result<()>
```

**Purpose**: This helper creates a new thread and starts one turn inside it. A thread is the conversation container, and a turn is one user request plus the app server’s response work.

**Data flow**: It receives the test app server and a list of user inputs. It sends a thread-start request, waits for the matching response, extracts the new thread id, sends a turn-start request using that thread id and the provided input, then waits for the turn-start response. It returns success once the turn has officially begun.

**Call relations**: start_image_generation_turn uses this for the common “Generate an image” case, while run_image_edit_test uses it for custom edit inputs. It communicates with the app server through JSON-RPC request and response messages.

*Call graph*: calls 3 internal fn (read_stream_until_response_message, send_thread_start_request, send_turn_start_request); called by 2 (run_image_edit_test, start_image_generation_turn); 4 external calls (default, Integer, default, timeout).


##### `wait_for_image_generation_completed`  (lines 508–524)

```
async fn wait_for_image_generation_completed(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: This helper waits until the app server reports that an image-generation item has completed. It filters out other completed items that may appear in the stream first.

**Data flow**: It repeatedly reads item/completed notifications from the test app server. Each notification’s JSON parameters are decoded into an ItemCompletedNotification. If the completed item is an ImageGeneration item, it returns it; otherwise, it keeps waiting.

**Call relations**: The success, failure, and edit flows use this helper when they need to observe the image tool’s final state. It sits between starting a turn and checking the final assertions.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (run_image_edit_test, standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_returns_saved_path_hint_to_model); 2 external calls (matches!, from_value).


##### `mount_image_response`  (lines 526–536)

```
async fn mount_image_response(server: &MockServer)
```

**Purpose**: This helper teaches the fake server how to answer a successful image-generation request. It stands in for the real image backend during tests.

**Data flow**: It receives a mock server. It registers one expected POST request to the image generations path and configures the response as a JSON object containing the test base64 image result. It changes the mock server by adding this expectation.

**Call relations**: The successful direct-generation test and the code-mode callable test use this helper before starting the app server flow. When the app server later calls the image endpoint, this mock response is what it receives.

*Call graph*: called by 2 (standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model); 5 external calls (given, new, json!, method, path).


##### `mount_image_edit_response`  (lines 538–548)

```
async fn mount_image_edit_response(server: &MockServer)
```

**Purpose**: This helper teaches the fake server how to answer a successful image-edit request. It lets edit tests focus on what request was sent rather than on a real image service.

**Data flow**: It receives a mock server. It registers one expected POST request to the image edits path and configures a JSON response containing the test base64 image result. It updates the mock server with that expectation.

**Call relations**: run_image_edit_test calls this during setup. The app server later sends its edit request to this mounted fake endpoint, and the helper’s response lets the turn continue to completion.

*Call graph*: called by 1 (run_image_edit_test); 5 external calls (given, new, json!, method, path).


##### `create_config_toml`  (lines 550–584)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    mode: ImagegenTestMode,
) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary configuration file needed by the app server tests. It points the app at the fake server and turns on the image-generation extension.

**Data flow**: It receives the temporary home directory path, the fake server URL, and a mode saying whether image generation should be direct or code-mode-only. It builds a TOML configuration string with the model provider, retry settings, authentication requirements, and feature flags, then writes it to config.toml. It returns an I/O result showing whether the file write succeeded.

**Call relations**: Every top-level flow that starts a test app server calls this helper first. The app server reads the generated config during startup, so this function controls which fake backend and image mode the test uses.

*Call graph*: called by 5 (run_image_edit_test, standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_is_exposed_in_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/sleep.rs`

`test` · `test run`

This is an automated test for one small but important user-visible behavior: progress reporting. The app server can receive a tool call named “sleep”, which means “pause for this many milliseconds.” A client should not be left guessing while that happens. It should be told when the sleep begins and when it ends, much like a delivery app showing both “driver picked up your order” and “driver delivered it.”

The test builds a fake world around the server. It starts a mock model provider, teaches that mock provider to stream back a response containing a sleep function call, and writes a temporary configuration file that points the app server at the mock provider. It then starts a test app server, opens a thread, starts a turn with the user text “Sleep briefly,” and watches the server’s JSON-RPC message stream. JSON-RPC is a simple request-and-response message format; here it is also used for notifications.

The key check is that the stream contains an `item/started` notification and an `item/completed` notification whose item is `ThreadItem::Sleep`. The test also checks that the completion time is not earlier than the start time, and that both notifications refer to the same thread, turn, call id, and duration. Without this test, the sleep tool could silently run or report misleading progress without being caught.

#### Function details

##### `sleep_emits_started_and_completed_items`  (lines 25–150)

```
async fn sleep_emits_started_and_completed_items() -> Result<()>
```

**Purpose**: This test proves that a sleep tool call is shown to clients as a real timeline item with a start and an end. Someone would use this test to catch regressions where the server performs the sleep but forgets to notify the client, sends the wrong item data, or reports times out of order.

**Data flow**: It begins by creating a mock model server and giving it two streamed replies: first a reply that asks for the `sleep` function with a short duration, then a follow-up assistant message saying “Done.” It writes a temporary config so the app server talks to that mock server, starts the app server, initializes it, starts a thread, and starts a turn containing the user’s message. Then it reads messages from the server until it finds a sleep `item/started` notification and a sleep `item/completed` notification. The output is not a returned value beyond test success; instead, the test passes only if the observed notifications exactly match the expected sleep item, thread id, turn id, and sensible timestamps.

**Call relations**: This is the main test flow in the file. It calls `create_config_toml` to prepare the temporary server configuration, and it calls the test-support helpers that start the mock server, mount the fake streamed responses, convert JSON-RPC responses into typed responses, and read messages from the app server. The story is: set up the fake model, start the real app server under test, trigger the sleep call, then inspect the notifications the server emits.

*Call graph*: calls 4 internal fn (new, create_config_toml, mount_sse_sequence, start_mock_server); 10 external calls (default, new, Integer, to_response, assert!, assert_eq!, matches!, from_value, timeout, vec!).


##### `create_config_toml`  (lines 152–174)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary configuration file needed by the test app server. It makes the server use the mock model provider and turns on the sleep tool feature, so the test can run in a controlled environment without calling a real external model service.

**Data flow**: It receives a temporary “Codex home” folder path and the mock server’s web address. It creates text for a `config.toml` file that selects the mock model, disables approval prompts, uses a read-only sandbox, points the model provider at the mock server’s `/v1` endpoint, disables retries, and enables `sleep_tool`. It writes that text to `config.toml` inside the temporary folder and returns success or a file-writing error.

**Call relations**: It is called near the start of `sleep_emits_started_and_completed_items`, after the mock server has been created and before the test app server is launched. Its job is to hand the app server a map to the fake model provider and the right feature flag, so the rest of the test can focus on observing the sleep notifications.

*Call graph*: called by 1 (sleep_emits_started_and_completed_items); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/web_search.rs`

`test` · `test run`

This is an end-to-end test for standalone web search. In plain terms, it sets up a fake OpenAI-like server, starts the app server, asks it to begin a conversation, and checks that a request to “Search the web” causes the right chain of events. The fake model first asks to call a tool named web.run. The app server then makes a separate HTTP request to the search endpoint, receives “Search result,” and sends that result back to the model as tool output. The test also checks the messages a client would see: a web search item starts, then completes with the actual query and action details. A key point is that the request sent to the model must not include the hosted web_search tool, because standalone web search is meant to replace that built-in option. Finally, the test restarts the app server and reads the thread back, proving the completed web search was saved. The helper functions are like stagehands: they prepare fake server responses, wait for the right notifications, inspect recorded HTTP traffic, and write the temporary configuration needed to turn this feature on.

#### Function details

##### `standalone_web_search_round_trips_output`  (lines 44–221)

```
async fn standalone_web_search_round_trips_output() -> Result<()>
```

**Purpose**: This is the main test. It proves that a standalone web search can travel all the way through the system: model asks for a search, server performs it, result goes back to the model, client gets notifications, and the finished search is persisted.

**Data flow**: It starts with a fake model server, a temporary configuration folder, and a user message saying “Search the web.” It writes test auth and config, starts the app server, creates a thread, starts a turn, waits for web search start and completion notifications, then inspects the fake server's recorded requests. The output is not a returned value but a set of assertions: the model request is shaped correctly, the search endpoint received the right body, the tool output contains “Search result,” the notifications contain the expected web search item, and the saved thread still contains that item after restart.

**Call relations**: This function drives the whole test story. It calls create_config_toml to enable standalone web search, mount_search_response to prepare the fake search endpoint, and the test support server helpers to simulate streamed model responses. During the turn it calls wait_for_web_search_started and wait_for_web_search_completed to pause until the app emits the important client notifications. Afterward it uses search_request_body and has_hosted_web_search to inspect what the app sent over HTTP.

*Call graph*: calls 9 internal fn (new, new_with_env, create_config_toml, mount_search_response, search_request_body, wait_for_web_search_completed, wait_for_web_search_started, mount_sse_sequence, start_mock_server); 9 external calls (default, new, Integer, default, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `wait_for_web_search_started`  (lines 223–237)

```
async fn wait_for_web_search_started(mcp: &mut TestAppServer) -> Result<ItemStartedNotification>
```

**Purpose**: This helper waits until the app server reports that a web search item has started. It filters out any other item-started notifications so the main test can focus on the web search event.

**Data flow**: It receives a mutable connection to the test app server. It repeatedly reads item/started notifications from the server stream, turns each notification's JSON parameters into an ItemStartedNotification, and checks whether the item is a WebSearch item. Once it finds one, it returns that notification; otherwise it keeps waiting.

**Call relations**: The main test calls this after starting a turn, because the web search may appear asynchronously. This helper sits between the raw notification stream and the test assertions, handing back only the specific started event the test cares about.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (standalone_web_search_round_trips_output); 2 external calls (matches!, from_value).


##### `wait_for_web_search_completed`  (lines 239–255)

```
async fn wait_for_web_search_completed(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: This helper waits until the app server reports that a web search item has completed. It lets the test ignore unrelated completion messages and continue only when the web search is done.

**Data flow**: It receives a mutable connection to the test app server. It repeatedly reads item/completed notifications, parses each notification's JSON parameters into an ItemCompletedNotification, and checks whether the completed item is a WebSearch item. When it finds that item, it returns the completed notification.

**Call relations**: The main test calls this after seeing the web search start. It bridges the app server's general notification stream and the test's need to verify the final web search details, such as the query and action.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (standalone_web_search_round_trips_output); 2 external calls (matches!, from_value).


##### `mount_search_response`  (lines 257–267)

```
async fn mount_search_response(server: &MockServer)
```

**Purpose**: This helper teaches the fake HTTP server how to answer the standalone search request. It makes the test search endpoint return a predictable result.

**Data flow**: It receives the fake server. It registers an expected POST request to /api/codex/alpha/search and tells the server to respond with JSON containing an encrypted_output field and an output field set to “Search result.” It also expects that endpoint to be called exactly once.

**Call relations**: The main test calls this before starting the app server flow. Later, when the app server performs the standalone search, this mounted fake response supplies the data that should be sent back to the model as function-call output.

*Call graph*: called by 1 (standalone_web_search_round_trips_output); 5 external calls (given, new, json!, method, path).


##### `has_hosted_web_search`  (lines 269–277)

```
fn has_hosted_web_search(body: &Value) -> bool
```

**Purpose**: This helper checks whether a model request still contains the provider's hosted web_search tool. The test uses it to make sure standalone web search has replaced the built-in hosted search option.

**Data flow**: It receives a JSON body from a recorded model request. It looks for a tools array, scans each tool entry, and returns true if any tool has type equal to web_search. If the tools list is missing or no such tool exists, it returns false.

**Call relations**: The main test uses this while inspecting the first request sent to the fake model server. Its answer supports the assertion that the standalone feature is active and the hosted web search tool was not advertised.

*Call graph*: 1 external calls (get).


##### `search_request_body`  (lines 279–289)

```
async fn search_request_body(server: &MockServer) -> Result<Value>
```

**Purpose**: This helper finds the standalone search HTTP request that the app server sent and returns its JSON body. It gives the test a clean way to inspect exactly what was sent to the search endpoint.

**Data flow**: It receives the fake server, asks it for all received requests, searches for the one whose path is /api/codex/alpha/search, and parses that request body as JSON. It returns that JSON value, or an error if the request is missing or not valid JSON.

**Call relations**: The main test calls this after the turn completes. It uses the returned body to check the selected model, search command, allowed caller setting, and conversation input that were passed into the standalone search service.

*Call graph*: called by 1 (standalone_web_search_round_trips_output); 1 external calls (received_requests).


##### `create_config_toml`  (lines 291–316)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary configuration file that makes the app server use the fake provider and turns standalone web search on. Without this setup, the test would not exercise the intended feature path.

**Data flow**: It receives the temporary Codex home directory and the fake server's base URL. It writes a config.toml file containing the mock model name, safe test policies, the fake ChatGPT base URL, standalone_web_search = true, and a custom model provider pointing at the fake server. It returns success or a file-writing error.

**Call relations**: The main test calls this during setup, before starting TestAppServer. The app server later reads this file at startup, so the configuration created here controls all later HTTP traffic and feature behavior in the test.

*Call graph*: called by 1 (standalone_web_search_round_trips_output); 3 external calls (join, format!, write).


### `app-server/tests/suite/fuzzy_file_search.rs`

`test` · `test run`

This test file acts like a careful user of the app server. It creates temporary folders, puts simple files in them, starts a test server, and talks to it through JSON-RPC, which is a message format where a client sends requests and the server sends responses or notifications. The feature under test is fuzzy file search: finding files even when the user types only part of a name, like searching “alp” and finding “alpha.txt”.

The tests cover two styles of search. The first is a one-shot request: send a query and get a list of matching files back. The second is a session: start a search session, send query updates as if a user is typing, and receive streamed notifications with updated results. This is like a search box that refreshes while you type.

Several helper functions keep the tests readable. They write a minimal config file, start and initialize the server, wait for the right search notification, and check that no unexpected updates arrive after a session stops. The tests also check important edge cases: searches are case-insensitive, missing sessions return a clear error, two sessions do not mix their results, clearing the query sends an empty snapshot, and updates can be sent immediately after starting a session.

#### Function details

##### `create_config_toml`  (lines 32–45)

```
fn create_config_toml(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Writes the small configuration file needed for the test app server to start in a predictable way. It disables unrelated shell snapshot behavior and uses safe test settings so the fuzzy search tests are focused only on file search.

**Data flow**: It receives the temporary Codex home folder path. It builds the path to `config.toml`, writes fixed configuration text into that file, and returns success or a file-writing error.

**Call relations**: The setup helpers and the one-shot fuzzy search tests call this before starting `TestAppServer`. Without this step, the server might start with missing or different settings, making the tests unreliable.

*Call graph*: called by 3 (initialized_mcp, test_fuzzy_file_search_accepts_cancellation_token, test_fuzzy_file_search_sorts_and_includes_indices); 2 external calls (join, write).


##### `initialized_mcp`  (lines 47–52)

```
async fn initialized_mcp(codex_home: &TempDir) -> Result<TestAppServer>
```

**Purpose**: Creates a fully started test app server that is ready to receive fuzzy file search requests. It bundles the repeated setup steps so session tests do not each have to repeat them.

**Data flow**: It receives a temporary Codex home directory. It writes the test config there, starts `TestAppServer` using that directory, waits for the server initialization to complete within a timeout, and returns the ready server object.

**Call relations**: Most session-based tests call this at the beginning. It relies on `create_config_toml`, then hands back a live server that later helpers and tests use to start sessions, update queries, and read notifications.

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

**Purpose**: Waits until the server sends the expected “search session updated” notification. It filters out unrelated messages and only accepts an update for the requested session, query, and expected file-result state.

**Data flow**: It receives the test server, a session id, a query string, and whether the file list should be empty, non-empty, or either. It reads server notifications until one matches, converts the JSON payload into a typed notification object, and returns that object. If no matching notification arrives in time, it returns an error that includes the buffered notification methods.

**Call relations**: Session tests call this after sending a query update. It sits between the test action and the assertions: the test tells the server what query to search for, this helper waits for the matching update, and then the test checks the returned files.

*Call graph*: calls 1 internal fn (read_stream_until_matching_notification); called by 8 (test_fuzzy_file_search_query_cleared_sends_blank_snapshot, test_fuzzy_file_search_session_multiple_query_updates_work, test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited, test_fuzzy_file_search_session_stops_sending_updates_after_stop, test_fuzzy_file_search_session_streams_updates, test_fuzzy_file_search_session_update_is_case_insensitive, test_fuzzy_file_search_session_update_works_without_waiting_for_start_response, test_fuzzy_file_search_two_sessions_are_independent); 3 external calls (bail!, format!, timeout).


##### `wait_for_session_completed`  (lines 101–140)

```
async fn wait_for_session_completed(
    mcp: &mut TestAppServer,
    session_id: &str,
) -> Result<FuzzyFileSearchSessionCompletedNotification>
```

**Purpose**: Waits until the server says a fuzzy file search session has finished searching for its current query. This lets tests distinguish between partial streamed results and a completed search pass.

**Data flow**: It receives the test server and a session id. It reads notifications until it finds a completion message for that session, parses the JSON payload into a typed completion notification, and returns it. If the message does not arrive before the timeout, it returns a clear timeout error.

**Call relations**: Tests that care about completion call this after receiving an update. It follows `wait_for_session_updated` in flows where the test needs to confirm that the server has stopped producing results for the current query.

*Call graph*: calls 1 internal fn (read_stream_until_matching_notification); called by 3 (test_fuzzy_file_search_session_multiple_query_updates_work, test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited, test_fuzzy_file_search_session_streams_updates); 3 external calls (bail!, format!, timeout).


##### `assert_update_request_fails_for_missing_session`  (lines 142–161)

```
async fn assert_update_request_fails_for_missing_session(
    mcp: &mut TestAppServer,
    session_id: &str,
    query: &str,
) -> Result<()>
```

**Purpose**: Checks that updating a non-existent fuzzy search session fails with the exact expected error. This protects the contract that clients get a clear “session not found” response instead of silent failure.

**Data flow**: It receives the server, a session id, and a query. It sends an update request for that session, waits for the matching error response, and verifies both the JSON-RPC error code and the human-readable error message.

**Call relations**: Tests use this when they intentionally update before starting a session or after stopping one. It wraps the request-and-check pattern so those tests can focus on the scenario being tested.

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

**Purpose**: Checks that a session does not receive any more update notifications during a given watch period. It is used to prove that completed or stopped sessions stay quiet when they should.

**Data flow**: It receives the server, a session id, a short grace period, and a duration to watch. First it drains any update notifications that may already have been in flight during the grace period. Then it watches for new update notifications; if one belongs to the target session, it fails the test, otherwise it returns success when the time expires.

**Call relations**: Tests call this after a session completes or after it is stopped. It reads from the same notification stream as `wait_for_session_updated`, but instead of looking for a wanted update, it guards against an unwanted one.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited, test_fuzzy_file_search_session_stops_sending_updates_after_stop); 3 external calls (bail!, now, timeout).


##### `test_fuzzy_file_search_sorts_and_includes_indices`  (lines 218–295)

```
async fn test_fuzzy_file_search_sorts_and_includes_indices() -> Result<()>
```

**Purpose**: Verifies the one-shot fuzzy file search response: matching files are sorted as expected and include the character positions that matched the query. Those indices matter because a user interface can highlight the matching letters.

**Data flow**: It creates a temporary server home and a temporary search root, writes several test files, starts the server, sends a search for `abe`, and reads the response. It then compares the full JSON result against the expected file order, scores, paths, and match indices.

**Call relations**: This test uses `create_config_toml` directly because it performs custom setup before starting the server. It exercises the server’s one-shot search request path rather than the session notification path.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, Integer, assert_eq!, create_dir_all, write, timeout, vec!).


##### `test_fuzzy_file_search_accepts_cancellation_token`  (lines 298–344)

```
async fn test_fuzzy_file_search_accepts_cancellation_token() -> Result<()>
```

**Purpose**: Checks that the one-shot fuzzy search request accepts an optional cancellation token field without breaking the search. This matters for clients that include cancellation information as part of their normal request format.

**Data flow**: It creates a temporary file named `alpha.txt`, starts the server, sends one search request, then sends a second search request with a cancellation token value. It waits for the second response and checks that exactly one file, `alpha.txt`, is returned from the expected root.

**Call relations**: Like the sorting test, it uses `create_config_toml` and starts `TestAppServer` directly. It focuses on request compatibility rather than streaming session behavior.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (new, Integer, assert_eq!, write, timeout, vec!).


##### `test_fuzzy_file_search_session_streams_updates`  (lines 347–372)

```
async fn test_fuzzy_file_search_session_streams_updates() -> Result<()>
```

**Purpose**: Confirms the basic session workflow: start a fuzzy search session, update the query, receive matching results, and receive a completion notification. This is the happy path for a live search box.

**Data flow**: It creates a temporary root containing `alpha.txt`, starts an initialized server, starts a session, sends the query `alp`, waits for a non-empty update, checks that the result is `alpha.txt`, waits for completion, and then stops the session.

**Call relations**: This test uses `initialized_mcp` for setup, `wait_for_session_updated` to capture the streamed result, and `wait_for_session_completed` to confirm the search pass ended.

*Call graph*: calls 3 internal fn (initialized_mcp, wait_for_session_completed, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_session_update_is_case_insensitive`  (lines 375–396)

```
async fn test_fuzzy_file_search_session_update_is_case_insensitive() -> Result<()>
```

**Purpose**: Verifies that session search treats uppercase and lowercase letters as equivalent. A user typing `ALP` should still find `alpha.txt`.

**Data flow**: It creates `alpha.txt`, starts a session, sends the uppercase query `ALP`, waits for a non-empty update for that exact query, and checks that the returned file is `alpha.txt` from the expected root.

**Call relations**: It follows the standard session setup through `initialized_mcp` and then uses `wait_for_session_updated` to observe the server’s result notification.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited`  (lines 399–423)

```
async fn test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited() -> Result<()>
```

**Purpose**: Checks that once a session reports completion for a query, it does not keep sending more updates for that same query. It also confirms that editing the query starts a new round of updates.

**Data flow**: It creates `alpha.txt`, starts a session, sends `alp`, waits for an update and completion, then watches briefly to make sure no more updates arrive. After that it changes the query to `alpha` and waits for a new non-empty update.

**Call relations**: This test combines the waiting helpers: `wait_for_session_updated` and `wait_for_session_completed` prove the first search finished, while `assert_no_session_updates_for` checks the quiet period before another update request restarts activity.

*Call graph*: calls 4 internal fn (assert_no_session_updates_for, initialized_mcp, wait_for_session_completed, wait_for_session_updated); 3 external calls (new, write, vec!).


##### `test_fuzzy_file_search_session_update_before_start_errors`  (lines 426–432)

```
async fn test_fuzzy_file_search_session_update_before_start_errors() -> Result<()>
```

**Purpose**: Verifies that the server rejects an update for a session that was never started. This prevents clients from accidentally creating hidden sessions just by sending updates.

**Data flow**: It starts an initialized server with no fuzzy search sessions. It sends an update for the session id `missing` and checks that the server returns the expected “session not found” JSON-RPC error.

**Call relations**: The test uses `initialized_mcp` for a clean server and delegates the exact error check to `assert_update_request_fails_for_missing_session`.

*Call graph*: calls 2 internal fn (assert_update_request_fails_for_missing_session, initialized_mcp); 1 external calls (new).


##### `test_fuzzy_file_search_session_update_works_without_waiting_for_start_response`  (lines 435–470)

```
async fn test_fuzzy_file_search_session_update_works_without_waiting_for_start_response() -> Result<()>
```

**Purpose**: Checks that a client can send a session update immediately after sending the session start request, before reading the start response. This supports fast clients that pipeline messages instead of waiting after every request.

**Data flow**: It creates `alpha.txt`, starts the server, sends a session start request, immediately sends an update request for `alp`, waits for both request responses, and then waits for a non-empty session update containing `alpha.txt`.

**Call relations**: This test uses `initialized_mcp` for setup and `wait_for_session_updated` for the streamed result. It specifically stresses ordering between start and update requests.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 6 external calls (new, Integer, assert_eq!, write, timeout, vec!).


##### `test_fuzzy_file_search_session_multiple_query_updates_work`  (lines 473–504)

```
async fn test_fuzzy_file_search_session_multiple_query_updates_work() -> Result<()>
```

**Purpose**: Verifies that one session can handle more than one query over time. It checks both a query that finds files and a later query that finds none.

**Data flow**: It creates `alpha.txt` and `alphabet.txt`, starts a session, searches for `alp`, verifies returned files come from the expected root, and waits for completion. Then it searches for `zzzz`, verifies the update belongs to that query and has an empty file list, and waits for completion again.

**Call relations**: This test reuses the normal session helpers and calls `wait_for_session_completed` after each query. It proves that completion of one query does not make the session unusable for the next query.

*Call graph*: calls 3 internal fn (initialized_mcp, wait_for_session_completed, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_session_update_after_stop_fails`  (lines 507–522)

```
async fn test_fuzzy_file_search_session_update_after_stop_fails() -> Result<()>
```

**Purpose**: Checks that once a fuzzy search session is stopped, later updates to that same session id are rejected. This confirms stopping really removes the session from the server’s active state.

**Data flow**: It creates a search root, starts a session, stops it, and then sends another update for the stopped session id. It verifies that the server returns the same “session not found” error used for missing sessions.

**Call relations**: The test uses `initialized_mcp` for setup and `assert_update_request_fails_for_missing_session` for the final error assertion.

*Call graph*: calls 2 internal fn (assert_update_request_fails_for_missing_session, initialized_mcp); 3 external calls (new, write, vec!).


##### `test_fuzzy_file_search_session_stops_sending_updates_after_stop`  (lines 525–548)

```
async fn test_fuzzy_file_search_session_stops_sending_updates_after_stop() -> Result<()>
```

**Purpose**: Verifies that stopping a busy search session prevents further updates from being sent for that session. This matters because a stopped search should not keep consuming attention or sending stale results to the client.

**Data flow**: It creates hundreds of files so the search has enough work to stream results, starts a session, sends the query `file-`, waits for at least one non-empty update, stops the session, and then watches for a short period to ensure no more updates for that session arrive.

**Call relations**: The test uses `wait_for_session_updated` to confirm updates were happening before the stop, then uses `assert_no_session_updates_for` to confirm they stop afterward.

*Call graph*: calls 3 internal fn (assert_no_session_updates_for, initialized_mcp, wait_for_session_updated); 4 external calls (new, format!, write, vec!).


##### `test_fuzzy_file_search_two_sessions_are_independent`  (lines 551–587)

```
async fn test_fuzzy_file_search_two_sessions_are_independent() -> Result<()>
```

**Purpose**: Checks that two fuzzy search sessions can run side by side without mixing their roots, queries, or results. This protects clients that may have more than one search UI or workspace active.

**Data flow**: It creates two separate temporary roots, one with `alpha.txt` and one with `beta.txt`. It starts two sessions with different roots, updates the first with `alp` and verifies it returns only `alpha.txt`, then updates the second with `bet` and verifies it returns only `beta.txt`.

**Call relations**: This test uses `initialized_mcp` once and then starts two sessions on the same server. It calls `wait_for_session_updated` separately for each session to prove the notification stream can be filtered by session id.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_query_cleared_sends_blank_snapshot`  (lines 590–611)

```
async fn test_fuzzy_file_search_query_cleared_sends_blank_snapshot() -> Result<()>
```

**Purpose**: Verifies that clearing the query in a session sends an update with an empty file list. This gives clients a clear signal to clear their displayed search results when the user deletes the search text.

**Data flow**: It creates `alpha.txt`, starts a session, searches for `alp`, and waits for a non-empty result. Then it sends an empty query string, waits for an update for that empty query, and checks that the file list is empty.

**Call relations**: The test uses `initialized_mcp` for setup and `wait_for_session_updated` twice: first to confirm normal results, then to confirm the blank snapshot after the query is cleared.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).
