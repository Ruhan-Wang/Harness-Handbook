# App-server integration discovery and search adapters  `stage-14.3.4`

This stage sits at the app-server boundary where backend integration data is turned into client-facing discovery and search features during normal request handling. It powers two user-visible capabilities: listing available apps/connectors and running interactive fuzzy file search.

On the discovery side, connectors/src/accessible.rs builds the authoritative set of connectors a client can already use by folding connector-tool records into deduplicated entries, merging partial metadata, collecting plugin names, and deriving install links. connectors/src/filter.rs applies product policy on top of that data, excluding hidden connector IDs and identifying discoverable-but-not-yet-accessible connectors for suggestion flows. connectors/src/merge.rs then joins directory metadata, plugin-discovered app IDs, and accessible connector data into one sorted AppInfo list, including placeholder entries when only plugin evidence exists. app-server/src/request_processors/apps_processor.rs orchestrates these pieces for the apps/list API, mixing cached and freshly fetched MCP/plugin data and, when needed, returning quickly while a background task computes the full list and pushes AppListUpdated notifications.

In parallel, app-server/src/fuzzy_file_search.rs serves file-search requests, converting search-engine matches into protocol responses and session updates while enforcing limits, cancellation, and suppression of stale interactive results.

## Files in this stage

### Connector catalog shaping
These files build, filter, and merge connector and plugin data into the app-facing catalog used by discovery flows.

### `connectors/src/accessible.rs`

`domain_logic` · `request handling`

This file contains a single aggregation function plus the lightweight input struct it consumes. `AccessibleConnectorTool` represents one tool’s view of its owning connector: connector id, optional normalized display metadata, and the plugin display names that contributed that connector. `collect_accessible_connectors` folds many such records into one `Vec<AppInfo>` suitable for app-server responses.

The function maintains a `HashMap<String, (AppInfo, BTreeSet<String>)>` keyed by connector id. For each incoming tool, it normalizes optional connector name and description with `normalize_connector_value`; if the name normalizes to nothing, it falls back to the connector id. When a connector already exists, the merge logic is intentionally conservative: it upgrades the stored name only if the current name is still the raw id and the new record has a better display name, fills in description only if it was previously absent, and unions plugin display names through a `BTreeSet` to deduplicate and sort them. For first sightings, it creates an `AppInfo` with accessibility/enabled flags set `true` and most branding/distribution fields left `None`.

After aggregation, it converts each set of plugin names back into a `Vec`, computes `install_url` from the final connector name and id via `connector_install_url`, and sorts the result primarily by `is_accessible` descending, then by connector name and id ascending. The output is therefore stable, deduplicated, and enriched with install metadata.

#### Function details

##### `collect_accessible_connectors`  (lines 15–76)

```
fn collect_accessible_connectors(tools: I) -> Vec<AppInfo>
```

**Purpose**: Aggregates per-tool connector metadata into one deduplicated, sorted `Vec<AppInfo>` describing accessible connectors.

**Data flow**: Consumes any `IntoIterator<Item = AccessibleConnectorTool>` → iterates each tool, normalizes optional name/description, and updates a `HashMap` keyed by `connector_id`; existing entries may have their placeholder name replaced, missing description filled, and plugin display names unioned into a `BTreeSet`, while new entries create an `AppInfo` with default `None` metadata and `is_accessible/is_enabled` set `true` → converts map values into `AppInfo`s by materializing sorted plugin display names and computing `install_url` with `connector_install_url(&connector.name, &connector.id)` → sorts the vector by accessibility, then name, then id → returns it.

**Call relations**: Called by higher-level connector exposure code when deriving the accessible connector list from MCP tools. It delegates only normalization and install-URL generation; all merge policy lives here.

*Call graph*: called by 1 (accessible_connectors_from_mcp_tools); 3 external calls (new, new, normalize_connector_value).


### `connectors/src/filter.rs`

`domain_logic` · `post-fetch connector filtering and tool suggestion preparation`

This file contains the policy filters applied after connector metadata has been fetched or merged. The main exported path, `filter_tool_suggest_discoverable_connectors`, starts from directory connectors and removes three categories in sequence: connectors disallowed for the current originator, connectors already accessible to the user, and connectors whose IDs are not present in the supplied discoverability set. It builds a `HashSet<&str>` of accessible connector IDs, but only from `accessible_connectors` whose `is_accessible` flag is true; disabled-but-accessible apps still count as installed and are excluded later. The final list is sorted deterministically by `name` and then `id`.

The lower-level `filter_disallowed_connectors` applies hard-coded deny lists. Which list is used depends on `originator_value`: first-party chat originators (`codex_atlas` and `codex_chatgpt_desktop`) use a narrower deny list, while all other originators use the broader `DISALLOWED_CONNECTOR_IDS`. The helper `is_connector_id_allowed` simply checks membership in the selected static slice; there is no prefix-based wildcard logic despite tests confirming that unrelated IDs such as `connector_openai_*` remain allowed.

The test module builds synthetic `AppInfo` values and verifies the exact edge cases: ordinary IDs pass through, listed IDs are removed, first-party chat swaps deny lists, tool-suggest only returns discoverable plugin-backed apps, and accessible apps are excluded even when `is_enabled` is false.

#### Function details

##### `filter_tool_suggest_discoverable_connectors`  (lines 5–28)

```
fn filter_tool_suggest_discoverable_connectors(
    directory_connectors: Vec<AppInfo>,
    accessible_connectors: &[AppInfo],
    discoverable_connector_ids: &HashSet<String>,
    originator_value: &
```

**Purpose**: Builds the tool-suggestion candidate list by keeping only discoverable directory connectors that are not already accessible and not blocked by originator-specific deny rules.

