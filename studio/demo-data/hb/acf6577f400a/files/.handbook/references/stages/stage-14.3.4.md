# App-server integration discovery and search adapters  `stage-14.3.4`

This stage is part of the app server’s main work: answering client requests when a user wants to discover apps, connectors, or files. It acts like a front desk that gathers information from several shelves, cleans it up, and returns a usable list.

The connector helpers prepare app discovery data. accessible.rs takes raw connector tools and turns them into user-facing apps, grouping duplicates and adding friendly names and descriptions. filter.rs decides what should be visible, hiding blocked connectors and avoiding suggestions for apps the user already has. merge.rs combines several connector lists into one best version, keeping the strongest name, description, logo, install link, and access state.

apps_processor.rs is the coordinator. It receives app-list requests from clients, checks whether app access is allowed, pulls data from cached and live sources, reports progress, and returns results in pages.

fuzzy_file_search.rs supports searching files and folders by approximate text matches, like typing a few letters into an editor’s “open file” box. It can run a single search or maintain a live session that updates as the query changes.

## Files in this stage

### Connector catalog shaping
These files build, filter, and merge connector and plugin data into the app-facing catalog used by discovery flows.

### `connectors/src/accessible.rs`

`domain_logic` · `when building the accessible connector list`

A connector can expose more than one tool, and those tools may repeat the same connector information in slightly different ways. This file acts like a tidy front desk: it takes many tool records, groups them by connector, chooses the best available name and description, removes duplicate plugin names, and returns one clear app entry per connector.

The input type, `AccessibleConnectorTool`, is a small bundle of facts about a tool: which connector it belongs to, optional human-friendly connector text, and the plugin display names attached to it. The main function builds `AppInfo` records, which are the app-shaped objects used by the server protocol. If a connector first appears with only its raw ID as a name, but a later tool has a better display name, the better name replaces it. If a description is missing at first but appears later, it is kept. Plugin display names are stored in a sorted set so duplicates disappear and the final list is stable.

At the end, the function adds an install URL for each connector and sorts the apps so the output is predictable. Without this file, callers would see messy, repeated, or incomplete connector listings instead of a polished list of accessible apps.

#### Function details

##### `collect_accessible_connectors`  (lines 15–76)

```
fn collect_accessible_connectors(tools: I) -> Vec<AppInfo>
```

**Purpose**: This function takes many tool-level connector records and turns them into one clean `AppInfo` entry per connector. It is used when the system needs to show which connector-backed apps are available to the user.

**Data flow**: It receives an iterable collection of `AccessibleConnectorTool` values. For each one, it reads the connector ID, optional name, optional description, and plugin display names. It normalizes the optional text, groups records with the same connector ID, keeps the best available name and description, and merges plugin display names while removing duplicates. It then creates install URLs, marks the connector as accessible and enabled, sorts the final app list by accessibility, name, and ID, and returns a `Vec<AppInfo>`.

**Call relations**: This function is called by `accessible_connectors_from_mcp_tools` after raw MCP tool information has been turned into connector-shaped inputs. During its work it calls `normalize_connector_value` to clean up optional text values, and it uses `connector_install_url` to produce the install link that is placed on each final app entry.

*Call graph*: called by 1 (accessible_connectors_from_mcp_tools); 3 external calls (new, new, normalize_connector_value).


### `connectors/src/filter.rs`

`domain_logic` · `request handling`

Connectors are outside services or apps that Codex can work with, such as calendar or email integrations. This file is a gatekeeper for those connectors. Without it, the product could show connectors that are intentionally hidden, suggest apps the user already has, or present results in a confusing order.

The main flow starts with a list of connectors from a directory. Some connector IDs are on hard-coded block lists. Which block list is used depends on where the request came from, called the “originator.” For example, first-party chat clients use a different blocked ID list than the command-line client.

For tool suggestions, the file applies several filters like a careful shop assistant: first remove banned items, then remove anything the customer already owns, then keep only items marked as discoverable. Finally, it sorts the remaining connectors by display name, with ID as a tie-breaker, so the result is predictable.

The tests in this file protect the important edge cases: normal connectors stay visible, specific blocked IDs disappear, first-party chat uses its special rule, and already accessible connectors are not suggested even if they are disabled.

#### Function details

##### `filter_tool_suggest_discoverable_connectors`  (lines 5–28)

```
fn filter_tool_suggest_discoverable_connectors(
    directory_connectors: Vec<AppInfo>,
    accessible_connectors: &[AppInfo],
    discoverable_connector_ids: &HashSet<String>,
    originator_value: &
```

**Purpose**: Builds the list of connector apps that should be suggested as discoverable tools. It is used when the system wants to recommend connectors the user does not already have access to.

**Data flow**: It receives a directory list of connectors, a list of connectors the user can already access, a set of connector IDs that are allowed to be discovered, and the request originator. It first records the IDs of already accessible connectors, removes disallowed connectors, removes already accessible ones, keeps only discoverable IDs, sorts the survivors by name and then ID, and returns that final list.

**Call relations**: This function is called by the tool-discovery flow, specifically `list_tool_suggest_discoverable_tools_with_auth`, and by tests that check suggestion behavior. Inside its work, it hands the directory list to `filter_disallowed_connectors` first, because blocked connectors must be removed before anything can be suggested.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); called by 3 (filter_tool_suggest_discoverable_connectors_excludes_accessible_apps_even_when_disabled, filter_tool_suggest_discoverable_connectors_keeps_only_plugin_backed_uninstalled_apps, list_tool_suggest_discoverable_tools_with_auth); 1 external calls (iter).


##### `filter_disallowed_connectors`  (lines 41–52)