**Data flow**: Consumes `directory_connectors: Vec<AppInfo>`, reads `accessible_connectors: &[AppInfo]`, `discoverable_connector_ids: &HashSet<String>`, and `originator_value: &str`. It first derives a `HashSet<&str>` of IDs from accessible connectors whose `is_accessible` is true, then runs `filter_disallowed_connectors`, filters out IDs present in that accessible set, filters out IDs absent from the discoverable set, sorts the survivors by `name` then `id`, and returns the new `Vec<AppInfo>`.

**Call relations**: It is used by the tool-suggestion listing flow and exercised directly by tests covering installed-app exclusion. Internally it delegates the deny-list portion to `filter_disallowed_connectors` so originator policy stays consistent with other connector-merging paths.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); called by 3 (filter_tool_suggest_discoverable_connectors_excludes_accessible_apps_even_when_disabled, filter_tool_suggest_discoverable_connectors_keeps_only_plugin_backed_uninstalled_apps, list_tool_suggest_discoverable_tools_with_auth); 1 external calls (iter).


##### `filter_disallowed_connectors`  (lines 41–52)

```
fn filter_disallowed_connectors(
    connectors: Vec<AppInfo>,
    originator_value: &str,
) -> Vec<AppInfo>
```

**Purpose**: Removes connectors whose IDs are explicitly blocked for the current originator class.

**Data flow**: Takes ownership of `connectors: Vec<AppInfo>` plus `originator_value: &str`, computes a boolean via `is_first_party_chat_originator`, filters the vector by calling `is_connector_id_allowed` on each connector ID, and returns the retained connectors.

**Call relations**: It is a shared policy primitive used by multiple connector assembly paths before presentation. The function is also the subject of several unit tests that verify both the default deny list and the first-party-chat-specific variant.

*Call graph*: calls 1 internal fn (is_first_party_chat_originator); called by 10 (connectors_for_plugin_apps, merge_and_filter_plugin_connectors, merge_connectors_with_accessible, filter_tool_suggest_discoverable_connectors, filter_disallowed_connectors_allows_non_disallowed_connectors, filter_disallowed_connectors_allows_openai_prefix, filter_disallowed_connectors_filters_disallowed_connector_ids, first_party_chat_originator_filters_target_connector_ids, list_accessible_connectors_from_mcp_tools_with_mcp_manager, refresh_accessible_connectors_cache_from_mcp_tools).


##### `is_first_party_chat_originator`  (lines 54–56)

```
fn is_first_party_chat_originator(originator_value: &str) -> bool
```

**Purpose**: Classifies whether an originator string should use the first-party chat deny list.

**Data flow**: Reads `originator_value: &str`, compares it against the two accepted literals, and returns `true` only for `codex_atlas` or `codex_chatgpt_desktop`.

**Call relations**: It is only called from `filter_disallowed_connectors` to choose which static deny-list slice applies.

*Call graph*: called by 1 (filter_disallowed_connectors).


##### `is_connector_id_allowed`  (lines 58–66)

```
fn is_connector_id_allowed(connector_id: &str, first_party_chat_originator: bool) -> bool
```

**Purpose**: Checks a single connector ID against the appropriate hard-coded deny list.

**Data flow**: Accepts `connector_id: &str` and `first_party_chat_originator: bool`, selects either `FIRST_PARTY_CHAT_DISALLOWED_CONNECTOR_IDS` or `DISALLOWED_CONNECTOR_IDS`, tests whether the ID is contained in that slice, and returns the negated result.

**Call relations**: It is the per-item predicate used inside `filter_disallowed_connectors`; no other file calls it directly.


##### `tests::app`  (lines 74–90)

```
fn app(id: &str) -> AppInfo
```

**Purpose**: Creates a minimal synthetic `AppInfo` with the given ID used by filter tests.

**Data flow**: Takes `id: &str`, clones it into both `id` and `name`, fills all optional metadata fields with `None`, sets `is_accessible` false and `is_enabled` true, initializes `plugin_display_names` empty, and returns the assembled `AppInfo`.

**Call relations**: Test cases call it as the base fixture for concise expected and input vectors.

*Call graph*: 1 external calls (new).


##### `tests::named_app`  (lines 92–99)

```
fn named_app(id: &str, name: &str) -> AppInfo
```

**Purpose**: Builds a test `AppInfo` with a distinct display name and a generated install URL.

**Data flow**: Accepts `id` and `name`, computes `install_url` via `connector_install_url(name, id)`, then overlays that and the provided name onto the baseline struct returned by `app(id)`.

**Call relations**: It is used by the tool-suggest tests where sorting and install URL presence matter.

*Call graph*: calls 1 internal fn (connector_install_url); 1 external calls (app).


##### `tests::filter_disallowed_connectors_allows_non_disallowed_connectors`  (lines 102–106)

```
fn filter_disallowed_connectors_allows_non_disallowed_connectors()
```

**Purpose**: Verifies that ordinary connector IDs not present in the deny list survive filtering for a non-chat originator.

**Data flow**: Builds a small input vector with `app`, passes it to `filter_disallowed_connectors` using `codex_cli`, and asserts the returned vector matches the original connectors.

**Call relations**: This test exercises the default deny-list path and confirms there is no accidental broad filtering.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::filter_disallowed_connectors_allows_openai_prefix`  (lines 109–126)

```
fn filter_disallowed_connectors_allows_openai_prefix()
```

**Purpose**: Confirms that IDs sharing an `connector_openai_` prefix are not implicitly blocked.

**Data flow**: Constructs three `AppInfo` values, filters them with `filter_disallowed_connectors` for `codex_cli`, and asserts all three remain in order.

**Call relations**: It guards against future changes that might replace exact-ID checks with broader prefix matching.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::filter_disallowed_connectors_filters_disallowed_connector_ids`  (lines 129–139)

```
fn filter_disallowed_connectors_filters_disallowed_connector_ids()
```

**Purpose**: Checks that IDs explicitly listed in the default deny list are removed.

**Data flow**: Creates a vector containing two blocked IDs and one allowed ID, runs `filter_disallowed_connectors` with `codex_cli`, and asserts only the allowed connector remains.

**Call relations**: This test pins the behavior of the standard deny-list branch.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::first_party_chat_originator_filters_target_connector_ids`  (lines 142–158)

```
fn first_party_chat_originator_filters_target_connector_ids()
```

**Purpose**: Verifies that first-party chat originators use the alternate deny list rather than the default one.

**Data flow**: Builds connectors including one ID blocked only for first-party chat and one blocked only in the default list, filters with originator `codex_atlas`, and asserts the first-party-chat-specific blocked ID is removed while the default-only blocked ID remains.

**Call relations**: It specifically validates the branch selected by `is_first_party_chat_originator`.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::filter_tool_suggest_discoverable_connectors_keeps_only_plugin_backed_uninstalled_apps`  (lines 161–192)

```
fn filter_tool_suggest_discoverable_connectors_keeps_only_plugin_backed_uninstalled_apps()
```

**Purpose**: Checks that tool-suggest output keeps only discoverable connectors that are not already accessible.

**Data flow**: Creates directory connectors with `named_app`, marks one matching accessible connector as `is_accessible: true`, supplies a discoverable-ID set containing two IDs, invokes `filter_tool_suggest_discoverable_connectors`, and asserts only the discoverable-but-not-accessible connector remains.

**Call relations**: This test covers the combined filtering pipeline of deny-listing, accessible exclusion, discoverability gating, and sorting.

*Call graph*: calls 1 internal fn (filter_tool_suggest_discoverable_connectors); 4 external calls (from, assert_eq!, named_app, vec!).


##### `tests::filter_tool_suggest_discoverable_connectors_excludes_accessible_apps_even_when_disabled`  (lines 195–226)

```
fn filter_tool_suggest_discoverable_connectors_excludes_accessible_apps_even_when_disabled()
```

**Purpose**: Verifies that accessibility, not enabled state, determines whether a connector is excluded from tool suggestions.

**Data flow**: Builds two directory connectors and two accessible connectors, one of which is marked `is_enabled: false` but still `is_accessible: true`, runs `filter_tool_suggest_discoverable_connectors`, and asserts the result is empty.

**Call relations**: It protects the subtle invariant that disabled installed apps are still treated as already present and therefore not suggestible.

*Call graph*: calls 1 internal fn (filter_tool_suggest_discoverable_connectors); 4 external calls (from, assert_eq!, named_app, vec!).


### `connectors/src/merge.rs`

`domain_logic` · `connector inventory assembly after discovery and accessibility lookup`

This file defines the merge rules for connector inventories coming from different sources. `merge_connectors` is the main reconciler: it starts from a directory-style connector list, forces every entry’s `is_accessible` to false, indexes them by ID, then folds in `accessible_connectors` with `is_accessible` set true. When an accessible connector matches an existing entry, it upgrades accessibility and selectively fills missing metadata: placeholder names equal to the connector ID are replaced by a better accessible name, missing description/logo/distribution channel fields are copied over, and `plugin_display_names` are appended. If an accessible connector has no matching directory entry, it is inserted as-is.

After merging, every connector is guaranteed to have an `install_url`; missing ones are synthesized with `metadata::connector_install_url`. Plugin display names are sorted and deduplicated, and the final list is ordered by `sort_connectors_by_accessibility_and_name`, which puts accessible connectors first.

The other two exported helpers build on that. `merge_plugin_connectors` adds placeholder connectors for plugin app IDs not already present in a connector list. `merge_plugin_connectors_with_accessible` narrows plugin IDs to those already present in the accessible set, converts them to placeholders, and then delegates to `merge_connectors`. The placeholder constructor `plugin_connector_to_app_info` intentionally uses the connector ID as the initial name so later merges can detect and replace that synthetic value.

#### Function details

##### `merge_connectors`  (lines 8–58)

```
fn merge_connectors(
    connectors: Vec<AppInfo>,
    accessible_connectors: Vec<AppInfo>,
) -> Vec<AppInfo>
```

**Purpose**: Merges a base connector list with accessible connectors, preserving the best available metadata and marking accessible entries first-class.

**Data flow**: Consumes `connectors: Vec<AppInfo>` and `accessible_connectors: Vec<AppInfo>`. It builds a `HashMap<String, AppInfo>` from the base connectors after forcing `is_accessible = false`, then iterates accessible connectors with `is_accessible = true`. For matching IDs it updates the existing entry’s accessibility, replaces placeholder names equal to the ID with a better accessible name, fills missing description/logo/distribution channel fields, and extends `plugin_display_names`; for non-matching IDs it inserts the accessible connector. It then converts the map back to a vector, fills missing `install_url` values using `connector_install_url`, sorts and deduplicates `plugin_display_names`, sorts the whole list by accessibility and name, and returns it.

**Call relations**: It is the core merge primitive used by higher-level accessible/plugin merge flows and by tests. It delegates final URL synthesis and ordering to metadata helpers so all merged outputs share the same presentation rules.

*Call graph*: calls 2 internal fn (connector_install_url, sort_connectors_by_accessibility_and_name); called by 4 (merge_connectors_with_accessible, merge_plugin_connectors_with_accessible, merge_connectors_replaces_plugin_placeholder_name_with_accessible_name, merge_connectors_unions_and_dedupes_plugin_display_names).


##### `merge_plugin_connectors`  (lines 60–78)

```
fn merge_plugin_connectors(connectors: Vec<AppInfo>, plugin_app_ids: I) -> Vec<AppInfo>
```