```
fn filter_disallowed_connectors(
    connectors: Vec<AppInfo>,
    originator_value: &str,
) -> Vec<AppInfo>
```

**Purpose**: Removes connectors whose exact IDs are on a block list. Other parts of the connector system use it whenever they need a cleaned list that should not include hidden or disallowed apps.

**Data flow**: It receives a list of `AppInfo` connector records and an originator string. It checks whether the originator is a first-party chat client, uses that answer to choose the right block list, keeps only connector records whose IDs are allowed, and returns the filtered list.

**Call relations**: This is the shared cleanup step used by several connector flows, including plugin connector merging, accessible connector merging, connector lookup for plugin apps, and tool suggestion filtering. It calls `is_first_party_chat_originator` to decide which rule set applies before checking each connector.

*Call graph*: calls 1 internal fn (is_first_party_chat_originator); called by 10 (connectors_for_plugin_apps, merge_and_filter_plugin_connectors, merge_connectors_with_accessible, filter_tool_suggest_discoverable_connectors, filter_disallowed_connectors_allows_non_disallowed_connectors, filter_disallowed_connectors_allows_openai_prefix, filter_disallowed_connectors_filters_disallowed_connector_ids, first_party_chat_originator_filters_target_connector_ids, list_accessible_connectors_from_mcp_tools_with_mcp_manager, refresh_accessible_connectors_cache_from_mcp_tools).


##### `is_first_party_chat_originator`  (lines 54–56)

```
fn is_first_party_chat_originator(originator_value: &str) -> bool
```

**Purpose**: Answers whether a request came from one of the known first-party chat clients. This matters because those clients use a special connector block list.

**Data flow**: It receives an originator string and compares it with the known values `codex_atlas` and `codex_chatgpt_desktop`. It returns `true` if the string matches either one, otherwise `false`.

**Call relations**: `filter_disallowed_connectors` calls this before filtering connector IDs. Its answer decides whether the normal disallowed list or the first-party chat disallowed list is used.

*Call graph*: called by 1 (filter_disallowed_connectors).


##### `is_connector_id_allowed`  (lines 58–66)

```
fn is_connector_id_allowed(connector_id: &str, first_party_chat_originator: bool) -> bool
```

**Purpose**: Checks one connector ID against the appropriate block list and says whether it may remain visible. It is the small yes-or-no rule behind the broader filtering function.

**Data flow**: It receives a connector ID and a boolean saying whether the originator is first-party chat. It chooses the matching disallowed-ID list, checks whether the connector ID appears there, and returns `true` only when the ID is not blocked.

**Call relations**: It fits into the connector filtering step as the per-connector decision maker. `filter_disallowed_connectors` uses this kind of check while walking through a list of connector records.


##### `tests::app`  (lines 74–90)

```
fn app(id: &str) -> AppInfo
```

**Purpose**: Creates a simple test connector record with predictable default values. This keeps the tests focused on filtering behavior instead of repeating long setup code.

**Data flow**: It receives an ID string. It builds an `AppInfo` record where the ID and name are both that string, most optional fields are empty, the connector is not accessible, and it is enabled, then returns that record.

**Call relations**: The test cases call this helper whenever they need a plain connector. `tests::named_app` also builds on it when a test needs a connector with a separate display name and install URL.

*Call graph*: 1 external calls (new).


##### `tests::named_app`  (lines 92–99)

```
fn named_app(id: &str, name: &str) -> AppInfo
```

**Purpose**: Creates a test connector with a real-looking name and install URL. It is used in tests where sorting, display names, or suggestion results need to look closer to real connector data.

**Data flow**: It receives an ID and a display name. It starts from the default test connector made by `tests::app`, replaces the name, adds an install URL generated by `connector_install_url`, and returns the completed `AppInfo` record.

**Call relations**: The tool-suggestion tests call this helper to build realistic connector inputs and expected outputs. It delegates the common default fields to `tests::app` and the URL formatting to `connector_install_url`.

*Call graph*: calls 1 internal fn (connector_install_url); 1 external calls (app).


##### `tests::filter_disallowed_connectors_allows_non_disallowed_connectors`  (lines 102–106)

```
fn filter_disallowed_connectors_allows_non_disallowed_connectors()
```

**Purpose**: Checks that ordinary connector IDs are not removed just because they have unusual names. This protects against the filter becoming too broad.

**Data flow**: It creates two test connector records, passes them through `filter_disallowed_connectors` with the `codex_cli` originator, and compares the result with the original two records. The expected outcome is that both remain.

**Call relations**: This test calls `filter_disallowed_connectors` directly. It acts as a safety check for callers that depend on the filter only removing exact blocked IDs.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::filter_disallowed_connectors_allows_openai_prefix`  (lines 109–126)

```
fn filter_disallowed_connectors_allows_openai_prefix()
```

**Purpose**: Checks that connector IDs with an OpenAI-style prefix are allowed unless their exact ID is blocked. This prevents accidental filtering by prefix alone.

**Data flow**: It creates three connector records, including two whose IDs start with `connector_openai_`, and sends them through `filter_disallowed_connectors`. It then asserts that all three are still present afterward.

**Call relations**: This test exercises `filter_disallowed_connectors` directly. It documents an important behavior for connector-merging and listing flows: the block list is exact-ID based, not prefix based.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::filter_disallowed_connectors_filters_disallowed_connector_ids`  (lines 129–139)

```
fn filter_disallowed_connectors_filters_disallowed_connector_ids()
```

**Purpose**: Checks that connector IDs on the normal disallowed list are actually removed. This is the basic protection that keeps known hidden connectors from appearing.