**Purpose**: Adds placeholder connectors for plugin app IDs that are absent from an existing connector list.

**Data flow**: Takes `connectors: Vec<AppInfo>` and an iterable of plugin app IDs, collects existing connector IDs into a `HashSet`, appends `plugin_connector_to_app_info(connector_id)` for each new ID not already present, sorts the resulting vector by accessibility and name, and returns it.

**Call relations**: It is used in plugin-oriented assembly paths where plugin discovery yields app IDs that may not appear in directory metadata. It delegates placeholder construction to `plugin_connector_to_app_info`.

*Call graph*: calls 2 internal fn (plugin_connector_to_app_info, sort_connectors_by_accessibility_and_name); called by 3 (connectors_for_plugin_apps, merge_and_filter_plugin_connectors, list_tool_suggest_discoverable_tools_with_auth).


##### `merge_plugin_connectors_with_accessible`  (lines 80–97)

```
fn merge_plugin_connectors_with_accessible(
    plugin_app_ids: I,
    accessible_connectors: Vec<AppInfo>,
) -> Vec<AppInfo>
```

**Purpose**: Builds plugin placeholder connectors only for IDs that are already accessible, then merges them with the accessible connector metadata.

**Data flow**: Consumes an iterable of `plugin_app_ids` and `accessible_connectors: Vec<AppInfo>`, derives a `HashSet<&str>` of accessible IDs, filters plugin IDs down to those present in that set, maps them through `plugin_connector_to_app_info`, collects the placeholders, and passes them plus the accessible connectors into `merge_connectors`.

**Call relations**: It is used by tool-building flows that need plugin-backed connectors only when the user can actually access them. The function’s main role is prefiltering before delegating the actual reconciliation to `merge_connectors`.

*Call graph*: calls 1 internal fn (merge_connectors); called by 2 (build_skills_and_plugins, built_tools); 1 external calls (into_iter).


##### `plugin_connector_to_app_info`  (lines 99–119)

```
fn plugin_connector_to_app_info(connector_id: String) -> AppInfo
```

**Purpose**: Creates a minimal placeholder `AppInfo` for a plugin-discovered connector ID.

**Data flow**: Takes ownership of `connector_id: String`, clones it into both `id` and `name`, leaves all optional metadata fields `None`, computes an `install_url` from that placeholder name and ID, sets `is_accessible` false and `is_enabled` true, initializes `plugin_display_names` empty, and returns the `AppInfo`.

**Call relations**: It is called by both plugin merge helpers and by tests. Its deliberate placeholder-name choice is relied on by `merge_connectors`, which recognizes `name == id` as replaceable synthetic metadata.

*Call graph*: calls 1 internal fn (connector_install_url); called by 3 (merge_plugin_connectors, merge_connectors_replaces_plugin_placeholder_name_with_accessible_name, merge_connectors_unions_and_dedupes_plugin_display_names); 1 external calls (new).


##### `tests::plugin_names`  (lines 128–130)

```
fn plugin_names(names: &[&str]) -> Vec<String>
```

**Purpose**: Converts a slice of string literals into owned plugin display-name strings for test fixtures.

**Data flow**: Reads `&[&str]`, maps each element through `ToString::to_string`, collects into `Vec<String>`, and returns it.

**Call relations**: Test fixture builders use it to populate `plugin_display_names` concisely.


##### `tests::google_calendar_accessible_connector`  (lines 132–148)

```
fn google_calendar_accessible_connector(plugin_display_names: &[&str]) -> AppInfo
```

**Purpose**: Builds a representative accessible connector fixture with rich metadata for merge tests.

**Data flow**: Accepts a slice of plugin display names, converts them with `plugin_names`, and returns an `AppInfo` for ID `calendar` with human-readable name, description, logos, workspace distribution channel, `is_accessible = true`, and the supplied plugin display names.

**Call relations**: Both merge tests use this helper as the accessible-side input to verify metadata propagation.

*Call graph*: 1 external calls (plugin_names).


##### `tests::merge_connectors_replaces_plugin_placeholder_name_with_accessible_name`  (lines 151–176)

```
fn merge_connectors_replaces_plugin_placeholder_name_with_accessible_name()
```

**Purpose**: Verifies that merging an accessible connector over a plugin placeholder replaces the synthetic ID-as-name with the accessible display name.

**Data flow**: Creates a placeholder via `plugin_connector_to_app_info`, an accessible fixture via `google_calendar_accessible_connector`, merges them with `merge_connectors`, and asserts the resulting single connector has the accessible name and metadata while retaining the placeholder-derived install URL.

**Call relations**: This test exercises the special-case name replacement branch in `merge_connectors` and also checks downstream slug generation through `connector_mention_slug`.

*Call graph*: calls 2 internal fn (merge_connectors, plugin_connector_to_app_info); 3 external calls (assert_eq!, google_calendar_accessible_connector, vec!).


##### `tests::merge_connectors_unions_and_dedupes_plugin_display_names`  (lines 179–205)

```
fn merge_connectors_unions_and_dedupes_plugin_display_names()
```

**Purpose**: Checks that plugin display names from placeholder and accessible sources are combined, sorted, and deduplicated.

**Data flow**: Starts from a placeholder connector whose `plugin_display_names` already contain duplicates, merges it with an accessible fixture carrying overlapping names, and asserts the merged result contains the sorted unique union.

**Call relations**: It validates the append-then-sort/dedup behavior in `merge_connectors`.

*Call graph*: calls 2 internal fn (merge_connectors, plugin_connector_to_app_info); 4 external calls (assert_eq!, google_calendar_accessible_connector, plugin_names, vec!).


### App discovery request handling
This request processor serves `apps/list` by orchestrating cached and refreshed connector catalog data and streaming updates back to clients.

### `app-server/src/request_processors/apps_processor.rs`

`domain_logic` · `request handling and background refresh`

This processor owns app-list retrieval for the app-server. `AppsRequestProcessor` carries auth, thread/config managers, the outgoing sender, a workspace-settings cache, and a cancellation token used to stop in-flight app-list work during shutdown. The public `apps_list` method delegates to `apps_list_inner`, which optionally loads a thread to derive fallback cwd and feature overrides, reloads config, checks whether the Apps feature is enabled for the current auth mode, and checks the workspace-level Codex plugins setting. If either gate is closed, it returns an empty `AppsListResponse` immediately.

Otherwise, `apps_list_inner` spawns `apps_list_task` and returns `Ok(None)`, meaning the eventual JSON-RPC response will be sent asynchronously through `OutgoingMessageSender`. The task calls `apps_list_response`, which merges two data sources: accessible connectors discovered from MCP tools and the full connector directory list. It starts from cached values, then launches two background fetches over an unbounded channel. As partial results arrive before a 90-second deadline, it merges them with `connectors::merge_connectors_with_accessible`, applies enabled-state filtering from config, and emits `AppListUpdated` notifications whenever there is something meaningful to show. During force-refetch, it can temporarily combine fresh accessibility data with cached directory data to avoid regressing the visible list.

Once both sources are loaded, it paginates by numeric cursor and optional limit. If the first pass reports `codex_apps_ready == false`, `apps_list_task` sends the response anyway and then performs one silent retry with `force_refetch = true` to warm caches for future calls.

#### Function details

##### `AppsRequestProcessor::new`  (lines 14–32)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        config_manager: ConfigManager,
        workspace_setti