**Data flow**: It builds a list containing two blocked connector IDs and one ordinary ID, then passes the list to `filter_disallowed_connectors` with the `codex_cli` originator. The expected result contains only the ordinary connector.

**Call relations**: This test calls `filter_disallowed_connectors` directly. It verifies the behavior relied on by connector listing, merging, and suggestion code.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::first_party_chat_originator_filters_target_connector_ids`  (lines 142–158)

```
fn first_party_chat_originator_filters_target_connector_ids()
```

**Purpose**: Checks that first-party chat clients use their special block list rather than the normal one. This matters because the same connector can be allowed in one client but hidden in another.

**Data flow**: It builds a list with an OpenAI-prefixed connector, a connector from the normal block list, and a connector from the first-party chat block list. It filters them using the `codex_atlas` originator and expects only the first-party-chat-blocked connector to be removed.

**Call relations**: This test calls `filter_disallowed_connectors`, which in turn uses the originator check. It protects the product-specific behavior for first-party chat surfaces.

*Call graph*: calls 1 internal fn (filter_disallowed_connectors); 2 external calls (assert_eq!, vec!).


##### `tests::filter_tool_suggest_discoverable_connectors_keeps_only_plugin_backed_uninstalled_apps`  (lines 161–192)

```
fn filter_tool_suggest_discoverable_connectors_keeps_only_plugin_backed_uninstalled_apps()
```

**Purpose**: Checks that tool suggestions include only discoverable connectors the user has not already installed or gained access to. This prevents duplicate or irrelevant suggestions.

**Data flow**: It creates a directory list containing Google Calendar, Gmail, and another connector. It marks Google Calendar as already accessible, marks only Google Calendar and Gmail as discoverable, then calls `filter_tool_suggest_discoverable_connectors`. The expected result is Gmail only.

**Call relations**: This test calls `filter_tool_suggest_discoverable_connectors`, the same function used by the authenticated tool-discovery path. It verifies the combined behavior of removing already accessible connectors and keeping only discoverable ones.

*Call graph*: calls 1 internal fn (filter_tool_suggest_discoverable_connectors); 4 external calls (from, assert_eq!, named_app, vec!).


##### `tests::filter_tool_suggest_discoverable_connectors_excludes_accessible_apps_even_when_disabled`  (lines 195–226)

```
fn filter_tool_suggest_discoverable_connectors_excludes_accessible_apps_even_when_disabled()
```

**Purpose**: Checks that accessible connectors are excluded from suggestions even if they are currently disabled. In plain terms, if the user already has access to it, the system should not recommend it as new.

**Data flow**: It creates two directory connectors, then creates an accessible list where both are accessible and one is disabled. It passes these lists plus the discoverable ID set to `filter_tool_suggest_discoverable_connectors`. The expected result is an empty list.

**Call relations**: This test calls `filter_tool_suggest_discoverable_connectors` directly. It protects a subtle rule used by tool suggestion callers: accessibility, not enabled state, decides whether a connector is already owned for suggestion purposes.

*Call graph*: calls 1 internal fn (filter_tool_suggest_discoverable_connectors); 4 external calls (from, assert_eq!, named_app, vec!).


### `connectors/src/merge.rs`

`domain_logic` · `connector discovery and listing`

A connector is an app or service that the system can talk to, such as Google Calendar. This file solves a common bookkeeping problem: the project may learn about the same connector from different places. One source may only know that a plugin exists. Another source may know that the user can actually access it and may include richer details like a friendly name, logo, or description. Without this file, users could see duplicate connectors, missing names, or connectors marked incorrectly as available or unavailable.

The main merge step uses the connector id as the stable identity, like using a passport number instead of a display name. It first stores the ordinary connector list and marks those entries as not accessible. Then it folds in the accessible connector list, marking matching entries as accessible and filling in missing details. If an earlier entry only had a placeholder name equal to its id, the richer accessible name replaces it. Plugin display names are combined, sorted, and duplicates are removed.

The file also creates placeholder connector records for plugin ids when no full app metadata is known yet. These placeholders still get an install URL so the UI has somewhere useful to send the user. Finally, merged lists are sorted so accessible and well-named connectors appear in a predictable order.

#### Function details

##### `merge_connectors`  (lines 8–58)

```
fn merge_connectors(
    connectors: Vec<AppInfo>,
    accessible_connectors: Vec<AppInfo>,
) -> Vec<AppInfo>
```

**Purpose**: Combines a general connector list with a list of connectors the user can access. It removes duplicates by connector id and keeps the richest information available for each connector.

**Data flow**: It receives two lists of AppInfo records: one general list and one accessible list. It turns the general list into a lookup table by id and marks those entries as not accessible. Then it walks through the accessible list, marks each as accessible, updates any matching existing entry with better missing details, and adds new entries when needed. Before returning, it fills in missing install URLs, sorts and removes duplicate plugin display names, sorts the whole list, and returns the cleaned connector list.

**Call relations**: Higher-level code calls this when it has connector information from more than one source and needs one final answer. It relies on connector_install_url to create a fallback install link and sort_connectors_by_accessibility_and_name to put the result in user-friendly order. It is also exercised by the tests that check placeholder replacement and plugin display name cleanup.

*Call graph*: calls 2 internal fn (connector_install_url, sort_connectors_by_accessibility_and_name); called by 4 (merge_connectors_with_accessible, merge_plugin_connectors_with_accessible, merge_connectors_replaces_plugin_placeholder_name_with_accessible_name, merge_connectors_unions_and_dedupes_plugin_display_names).


##### `merge_plugin_connectors`  (lines 60–78)

```
fn merge_plugin_connectors(connectors: Vec<AppInfo>, plugin_app_ids: I) -> Vec<AppInfo>
```

**Purpose**: Adds plugin-based connectors to an existing connector list without creating duplicates. It is useful when the system has discovered plugin app ids but may not have full app metadata for all of them.

**Data flow**: It receives an existing list of AppInfo records and an iterable collection of plugin app ids. It records the ids already present, then creates a placeholder AppInfo for each new plugin id that is not already in the list. It sorts the expanded list and returns it.

**Call relations**: Connector discovery flows call this when plugin app ids need to be folded into a connector list. For each missing id it hands off to plugin_connector_to_app_info to build a safe placeholder, then uses sort_connectors_by_accessibility_and_name so callers receive a predictable list.

*Call graph*: calls 2 internal fn (plugin_connector_to_app_info, sort_connectors_by_accessibility_and_name); called by 3 (connectors_for_plugin_apps, merge_and_filter_plugin_connectors, list_tool_suggest_discoverable_tools_with_auth).


##### `merge_plugin_connectors_with_accessible`  (lines 80–97)

```
fn merge_plugin_connectors_with_accessible(
    plugin_app_ids: I,
    accessible_connectors: Vec<AppInfo>,
) -> Vec<AppInfo>
```

**Purpose**: Builds plugin connector placeholders only for plugins that also appear in the accessible connector list, then merges them with the richer accessible data. This avoids showing plugin connectors that are not actually accessible.

**Data flow**: It receives plugin app ids and a list of accessible AppInfo records. It first collects the accessible ids into a set, filters the plugin ids down to only those accessible ids, turns each remaining id into a placeholder AppInfo, and then passes those placeholders plus the accessible list into merge_connectors. The result is a merged, enriched, accessibility-aware connector list.

**Call relations**: This function sits between plugin discovery and final connector presentation. Callers such as build_skills_and_plugins and built_tools use it when they need plugin connectors, but only the ones the user can access. It delegates the detailed merging work to merge_connectors.

*Call graph*: calls 1 internal fn (merge_connectors); called by 2 (build_skills_and_plugins, built_tools); 1 external calls (into_iter).


##### `plugin_connector_to_app_info`  (lines 99–119)

```
fn plugin_connector_to_app_info(connector_id: String) -> AppInfo
```

**Purpose**: Creates a minimal AppInfo record from a plugin connector id. This gives the rest of the system a normal connector-shaped object even when only the id is known.

**Data flow**: It receives a connector id string. It uses that id as both the id and temporary name, leaves optional metadata such as description and logos empty, creates an install URL, marks the connector as enabled but not accessible, and returns the new AppInfo record.

**Call relations**: This is the helper used whenever plugin discovery finds an id but no full metadata yet. merge_plugin_connectors and merge_plugin_connectors_with_accessible use its placeholders, and merge_connectors can later replace the placeholder name and fill in missing details if richer accessible metadata arrives.

*Call graph*: calls 1 internal fn (connector_install_url); called by 3 (merge_plugin_connectors, merge_connectors_replaces_plugin_placeholder_name_with_accessible_name, merge_connectors_unions_and_dedupes_plugin_display_names); 1 external calls (new).


##### `tests::plugin_names`  (lines 128–130)

```
fn plugin_names(names: &[&str]) -> Vec<String>
```

**Purpose**: Creates a list of owned string values from simple string slices for tests. It keeps the test setup short and easy to read.

**Data flow**: It receives a slice of text references such as ["alpha", "beta"]. It copies each one into a String and returns a Vec<String> that can be placed into an AppInfo test record.

**Call relations**: The test helpers and assertions use this to build plugin_display_names values. It supports the test that verifies plugin display names are sorted and deduplicated.


##### `tests::google_calendar_accessible_connector`  (lines 132–148)

```
fn google_calendar_accessible_connector(plugin_display_names: &[&str]) -> AppInfo
```

**Purpose**: Builds a realistic accessible Google Calendar connector for tests. It provides known metadata so the merge behavior can be checked clearly.

**Data flow**: It receives a list of plugin display name strings. It converts those names into owned strings, then returns an AppInfo record for a calendar connector with a friendly name, description, logo URLs, distribution channel, and accessible status.

**Call relations**: The merge tests use this helper as the richer accessible connector source. It works with plugin_connector_to_app_info placeholders to prove that merge_connectors fills in better metadata correctly.

*Call graph*: 1 external calls (plugin_names).


##### `tests::merge_connectors_replaces_plugin_placeholder_name_with_accessible_name`  (lines 151–176)

```
fn merge_connectors_replaces_plugin_placeholder_name_with_accessible_name()
```

**Purpose**: Checks that a placeholder plugin connector name is replaced by the real accessible connector name. This protects the user-facing behavior where people should see "Google Calendar" instead of a raw id like "calendar".

**Data flow**: The test creates a placeholder connector from the id "calendar" and a richer accessible Google Calendar connector. It passes both into merge_connectors, then compares the result against the expected single AppInfo record. It also checks that the connector mention slug is based on the friendly name.

**Call relations**: This test calls plugin_connector_to_app_info and google_calendar_accessible_connector to set up the two sources, then calls merge_connectors to exercise the real merge logic. Its assertions document the intended behavior for placeholder name replacement and install URL preservation.

*Call graph*: calls 2 internal fn (merge_connectors, plugin_connector_to_app_info); 3 external calls (assert_eq!, google_calendar_accessible_connector, vec!).


##### `tests::merge_connectors_unions_and_dedupes_plugin_display_names`  (lines 179–205)

```
fn merge_connectors_unions_and_dedupes_plugin_display_names()
```

**Purpose**: Checks that plugin display names from different connector sources are combined, alphabetized, and deduplicated. This prevents repeated names and keeps the final connector record tidy.

**Data flow**: The test creates a placeholder connector with repeated plugin display names and an accessible connector with overlapping names. It passes them into merge_connectors, then compares the output with an expected connector whose plugin display names are exactly ["alpha", "beta", "sample"].

**Call relations**: This test uses plugin_connector_to_app_info, google_calendar_accessible_connector, and plugin_names to create controlled input data. It then calls merge_connectors to verify the cleanup step that sorts and removes duplicate plugin display names.

*Call graph*: calls 2 internal fn (merge_connectors, plugin_connector_to_app_info); 4 external calls (assert_eq!, google_calendar_accessible_connector, plugin_names, vec!).


### App discovery request handling
This request processor serves `apps/list` by orchestrating cached and refreshed connector catalog data and streaming updates back to clients.

### `app-server/src/request_processors/apps_processor.rs`

`orchestration` · `request handling`

This file is the app-listing desk for the server. When a client asks, “What apps can I use?”, it does not simply read one list. It first checks the current configuration, the user’s sign-in state, the workspace setting, and sometimes the settings of a specific running thread. If apps are disabled anywhere important, it returns an empty list instead of doing extra work.

When apps are allowed, the processor starts a background task. That matters because loading apps can involve slower work, such as asking MCP tools. MCP here means “Model Context Protocol,” a way for external tools to tell the system what they can provide. The code also uses cached data first when it can, so the client may quickly receive an “app list updated” notification before the final response is ready. Think of it like a restaurant host first showing the menu they already have, then updating it after checking with the kitchen.

The main loading path combines two views: all known apps and the subset the user can actually access. It merges them, marks enabled or disabled state from configuration, sends notifications when useful, and finally slices the list according to cursor and limit values. It also protects the system with a timeout and a shutdown token, so long-running app loading does not keep going after the server is stopping.

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

**Purpose**: Creates an app request processor with all the shared services it needs. It also attaches a shutdown guard so background app-list work can be cancelled when this processor is dropped or shut down.

**Data flow**: It receives shared references to authentication, thread, outgoing-message, configuration, workspace-settings, and shutdown services. It stores those references inside a new processor and creates a drop guard from the shutdown token. The result is a ready-to-use AppsRequestProcessor.

**Call relations**: This is called during higher-level server setup when the request processors are built. Later, the processor’s other methods use the stored services to answer app-list requests and to stop background work cleanly.

*Call graph*: called by 1 (new); 1 external calls (clone).


##### `AppsRequestProcessor::apps_list`  (lines 34–42)

```
async fn apps_list(
        &self,
        request_id: &ConnectionRequestId,
        params: AppsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: This is the public request-facing method for listing apps. It wraps the internal app-list response into the broader client response type used by the server.

**Data flow**: It receives a request id and app-list parameters from a client request. It passes them to the internal app-list method, waits for the result, and converts any immediate response into the generic client payload shape. It returns either an immediate response, no immediate response because work continues in the background, or an error.

**Call relations**: The initialized client request handler calls this when a client asks for apps. It delegates the real decision-making to AppsRequestProcessor::apps_list_inner, then hands the result back in the format the request-handling layer expects.

*Call graph*: calls 1 internal fn (apps_list_inner); called by 1 (handle_initialized_client_request).


##### `AppsRequestProcessor::apps_list_inner`  (lines 44–109)

```
async fn apps_list_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: AppsListParams,
    ) -> Result<Option<AppsListResponse>, JSONRPCErrorError>
```

**Purpose**: Decides whether an app-list request should return immediately, return an empty list, or start background loading. This is where feature flags, thread context, authentication, and workspace policy are checked before doing expensive work.

**Data flow**: It receives the client request id and list parameters. If the request names a thread, it loads that thread and uses its working directory and feature settings as context. It reloads the latest config, checks whether apps and workspace Codex plugins are allowed, and may return an empty app list. If loading should continue, it starts a background task and returns no immediate response.

**Call relations**: AppsRequestProcessor::apps_list calls this for every app-list request. It calls AppsRequestProcessor::load_thread when thread-specific context is needed, AppsRequestProcessor::load_latest_config to get current settings, and AppsRequestProcessor::workspace_codex_plugins_enabled to respect workspace policy. When everything is allowed, it launches AppsRequestProcessor::apps_list_task so the client can be notified asynchronously.

*Call graph*: calls 3 internal fn (load_latest_config, load_thread, workspace_codex_plugins_enabled); called by 1 (apps_list); 6 external calls (clone, child_token, new, clone, select!, spawn).


##### `AppsRequestProcessor::shutdown`  (lines 111–113)

```
fn shutdown(&self)
```

**Purpose**: Stops any app-list background work tied to this processor. It is used when the server is clearing runtime state and should not keep old tasks alive.

**Data flow**: It reads the processor’s shutdown token and cancels it. Any background task that is watching a child token can notice the cancellation and stop instead of continuing to load app data.

**Call relations**: The runtime cleanup path calls this through clear_runtime_references. The background task started by AppsRequestProcessor::apps_list_inner listens to this cancellation signal while running AppsRequestProcessor::apps_list_task.

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

**Purpose**: Runs the app-list loading job in the background and sends the final result back to the client. It can also trigger a one-time refresh if the first result says Codex apps were not fully ready yet.

**Data flow**: It receives the outgoing message sender, request id, app-list parameters, configuration, and managers needed to load app data. It asks AppsRequestProcessor::apps_list_response to build the response, sends that response or error to the waiting client, then checks whether a forced refresh should be attempted. If the retry fails, it only logs a warning because the client has already received the main result.

**Call relations**: AppsRequestProcessor::apps_list_inner starts this as a spawned asynchronous task. Its main helper is AppsRequestProcessor::apps_list_response, which does the real loading and merging. After it gets a result, it uses the outgoing sender to answer the original request.

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

**Purpose**: Builds the actual list of apps by combining cached data, live accessible-app checks, and the full app directory. It sends interim app-list update notifications when useful and returns the final paginated list.

**Data flow**: It receives app-list parameters, current config, and managers for environments, MCP tools, and plugins. It parses the cursor into a starting index, gets plugin-provided app definitions, reads cached app lists if available, and starts two parallel live loads: one for accessible apps and one for all apps. As each load finishes, it merges the best available data, marks app enabled state from config, may notify the client, and once both loads finish, returns the requested page plus a flag saying whether Codex apps were ready.

**Call relations**: AppsRequestProcessor::apps_list_task calls this to do the main work, and may call it again with force_refetch enabled for a refresh. This function relies on merge_loaded_apps to combine lists, should_send_app_list_updated_notification to avoid noisy updates, send_app_list_updated_notification to push progress to the client, and paginate_apps to produce the final response page.

*Call graph*: calls 7 internal fn (merge_loaded_apps, paginate_apps, send_app_list_updated_notification, should_send_app_list_updated_notification, list_all_connectors_with_options, list_accessible_connectors_from_mcp_tools_with_mcp_manager, with_app_enabled_state); 11 external calls (clone, clone, plugins_config_input, Accessible, Directory, format!, join!, spawn, unbounded_channel, now (+1 more)).


##### `AppsRequestProcessor::load_thread`  (lines 311–325)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Turns a thread id string from a request into the actual running thread object. It also converts bad ids or missing threads into clear request errors.

**Data flow**: It receives a thread id as text. It parses that text into the internal ThreadId type, asks the thread manager for the matching thread, and returns both the parsed id and the thread object. If parsing fails or no thread exists, it returns an invalid-request error.

**Call relations**: AppsRequestProcessor::apps_list_inner calls this when the app-list request is tied to a specific thread. The thread is then used to pick a fallback working directory and to apply that thread’s app feature setting to the loaded config.

*Call graph*: calls 1 internal fn (from_string); called by 1 (apps_list_inner).


##### `AppsRequestProcessor::load_latest_config`  (lines 327–335)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Loads the newest configuration for app listing, optionally using a thread’s working directory as context. It hides configuration-loading failures behind the server’s standard JSON-RPC error shape.

**Data flow**: It receives an optional fallback current working directory. It asks the configuration manager to reload the latest config using that context. It returns the config on success, or an internal error message if config loading fails.

**Call relations**: AppsRequestProcessor::apps_list_inner calls this before checking whether apps are enabled or starting background loading. The resulting config is passed through to AppsRequestProcessor::apps_list_task and eventually AppsRequestProcessor::apps_list_response.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (apps_list_inner).


##### `AppsRequestProcessor::workspace_codex_plugins_enabled`  (lines 337–357)

```
async fn workspace_codex_plugins_enabled(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> bool
```

**Purpose**: Checks whether this workspace allows Codex plugins for the current configuration and signed-in user. If the setting cannot be fetched, it chooses to allow plugins and logs a warning instead of blocking app listing.

**Data flow**: It receives the current config and optional authentication information. It asks the workspace settings system, using the workspace settings cache, whether Codex plugins are enabled. It returns that setting when available; if lookup fails, it logs the problem and returns true.

**Call relations**: AppsRequestProcessor::apps_list_inner calls this after checking the broader app feature flag. Its answer decides whether the request continues to background app loading or immediately returns an empty app list.

*Call graph*: calls 1 internal fn (codex_plugins_enabled_for_workspace); called by 1 (apps_list_inner); 1 external calls (warn!).


##### `merge_loaded_apps`  (lines 367–375)

```
fn merge_loaded_apps(
    all_connectors: Option<&[AppInfo]>,
    accessible_connectors: Option<&[AppInfo]>,
) -> Vec<AppInfo>
```

**Purpose**: Combines the full app list and the accessible app list into one user-facing list. It preserves the difference between “we loaded the full list and it is empty” and “we do not have the full list yet.”

**Data flow**: It receives optional slices of all known apps and accessible apps. Missing lists are treated as not-yet-loaded, while present lists are copied into owned vectors. It passes those vectors and a loaded/not-loaded flag to the connector merge function, returning one merged list.

**Call relations**: AppsRequestProcessor::apps_list_response calls this whenever cached or live app data changes. The merged result is then given enabled-state information, possibly sent as a notification, and eventually paginated for the final response.

*Call graph*: calls 1 internal fn (merge_connectors_with_accessible); called by 1 (apps_list_response).


##### `should_send_app_list_updated_notification`  (lines 377–383)

```
fn should_send_app_list_updated_notification(
    connectors: &[AppInfo],
    accessible_loaded: bool,
    all_loaded: bool,
) -> bool
```

**Purpose**: Decides whether an interim app-list update is useful enough to send to the client. It sends early updates when there is at least one accessible app, or a final update once both loading paths have finished.

**Data flow**: It receives the current merged app list and two booleans saying whether accessible apps and all apps have finished loading. It scans the list for any app marked accessible. It returns true if the client should be notified, otherwise false.

**Call relations**: AppsRequestProcessor::apps_list_response calls this before sending update notifications. This keeps the server from sending empty or premature updates unless loading is complete.

*Call graph*: called by 1 (apps_list_response); 1 external calls (iter).


##### `paginate_apps`  (lines 385–407)

```
fn paginate_apps(
    connectors: &[AppInfo],
    start: usize,
    limit: Option<u32>,
) -> Result<AppsListResponse, JSONRPCErrorError>
```

**Purpose**: Turns a full merged app list into one page of results for the client. It supports cursor-based paging, where the cursor is simply the next starting index written as text.

**Data flow**: It receives the full list, a starting index, and an optional limit. It checks that the starting index is not past the end, chooses at least one item as the page size, copies the requested slice, and creates a next cursor if more apps remain. It returns an AppsListResponse or an invalid-request error for an impossible cursor.

**Call relations**: AppsRequestProcessor::apps_list_response calls this only after both the accessible-app and all-app loading paths have completed. Its response becomes the final data sent back by AppsRequestProcessor::apps_list_task.

*Call graph*: called by 1 (apps_list_response); 2 external calls (len, format!).


##### `send_app_list_updated_notification`  (lines 409–418)

```
async fn send_app_list_updated_notification(
    outgoing: &Arc<OutgoingMessageSender>,
    data: Vec<AppInfo>,
)
```

**Purpose**: Sends an app-list update notification to the client before or during the final response flow. This lets the user interface refresh as better app data becomes available.

**Data flow**: It receives the outgoing message sender and a list of app information. It wraps that list in an AppListUpdated notification and sends it through the server’s outgoing message channel. It does not return app data; its effect is the message sent to the client.

**Call relations**: AppsRequestProcessor::apps_list_response calls this after deciding an update is worth sending. The notification travels through OutgoingMessageSender to the connected client, while the loading loop continues toward the final paginated response.

*Call graph*: called by 1 (apps_list_response); 1 external calls (AppListUpdated).


### Interactive file search
This adapter exposes one-shot and session-based fuzzy file search, managing result translation, limits, cancellation, and stale-update suppression.

### `app-server/src/fuzzy_file_search.rs`

`domain_logic` · `request handling`

This file is the bridge between the app server protocol and the lower-level file search engine. Its job is to take a user’s search text and a list of root folders, run a fuzzy search inside those folders, and return results in the shape the app-server client understands. “Fuzzy” means the text does not need to match exactly; for example, typing “usrctrl” might still find “user_controller.rs”.

There are two modes. `run_fuzzy_file_search` is a one-time search: it runs the potentially slow disk and path scanning work on a blocking worker thread so it does not clog the async server. It limits results to 50, uses a safe number of CPU threads, supports cancellation, converts raw search matches into protocol results, and sorts them by best score first.

The second mode is a live session created by `start_fuzzy_file_search_session`. A session keeps the search machinery alive while the user keeps typing. `FuzzyFileSearchSession::update_query` sends each new query into that machinery. A small reporter object listens for search snapshots and completion events, then sends server notifications back to the client. It also guards against stale updates: if an old search result arrives after the user has already typed a newer query, it is ignored. Dropping the session flips a shared cancellation flag, like putting up a “closed” sign so background work stops sending messages.

#### Function details

##### `run_fuzzy_file_search`  (lines 21–91)

```
async fn run_fuzzy_file_search(
    query: String,
    roots: Vec<String>,
    cancellation_flag: Arc<AtomicBool>,
) -> Vec<FuzzyFileSearchResult>
```

**Purpose**: Runs a single fuzzy file search and returns the best matching files or folders. It is used when the server needs search results once, rather than keeping an interactive search session open.

**Data flow**: It receives a search query, a list of root folder paths, and a shared cancellation flag. If there are no roots, it immediately returns an empty list. Otherwise it chooses a result limit and thread count, converts the root strings into paths, and asks the file search library to do the heavy work on a blocking worker thread. Successful matches are converted into app-server result objects, including their path, file name, score, match type, and highlighted character indices. If the search fails or the worker task fails, it logs a warning and returns an empty list. Finally it sorts the results by best score first, using path as a tie-breaker.

**Call relations**: This function is called by the higher-level `fuzzy_file_search` request path when a client asks for a one-shot search. It hands the expensive searching to `codex_file_search`, then translates the library’s answer into protocol objects that can be sent back to the client.

*Call graph*: called by 1 (fuzzy_file_search); 5 external calls (new, new, available_parallelism, spawn_blocking, warn!).


##### `FuzzyFileSearchSession::update_query`  (lines 99–109)

```
fn update_query(&self, query: String)
```

**Purpose**: Changes the current query for a live fuzzy file search session. This is what lets the server react as the user types more characters or deletes them.

**Data flow**: It receives the new query text. First it checks whether the session has already been canceled; if so, it does nothing. If the session is still active, it stores the new query as the latest known query in shared state, then passes the query to the underlying file search session so it can start producing updated matches.

**Call relations**: This method is used after `start_fuzzy_file_search_session` has created a session. It feeds new user input into the lower-level search session. Later, when the search engine reports updates, `SessionReporterImpl::send_snapshot` compares those snapshots against this stored latest query to avoid sending old results.

*Call graph*: calls 1 internal fn (update_query).


##### `FuzzyFileSearchSession::drop`  (lines 113–115)

```
fn drop(&mut self)
```

**Purpose**: Marks a live fuzzy search session as canceled when the session object is destroyed. This prevents background search work from continuing to send updates for a session the server no longer wants.

**Data flow**: It takes the session being dropped and changes the shared cancellation flag from false to true. It does not return a value, but it changes shared state that other parts of the search session check before doing work or sending messages.

**Call relations**: Rust calls this automatically when a `FuzzyFileSearchSession` goes out of scope or is removed. The cancellation flag is read by `FuzzyFileSearchSession::update_query`, `SessionReporterImpl::send_snapshot`, `SessionReporterImpl::send_complete`, and the underlying search library, so dropping the session shuts down the flow of further updates.


##### `start_fuzzy_file_search_session`  (lines 118–158)

```
fn start_fuzzy_file_search_session(
    session_id: String,
    roots: Vec<String>,
    outgoing: Arc<OutgoingMessageSender>,
) -> anyhow::Result<FuzzyFileSearchSession>
```

**Purpose**: Starts a live fuzzy file search session that can send result updates to the client over time. This is used for interactive searching, such as a file picker that updates while the user types.

**Data flow**: It receives a session id, root folders to search, and an outgoing message sender. It chooses a result limit and a sensible number of worker threads, converts the root folder strings into paths, creates a shared state bundle containing the session id, latest query, outgoing sender, async runtime handle, and cancellation flag, then creates a reporter that can send updates back to the client. It asks the file search library to create the actual search session. On success, it returns a `FuzzyFileSearchSession` that holds both the lower-level session and the shared state; on failure, it returns an error.

**Call relations**: This function is called by `fuzzy_file_search_session_start_response` when the client wants an interactive search session. It wires together the search engine, the app-server notification sender, and the cancellation state. After this, `FuzzyFileSearchSession::update_query` drives new searches, and `SessionReporterImpl` sends updates and completion notifications.

*Call graph*: called by 1 (fuzzy_file_search_session_start_response); 9 external calls (new, new, default, new, new, new, create_session, available_parallelism, current).


##### `SessionReporterImpl::send_snapshot`  (lines 173–203)

```
fn send_snapshot(&self, snapshot: &file_search::FileSearchSnapshot)
```

**Purpose**: Sends the client a fresh set of search results for the current query. It also filters out canceled sessions and stale results from older queries.

**Data flow**: It receives a search snapshot from the lower-level search library. First it checks the cancellation flag; if the session is canceled, it stops. Then it reads the latest query stored by `FuzzyFileSearchSession::update_query`. If the snapshot was made for a different query, it stops so the client does not see outdated results. If the query is empty, it sends an empty result list; otherwise it converts the snapshot matches with `collect_files`. It wraps the results in a server notification and spawns an async task to send that notification through the outgoing message sender.

**Call relations**: This is called by `SessionReporterImpl::on_update`, which is the callback the file search library uses when new partial results are ready. It calls `collect_files` to translate raw search matches into protocol results, then hands the notification to the app server’s outgoing message path.

*Call graph*: calls 1 internal fn (collect_files); called by 1 (on_update); 2 external calls (FuzzyFileSearchSessionUpdated, new).


##### `SessionReporterImpl::send_complete`  (lines 205–217)

```
fn send_complete(&self)
```

**Purpose**: Tells the client that a live fuzzy search session has finished. This lets the client know no more updates are expected for that session unless the query changes or another session starts.

**Data flow**: It checks whether the session has been canceled. If not, it copies the session id and outgoing sender, creates a completion notification, and spawns an async task that sends the notification to the client. It does not return data to the caller; its effect is the outgoing notification.

**Call relations**: This is called by `SessionReporterImpl::on_complete`, which is triggered by the underlying search library. It is the final notification counterpart to the update notifications sent by `SessionReporterImpl::send_snapshot`.

*Call graph*: called by 1 (on_complete); 1 external calls (FuzzyFileSearchSessionCompleted).


##### `SessionReporterImpl::on_update`  (lines 221–223)

```
fn on_update(&self, snapshot: &file_search::FileSearchSnapshot)
```

**Purpose**: Receives an update callback from the file search library and forwards it into the app server notification flow.

**Data flow**: It receives a search snapshot. It passes that snapshot to `SessionReporterImpl::send_snapshot`, which checks whether it is still relevant, converts results if needed, and sends the update notification.

**Call relations**: This method is part of the `file_search::SessionReporter` interface, meaning the lower-level search library calls it when it has new results. Its only job is to route that event to `send_snapshot`, where the app-server-specific behavior lives.

*Call graph*: calls 1 internal fn (send_snapshot).


##### `SessionReporterImpl::on_complete`  (lines 225–227)

```
fn on_complete(&self)
```

**Purpose**: Receives a completion callback from the file search library and forwards it into the app server notification flow.

**Data flow**: It receives no search data, only the fact that the session has completed. It calls `SessionReporterImpl::send_complete`, which checks cancellation and sends a completion notification to the client.

**Call relations**: This method is part of the `file_search::SessionReporter` interface. The search library calls it when session work is complete, and it delegates to `send_complete` to produce the app-server protocol notification.

*Call graph*: calls 1 internal fn (send_complete).


##### `collect_files`  (lines 230–256)

```
fn collect_files(snapshot: &file_search::FileSearchSnapshot) -> Vec<FuzzyFileSearchResult>
```

**Purpose**: Converts raw file search matches into the result format used by the app-server protocol. It also sorts them so the best matches appear first.

**Data flow**: It receives a search snapshot containing raw matches from the file search library. For each match, it extracts the root path, full path, file name, whether the match is a file or directory, the score, and the character indices that matched the query. It builds a list of `FuzzyFileSearchResult` values, then sorts that list by descending score and ascending path. The sorted list is returned to the caller.

**Call relations**: This helper is called by `SessionReporterImpl::send_snapshot` when a live search update needs to be sent to the client. It performs the same kind of translation used by the one-shot search path, but for session snapshots.

*Call graph*: called by 1 (send_snapshot).