```

**Purpose**: Constructs the apps request processor and derives a drop guard from the shutdown token so cancellation propagates with processor lifetime.

**Data flow**: Consumes auth/thread/outgoing/config-manager/workspace-settings-cache dependencies plus a `CancellationToken`, clones the token to create a `DropGuard`, stores all fields, and returns `Self`.

**Call relations**: Called during request-processor assembly at startup.

*Call graph*: called by 1 (new); 1 external calls (clone).


##### `AppsRequestProcessor::apps_list`  (lines 34–42)

```
async fn apps_list(
        &self,
        request_id: &ConnectionRequestId,
        params: AppsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for listing apps. It delegates to the inner implementation and converts any typed response into `ClientResponsePayload`.

**Data flow**: Takes a request ID reference and `AppsListParams`, awaits `apps_list_inner`, maps `Option<AppsListResponse>` through `Into::into`, and returns `Result<Option<ClientResponsePayload>, JSONRPCErrorError>`.

**Call relations**: Invoked by the initialized request dispatcher for `apps/list`.

*Call graph*: calls 1 internal fn (apps_list_inner); called by 1 (handle_initialized_client_request).


##### `AppsRequestProcessor::apps_list_inner`  (lines 44–109)

```
async fn apps_list_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: AppsListParams,
    ) -> Result<Option<AppsListResponse>, JSONRPCErrorError>
```

**Purpose**: Validates feature gates and workspace settings for `apps/list`, then either returns an immediate empty response or spawns asynchronous app-list computation.

**Data flow**: Optionally loads the referenced thread to obtain a `CodexThread`, derives `fallback_cwd` from the thread config snapshot when present, reloads config, overlays the thread’s Apps feature flag onto config when a thread was supplied, reads current auth, returns an empty `AppsListResponse` if apps are disabled for auth or workspace Codex plugins are disabled, otherwise clones routing/dependency state, creates a child shutdown token, spawns a task that races shutdown against `apps_list_task(...)`, and returns `Ok(None)`.

**Call relations**: Called only by `apps_list`; it is the decision point between synchronous empty results and asynchronous background fulfillment.

*Call graph*: calls 3 internal fn (load_latest_config, load_thread, workspace_codex_plugins_enabled); called by 1 (apps_list); 6 external calls (clone, child_token, new, clone, select!, spawn).


##### `AppsRequestProcessor::shutdown`  (lines 111–113)

```
fn shutdown(&self)
```

**Purpose**: Cancels any in-flight app-list background work owned by this processor.

**Data flow**: Calls `self.shutdown_token.cancel()` and returns unit.

**Call relations**: Used during runtime teardown/cleanup.

*Call graph*: called by 1 (clear_runtime_references); 1 external calls (cancel).


##### `AppsRequestProcessor::apps_list_task`  (lines 115–161)

```
async fn apps_list_task(
        outgoing: Arc<OutgoingMessageSender>,
        request_id: ConnectionRequestId,
        params: AppsListParams,
        config: Config,
        environment_manager: Arc
```

**Purpose**: Runs the asynchronous app-list computation, sends the final JSON-RPC result, and optionally performs one silent force-refetch retry when Codex apps were not yet ready.

**Data flow**: Clones params/config/managers for possible retry, awaits `apps_list_response`, computes `should_retry` from the returned `codex_apps_ready` flag, sends the response portion through `outgoing.send_result(request_id, ...)`, and if a retry is warranted and the original request did not already force refetch, reruns `apps_list_response` with `force_refetch = true`, logging but otherwise ignoring any retry failure.

**Call relations**: Spawned by `apps_list_inner`; it is the async driver that eventually resolves the client request.

*Call graph*: 5 external calls (clone, apps_list_response, clone, clone, warn!).


##### `AppsRequestProcessor::apps_list_response`  (lines 163–309)

```
async fn apps_list_response(
        outgoing: &Arc<OutgoingMessageSender>,
        params: AppsListParams,
        config: Config,
        environment_manager: Arc<EnvironmentManager>,
        mcp_ma
```

**Purpose**: Loads, merges, incrementally publishes, and paginates app/connector data from cached and refreshed sources.

**Data flow**: Consumes outgoing sender, request params, config, and environment/MCP/plugin managers; parses `cursor` into a start index, loads effective plugin apps, concurrently fetches cached accessible connectors and cached full connector list, spawns two refresh tasks that send `AppListLoadResult` values over an unbounded channel, optionally emits an initial `AppListUpdated` notification from cached data, then loops receiving refresh results until both accessible and full lists are loaded or a 90-second deadline expires. After each partial update it merges lists with `merge_loaded_apps`, applies enabled-state filtering with `connectors::with_app_enabled_state`, conditionally emits deduplicated `AppListUpdated` notifications via `send_app_list_updated_notification`, and once both sources are loaded returns `(paginate_apps(...), codex_apps_ready)`.

**Call relations**: Called by `apps_list_task`; it delegates merging, notification gating, pagination, and connector discovery to helper functions and external connector APIs.

*Call graph*: calls 7 internal fn (merge_loaded_apps, paginate_apps, send_app_list_updated_notification, should_send_app_list_updated_notification, list_all_connectors_with_options, list_accessible_connectors_from_mcp_tools_with_mcp_manager, with_app_enabled_state); 11 external calls (clone, clone, plugins_config_input, Accessible, Directory, format!, join!, spawn, unbounded_channel, now (+1 more)).


##### `AppsRequestProcessor::load_thread`  (lines 311–325)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Parses a thread ID string and loads the corresponding thread from `ThreadManager`.

**Data flow**: Converts `thread_id: &str` into `ThreadId` with `ThreadId::from_string`, maps parse failure to `invalid_request`, awaits `thread_manager.get_thread(thread_id)`, maps missing thread to `invalid_request`, and returns the parsed ID plus loaded `Arc<CodexThread>`.

**Call relations**: Used by `apps_list_inner` when the request scopes app listing to a specific thread.

*Call graph*: calls 1 internal fn (from_string); called by 1 (apps_list_inner).


##### `AppsRequestProcessor::load_latest_config`  (lines 327–335)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the latest effective config and maps reload failures into JSON-RPC internal errors.

**Data flow**: Takes an optional fallback cwd, awaits `config_manager.load_latest_config(fallback_cwd)`, and returns either the `Config` or `internal_error("failed to reload config: ...")`.

**Call relations**: Used by `apps_list_inner` before feature gating and connector loading.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (apps_list_inner).


##### `AppsRequestProcessor::workspace_codex_plugins_enabled`  (lines 337–357)

```
async fn workspace_codex_plugins_enabled(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> bool
```

**Purpose**: Checks the workspace-level setting that can disable Codex plugins, defaulting to permissive behavior on lookup failure.

**Data flow**: Calls `workspace_settings::codex_plugins_enabled_for_workspace(config, auth, Some(&workspace_settings_cache))`, returns the boolean on success, and on error logs a warning and returns `true`.

**Call relations**: Used by `apps_list_inner` as a gate before any app discovery work begins.

*Call graph*: calls 1 internal fn (codex_plugins_enabled_for_workspace); called by 1 (apps_list_inner); 1 external calls (warn!).


##### `merge_loaded_apps`  (lines 367–375)

```
fn merge_loaded_apps(
    all_connectors: Option<&[AppInfo]>,
    accessible_connectors: Option<&[AppInfo]>,
) -> Vec<AppInfo>
```

**Purpose**: Combines the full connector list and accessible connector list into one merged app list while preserving whether the full list has been loaded yet.

**Data flow**: Takes optional slices for all connectors and accessible connectors, records whether the full list is present, clones each slice into owned vectors or empty vectors, and passes them to `connectors::merge_connectors_with_accessible`, returning the merged `Vec<AppInfo>`.

**Call relations**: Used repeatedly by `apps_list_response` whenever cached or refreshed connector data changes.

*Call graph*: calls 1 internal fn (merge_connectors_with_accessible); called by 1 (apps_list_response).


##### `should_send_app_list_updated_notification`  (lines 377–383)

```
fn should_send_app_list_updated_notification(
    connectors: &[AppInfo],
    accessible_loaded: bool,
    all_loaded: bool,
) -> bool
```

**Purpose**: Determines whether the current merged app list is meaningful enough to publish as an `AppListUpdated` notification.

**Data flow**: Reads the merged connector slice plus booleans indicating whether accessible and full lists have loaded; returns true if any connector is accessible or if both sources have finished loading.

**Call relations**: Called by `apps_list_response` before sending initial or incremental notifications.

*Call graph*: called by 1 (apps_list_response); 1 external calls (iter).


##### `paginate_apps`  (lines 385–407)

```
fn paginate_apps(
    connectors: &[AppInfo],
    start: usize,
    limit: Option<u32>,
) -> Result<AppsListResponse, JSONRPCErrorError>
```

**Purpose**: Slices the merged app list according to numeric cursor and optional limit, producing the final `AppsListResponse` page.

**Data flow**: Reads `connectors.len()` as total, returns `invalid_request` if `start > total`, computes `effective_limit` as `limit.unwrap_or(total as u32).max(1)`, computes `end` with saturating addition capped at total, clones `connectors[start..end]` into `data`, computes `next_cursor` as `Some(end.to_string())` when more items remain, and returns `AppsListResponse { data, next_cursor }`.

**Call relations**: Used by `apps_list_response` once both connector sources are loaded.

*Call graph*: called by 1 (apps_list_response); 2 external calls (len, format!).


##### `send_app_list_updated_notification`  (lines 409–418)

```
async fn send_app_list_updated_notification(
    outgoing: &Arc<OutgoingMessageSender>,
    data: Vec<AppInfo>,
)
```

**Purpose**: Broadcasts the current merged app list as an `AppListUpdated` server notification.

**Data flow**: Takes the outgoing sender and a `Vec<AppInfo>`, wraps it in `AppListUpdatedNotification`, sends it via `OutgoingMessageSender::send_server_notification`, and returns unit.

**Call relations**: Called by `apps_list_response` for initial cached-state publication and later incremental updates.

*Call graph*: called by 1 (apps_list_response); 1 external calls (AppListUpdated).


### Interactive file search
This adapter exposes one-shot and session-based fuzzy file search, managing result translation, limits, cancellation, and stale-update suppression.

### `app-server/src/fuzzy_file_search.rs`

`domain_logic` · `request handling`

This file is the server-side adapter around the `codex_file_search` engine. It exposes two modes: `run_fuzzy_file_search` for a single async search request that returns a `Vec<FuzzyFileSearchResult>`, and `start_fuzzy_file_search_session` for long-lived incremental searches that stream updates through `OutgoingMessageSender`. Both modes derive a bounded worker count from `std::thread::available_parallelism()`, cap it at `MAX_THREADS` (12), and use a fixed non-zero `MATCH_LIMIT` of 50 with `compute_indices: true` so callers receive match highlight positions.

The one-shot path offloads the blocking search to `tokio::task::spawn_blocking`, converts each engine match into protocol types (`FuzzyFileSearchMatchType`, `FuzzyFileSearchResult`), logs failures with `tracing::warn!`, and always returns a score-descending/path-ascending sorted list. The session path builds a `FuzzyFileSearchSession` wrapper around `file_search::FileSearchSession` plus shared state: session id, latest query string, Tokio runtime handle, outgoing sender, and a cancellation flag. `update_query` records the newest query before forwarding it to the engine; `Drop` marks the session canceled so later callbacks become no-ops.

`SessionReporterImpl` is the bridge from engine callbacks to protocol notifications. It rejects updates after cancellation and, critically, ignores snapshots whose `snapshot.query` no longer matches the mutex-protected latest query, preventing stale incremental results from being emitted after rapid query changes. Empty queries intentionally produce empty file lists even if the engine snapshot contains matches. Notifications are dispatched by spawning async sends onto the captured runtime handle, keeping the reporter callback itself synchronous.

#### Function details

##### `run_fuzzy_file_search`  (lines 21–91)

```
async fn run_fuzzy_file_search(
    query: String,
    roots: Vec<String>,
    cancellation_flag: Arc<AtomicBool>,
) -> Vec<FuzzyFileSearchResult>
```

**Purpose**: Executes a single fuzzy file search across the provided root directories and returns protocol-ready results. It is the non-session API used when the caller wants one completed result set rather than incremental updates.

**Data flow**: It takes a search `query`, a list of root path strings, and an `Arc<AtomicBool>` cancellation flag. It immediately returns an empty vector when `roots` is empty; otherwise it computes non-zero `limit` and `threads`, converts roots into `Vec<PathBuf>`, runs `file_search::run` inside `spawn_blocking`, maps successful engine matches into `FuzzyFileSearchResult` values with stringified paths, file names, scores, indices, and translated match types, logs and suppresses both search errors and join errors by returning `Vec::new()`, then sorts the collected results by descending score and ascending path before returning them.

**Call relations**: It is invoked by the higher-level `fuzzy_file_search` request path. Internally it delegates the actual filesystem search to `codex_file_search::run` on a blocking worker thread because the search is CPU/IO heavy, and uses the shared comparator helper from that crate to normalize result ordering before handing results back to its caller.

*Call graph*: called by 1 (fuzzy_file_search); 5 external calls (new, new, available_parallelism, spawn_blocking, warn!).


##### `FuzzyFileSearchSession::update_query`  (lines 99–109)

```
fn update_query(&self, query: String)
```

**Purpose**: Pushes a new interactive query into an existing search session while recording it as the authoritative latest query for stale-update filtering. It is the mutation point clients use as the user types.

**Data flow**: It receives the new `query` string and reads `self.shared.canceled`. If cancellation has already been marked, it returns without changing anything. Otherwise it locks `self.shared.latest_query`, overwrites the stored string with a clone of the new query, releases the mutex, and forwards the query text to the underlying `file_search::FileSearchSession::update_query` method.

**Call relations**: This method is called by whatever session-management layer holds a `FuzzyFileSearchSession` after `start_fuzzy_file_search_session` has created it. Its stored `latest_query` is later read by `SessionReporterImpl::send_snapshot` so callback snapshots can be dropped when they correspond to an older query than the most recently submitted one.

*Call graph*: calls 1 internal fn (update_query).


##### `FuzzyFileSearchSession::drop`  (lines 113–115)

```
fn drop(&mut self)
```

**Purpose**: Marks the session as canceled when the wrapper is dropped so no further notifications are emitted from late callbacks. It is the cleanup hook that turns session teardown into a shared-state signal.

**Data flow**: It has no explicit inputs beyond `&mut self`. On drop it writes `true` into `self.shared.canceled` using relaxed atomic ordering and returns no value.

**Call relations**: This runs automatically when the owning code releases the session object. `SessionReporterImpl::send_snapshot`, `SessionReporterImpl::send_complete`, and `FuzzyFileSearchSession::update_query` all consult the same atomic flag, so this drop-side write suppresses future updates and completion notifications after teardown.


##### `start_fuzzy_file_search_session`  (lines 118–158)

```
fn start_fuzzy_file_search_session(
    session_id: String,
    roots: Vec<String>,
    outgoing: Arc<OutgoingMessageSender>,
) -> anyhow::Result<FuzzyFileSearchSession>
```

**Purpose**: Constructs a long-lived fuzzy search session wired to emit server notifications for incremental updates and completion. It packages engine state and server-side coordination state into a `FuzzyFileSearchSession` wrapper.

**Data flow**: It takes a `session_id`, root directory strings, and an `Arc<OutgoingMessageSender>`. It computes non-zero `limit` and bounded `threads`, converts roots to `Vec<PathBuf>`, creates a shared cancellation flag, builds `SessionShared` containing the session id, an initially empty `Mutex<String>` for `latest_query`, the outgoing sender, the current Tokio runtime handle, and the cancellation flag, wraps that in `SessionReporterImpl`, and passes the search dirs, `FileSearchOptions`, reporter, and cancellation flag into `file_search::create_session`. On success it returns `Ok(FuzzyFileSearchSession { ... })`; any engine setup failure is propagated as `anyhow::Result::Err`.

**Call relations**: It is called by `fuzzy_file_search_session_start_response` when the server begins an interactive search session. It delegates session creation to the underlying search crate and installs `SessionReporterImpl` as the callback sink so later engine updates flow back into protocol notifications.

*Call graph*: called by 1 (fuzzy_file_search_session_start_response); 9 external calls (new, new, default, new, new, new, create_session, available_parallelism, current).


##### `SessionReporterImpl::send_snapshot`  (lines 173–203)

```
fn send_snapshot(&self, snapshot: &file_search::FileSearchSnapshot)
```

**Purpose**: Transforms an engine snapshot into a `FuzzyFileSearchSessionUpdated` server notification and schedules it for async delivery, but only when the snapshot still matches the latest active query. This is the core stale-result filter for interactive search.

**Data flow**: It takes a borrowed `file_search::FileSearchSnapshot` and reads `self.shared.canceled`; if canceled, it returns immediately. It then clones the current query from `self.shared.latest_query`; if `snapshot.query` differs from that stored query, it returns without sending anything. For a matching snapshot, it produces `files` as `Vec::new()` when the query is empty, otherwise by calling `collect_files(snapshot)`. It builds `ServerNotification::FuzzyFileSearchSessionUpdated` with the shared session id, query, and files, clones the outgoing sender, and uses the stored Tokio runtime handle to spawn an async task that sends the notification.

**Call relations**: It is invoked only from `SessionReporterImpl::on_update`, which is the `file_search::SessionReporter` callback entrypoint used by the search engine. It delegates result conversion and sorting to `collect_files`, and hands off actual network/message emission to `OutgoingMessageSender` in a spawned async task so the synchronous callback path stays lightweight.

*Call graph*: calls 1 internal fn (collect_files); called by 1 (on_update); 2 external calls (FuzzyFileSearchSessionUpdated, new).


##### `SessionReporterImpl::send_complete`  (lines 205–217)

```
fn send_complete(&self)
```

**Purpose**: Emits the session-completed notification once the underlying search engine reports completion, unless the session has already been canceled. It is the terminal callback bridge for session searches.

**Data flow**: It reads the shared cancellation flag and returns early if set. Otherwise it clones the `session_id` and outgoing sender from shared state, then uses the stored runtime handle to spawn an async task that constructs `ServerNotification::FuzzyFileSearchSessionCompleted` and sends it through `OutgoingMessageSender`.

**Call relations**: It is called only by `SessionReporterImpl::on_complete`, the engine callback for session completion. Unlike `send_snapshot`, it does not inspect query state or collect files; its sole job is to notify the client that no more updates are expected.

*Call graph*: called by 1 (on_complete); 1 external calls (FuzzyFileSearchSessionCompleted).


##### `SessionReporterImpl::on_update`  (lines 221–223)

```
fn on_update(&self, snapshot: &file_search::FileSearchSnapshot)
```

**Purpose**: Implements the search engine's update callback by forwarding each snapshot into the reporter's snapshot-sending logic. It is a thin trait adapter.

**Data flow**: It accepts a borrowed `file_search::FileSearchSnapshot`, performs no transformation itself, and returns the result of calling `self.send_snapshot(snapshot)`.

**Call relations**: This method is invoked by the `codex_file_search` session machinery whenever incremental results are available. Its only delegation is to `send_snapshot`, where cancellation checks, stale-query filtering, result conversion, and notification dispatch actually occur.

*Call graph*: calls 1 internal fn (send_snapshot).


##### `SessionReporterImpl::on_complete`  (lines 225–227)

```
fn on_complete(&self)
```

**Purpose**: Implements the search engine's completion callback by forwarding to the completion notification helper. It is the trait-level endpoint for end-of-session signaling.

**Data flow**: It takes no additional inputs beyond `&self`, performs no local state changes, and simply calls `self.send_complete()` before returning.

**Call relations**: This method is invoked by the `codex_file_search` session machinery when the session finishes. It delegates all meaningful work to `send_complete`, which checks cancellation and schedules the outgoing completion notification.

*Call graph*: calls 1 internal fn (send_complete).


##### `collect_files`  (lines 230–256)

```
fn collect_files(snapshot: &file_search::FileSearchSnapshot) -> Vec<FuzzyFileSearchResult>
```

**Purpose**: Converts a search snapshot's current matches into sorted protocol result objects suitable for session update notifications. It centralizes the snapshot-to-wire-format mapping used by incremental updates.

**Data flow**: It takes a borrowed `file_search::FileSearchSnapshot`, iterates over `snapshot.matches`, and for each match extracts `root`, full `path`, `file_name` from `path.file_name().unwrap_or_default()`, translates the engine `MatchType` into `FuzzyFileSearchMatchType`, copies `score`, and clones `indices` into a new `FuzzyFileSearchResult`. After collecting into a vector, it sorts the vector by descending score and ascending path using the shared comparator helper and returns the sorted results.

**Call relations**: It is called only from `SessionReporterImpl::send_snapshot` when the current query is non-empty. By isolating the mapping and sorting logic here, the reporter can focus on callback policy decisions such as cancellation and stale-query suppression.

*Call graph*: called by 1 (send_snapshot).
