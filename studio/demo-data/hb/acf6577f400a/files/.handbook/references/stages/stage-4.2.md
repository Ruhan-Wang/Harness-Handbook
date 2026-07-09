# Feature flags, provider catalogs, and built-in asset installation  `stage-4.2`

This stage is startup preparation. Before Codex opens a session or draws major UI screens, it builds the “menu of available things”: enabled features, known models, skills, plugins, tools, presets, and bundled assets.

The feature files define all feature flags, read them from TOML config, keep old flag names working, and enforce any flags that must stay on or off. The terminal experimental-features view lets users change some of those choices safely.

The skills files configure skills, install built-in system skills into CODEX_HOME, create default memory-extension instructions, then find, read, filter, and cache usable skill files from user, project, system, admin, plugin, and extra folders.

The plugin and marketplace files locate installed marketplaces, manage them from the command line, recognize plugins, and turn loaded plugin features into usable lists. MCP files then combine plugin, user, built-in, extension, and login-controlled tool servers into one catalog.

The model files define provider and model catalogs, apply local limits and defaults, and keep old preset keys working. Collaboration and approval preset files provide built-in working modes and permission levels. Finally, TUI files prepare model choices, update commands, and terminal pet images before the interface needs them.

## Files in this stage

### Feature flag resolution
These files define feature schemas, legacy mappings, canonical resolution, managed enforcement, and the UI used to inspect and persist experimental toggles.

### `features/src/feature_configs.rs`

`config` · `config load`

This file is like a set of labeled forms for feature settings. Each struct describes what options are allowed for one feature, and each field is optional so a config file can mention only the settings it wants to override. The code uses serde, a Rust library for turning data into and out of file formats, so these settings can be loaded from or saved to TOML. It also uses JSON Schema generation, which lets tools describe or validate the allowed configuration shape.

The file covers three main public feature configs. CodeModeConfigToml can turn code mode on or off and hide selected tool namespaces from code mode. MultiAgentV2ConfigToml controls multi-agent behavior, including whether it is enabled, timeout limits, usage hint text, and the tool namespace used for agent tools. NetworkProxyConfigToml controls network proxy behavior, including proxy URLs, SOCKS5 options, domain and Unix socket allow/deny rules, and safety-related escape hatches whose names make their risk explicit.

A shared FeatureConfig trait is implemented for the main feature structs. That gives higher-level code one simple way to ask, “Is this feature explicitly enabled?” or to set that enabled flag, without caring which feature it is working with. The deny_unknown_fields setting is important: if someone misspells a config key, the loader rejects it instead of silently ignoring it.

#### Function details

##### `CodeModeConfigToml::enabled`  (lines 18–20)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: This returns the optional on/off setting for code mode. It is used when code wants to know whether the user or configuration explicitly enabled or disabled this feature.

**Data flow**: It reads the CodeModeConfigToml value it is called on, looks at its enabled field, and returns that optional boolean. If the field was not set in the config, the result is empty rather than true or false.

**Call relations**: This is the CodeModeConfigToml version of the shared FeatureConfig interface. Higher-level feature-loading code can call enabled through that interface when it is deciding whether code mode should be active, without needing special code for this particular config type.


##### `CodeModeConfigToml::set_enabled`  (lines 22–24)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: This records an explicit on/off choice for code mode. It is useful when code needs to programmatically turn the feature setting into a definite value.

**Data flow**: It receives a boolean such as true or false, then stores it inside the config's enabled field as a present value. Before the call, the field may have been missing; after the call, it is definitely set.

**Call relations**: This is called through the shared FeatureConfig interface when generic feature code needs to update a feature's enabled flag. It does not call out to other helpers; it simply updates the CodeModeConfigToml data.


##### `MultiAgentV2ConfigToml::enabled`  (lines 62–64)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: This returns the optional on/off setting for the multi-agent v2 feature. It lets generic feature code check whether the config explicitly says to enable or disable multi-agent behavior.

**Data flow**: It reads the MultiAgentV2ConfigToml value, takes the enabled field, and returns it. A missing field stays missing, which allows defaults from elsewhere to still apply.

**Call relations**: This function fulfills the FeatureConfig contract for MultiAgentV2ConfigToml. The broader configuration system can ask for the enabled state in the same way it does for other features, while the rest of the multi-agent settings remain specific to this struct.


##### `MultiAgentV2ConfigToml::set_enabled`  (lines 66–68)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: This sets the multi-agent v2 feature to explicitly enabled or disabled. It gives shared feature code a standard way to write that decision into this config object.

**Data flow**: It takes a boolean input and places it into the config's enabled field as a present value. The rest of the multi-agent settings, such as timeouts and hint text, are left unchanged.

**Call relations**: This is the update side of the FeatureConfig implementation for MultiAgentV2ConfigToml. Generic code that works with many feature configs can call it without knowing about the multi-agent-specific fields.


##### `NetworkProxyConfigToml::enabled`  (lines 110–112)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: This returns the optional on/off setting for the network proxy feature. It helps the program decide whether proxy behavior has been explicitly requested or disabled in configuration.

**Data flow**: It reads the NetworkProxyConfigToml value, checks its enabled field, and returns that optional boolean. If no enabled value was supplied, it returns no value so another defaulting layer can decide.

**Call relations**: This connects NetworkProxyConfigToml to the shared FeatureConfig interface. Feature-loading code can use the same enabled check for the proxy feature that it uses for code mode and multi-agent settings.


##### `NetworkProxyConfigToml::set_enabled`  (lines 114–116)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: This writes an explicit enabled or disabled state into the network proxy config. It is used when code needs to force the proxy feature's on/off flag to a known value.

**Data flow**: It receives a boolean and stores it in the enabled field as a present setting. Other proxy details, such as URLs, permission maps, and safety flags, are not changed.

**Call relations**: This function is called through the FeatureConfig interface by generic feature code that toggles feature configs. It keeps the common enabled-setting behavior separate from the many network-proxy-specific options.


### `features/src/legacy.rs`

`config` · `config load`

Feature flags are switches that turn optional behavior on or off. Over time, some switches in this project were renamed or moved to a cleaner configuration format. This file is the compatibility bridge for those older names. Without it, a user with an older config file could silently lose a setting, or the program might not understand a feature they had already enabled.

The file contains a small table that pairs each old name, such as `web_search` or `experimental_use_unified_exec_tool`, with the current `Feature` it now means. When the program sees one of these old names, it translates it to the modern feature. It also logs a helpful message saying, in effect, “this old name still works, but please use the new one.”

There are two paths here. One path lists all known old keys so other code can recognize them. Another path takes a specific key and finds the matching modern feature. There is also a small `LegacyFeatureToggles` struct for older configuration fields that were read directly as booleans. Its `apply` method turns the matching feature on or off and records that a legacy setting was used. The overall job is like keeping forwarding addresses after people move: old mail still arrives, but everyone is encouraged to use the new address.

#### Function details

##### `legacy_feature_keys`  (lines 50–52)

```
fn legacy_feature_keys() -> impl Iterator<Item = &'static str>
```

**Purpose**: This function gives other code the list of old feature flag names that are still recognized. It is useful when the configuration system needs to know which legacy keys should be accepted instead of treated as unknown.

**Data flow**: It reads the built-in alias table in this file. It takes each alias entry, extracts only the old key string, and returns an iterator that produces those strings one by one. It does not change any settings.

**Call relations**: During feature configuration, `materialize_resolved_enabled` calls this to learn which old names exist. That caller can then include those names when turning raw configuration into the final set of enabled features.

*Call graph*: called by 1 (materialize_resolved_enabled).


##### `feature_for_key`  (lines 54–62)

```
fn feature_for_key(key: &str) -> Option<Feature>
```

**Purpose**: This function translates one old feature flag name into the current `Feature` value. If the key is not a known legacy name, it returns nothing.

**Data flow**: It receives a text key from configuration. It searches the alias table for a matching old key. If it finds one, it logs a warning-style informational message about the newer preferred name and returns the matching feature; if not, it returns `None`.

**Call relations**: This is used when configuration code needs to resolve a name into a real feature. The call graph records it as being called from feature-key resolution code; in that moment, it acts as the legacy lookup step before the rest of the system works with the normal `Feature` value.

*Call graph*: called by 1 (feature_for_key).


##### `LegacyFeatureToggles::apply`  (lines 70–77)

```
fn apply(self, features: &mut Features)
```

**Purpose**: This method applies legacy boolean settings that were read into `LegacyFeatureToggles` to the main `Features` collection. In plain terms, it takes an old-style on/off setting and makes the modern feature list match it.

**Data flow**: It consumes the `LegacyFeatureToggles` value and receives a mutable `Features` object, meaning it is allowed to change the feature set. For each supported old field, it passes the possible boolean value, the modern feature, and the old key name to `set_if_some`. The output is the same `Features` object, but possibly with a feature enabled or disabled.

**Call relations**: After older configuration fields have been parsed, this method is the bridge into the main feature system. It hands the actual decision to `set_if_some`, which only changes the feature set when the old field was present.

*Call graph*: calls 1 internal fn (set_if_some).


##### `set_if_some`  (lines 80–91)

```
fn set_if_some(
    features: &mut Features,
    feature: Feature,
    maybe_value: Option<bool>,
    alias_key: &'static str,
)
```

**Purpose**: This helper changes a feature only when an old configuration value was actually provided. That matters because an absent legacy field should not accidentally override newer settings.

**Data flow**: It receives the feature collection to change, the specific feature, an optional boolean value, and the old key name. If the value is present, it turns the feature on or off, logs that the old name was used, and records that legacy usage in the feature collection. If the value is missing, it leaves everything alone.

**Call relations**: `LegacyFeatureToggles::apply` calls this for each old-style field it knows about. When there is work to do, it calls `set_feature` to make the actual on/off change, calls `log_alias` to tell the user about the modern name, and calls `record_legacy_usage` so the system remembers that compatibility behavior was needed.

*Call graph*: calls 3 internal fn (record_legacy_usage, log_alias, set_feature); called by 1 (apply).


##### `set_feature`  (lines 93–99)

```
fn set_feature(features: &mut Features, feature: Feature, enabled: bool)
```

**Purpose**: This helper performs the simple on/off action for one feature. It hides the small branch between enabling and disabling so the legacy code above stays easy to read.

**Data flow**: It receives the mutable feature collection, a feature, and a boolean. If the boolean is true, it calls `enable` on the feature collection. If the boolean is false, it calls `disable`. It returns no separate value; the change is made directly to the provided `Features` object.

**Call relations**: `set_if_some` calls this after it has confirmed that a legacy setting was present. This function then delegates to the main `Features` type, which owns the real enable and disable behavior.

*Call graph*: calls 2 internal fn (disable, enable); called by 1 (set_if_some).


##### `log_alias`  (lines 101–111)

```
fn log_alias(alias: &str, feature: Feature)
```

**Purpose**: This function writes an informational log message when someone uses an old feature name instead of the current one. It helps users and maintainers notice outdated configuration without breaking it immediately.

**Data flow**: It receives the old alias text and the modern feature. It asks the feature for its official key. If the old name and official name are the same, it does nothing. Otherwise, it emits a log message that includes both names and recommends the modern `[features]` setting.

**Call relations**: `set_if_some` calls this after applying a legacy field, and key lookup also uses it when an old key is translated. It relies on the feature’s `key` method to find the canonical name, then sends the message through the tracing `info!` logging system.

*Call graph*: calls 1 internal fn (key); called by 1 (set_if_some); 1 external calls (info!).


### `features/src/lib.rs`

`config` · `config load and startup, with runtime checks`

Feature flags are switches that let Codex turn parts of the product on or off without deleting code. This file is the switchboard. It lists every known feature in one registry, gives each one a config key, and records its lifecycle stage, such as stable, experimental, under development, deprecated, or removed.

At startup or config loading time, Codex builds a `Features` value. It starts from built-in defaults, then applies settings from a base config, profile config, old legacy names, and direct overrides. It also records when someone used an old name so the user can be warned with a helpful replacement. Some old flags are accepted but ignored, so older config files do not break.

The file also supports richer TOML feature entries. Most flags are simple true-or-false values, but some features can have extra settings under their own config block. Think of this as a light switch where a few rooms also have a dimmer knob.

Finally, it emits telemetry when feature states differ from defaults and can create a warning event if a user enabled under-development features. Without this file, the project would have scattered, inconsistent feature names and no single trusted way to decide what behavior should be active.

#### Function details

##### `Stage::experimental_menu_name`  (lines 49–54)

```
fn experimental_menu_name(self) -> Option<&'static str>
```

**Purpose**: Returns the user-facing name for a feature when that feature is shown in the experimental features menu. If the feature is not experimental, it returns nothing.

**Data flow**: It receives a `Stage` value. If that value is the experimental kind, it picks out the stored menu name; otherwise it produces no value.

**Call relations**: Other parts of the user interface can call this when building an experimental-feature menu. This function only reads the stage label and does not change anything.


##### `Stage::experimental_menu_description`  (lines 56–63)

```
fn experimental_menu_description(self) -> Option<&'static str>
```

**Purpose**: Returns the short description shown beside an experimental feature in the menu. Non-experimental stages have no such description.

**Data flow**: It receives a `Stage`. For an experimental stage, it extracts the stored menu description; for stable, deprecated, removed, or under-development stages, it returns nothing.

**Call relations**: It is a small helper for presentation code. It lets callers ask the stage itself whether it has menu text instead of duplicating that matching logic elsewhere.


##### `Stage::experimental_announcement`  (lines 65–73)

```
fn experimental_announcement(self) -> Option<&'static str>
```

**Purpose**: Returns an announcement message for an experimental feature, if one exists. Empty announcement text is treated as no announcement.

**Data flow**: It receives a `Stage`. If it is experimental and has non-empty announcement text, that text comes out; otherwise the result is empty.

**Call relations**: This supports places that announce newly available experimental features. It keeps the rule about empty announcements close to the stage data.


##### `Feature::key`  (lines 277–279)

```
fn key(self) -> &'static str
```

**Purpose**: Returns the config-file name for a feature, such as the string users put under `[features]`. This gives the rest of the program one canonical spelling for each feature.

**Data flow**: It receives a `Feature`, looks up that feature’s registry entry through `Feature::info`, and returns the entry’s key string.

**Call relations**: Legacy-warning code and other callers use this when they need the official feature name. It relies on `Feature::info` to find the matching registry record.

*Call graph*: calls 1 internal fn (info); called by 3 (record_legacy_usage, log_alias, legacy_usage_notice).


##### `Feature::stage`  (lines 281–283)

```
fn stage(self) -> Stage
```

**Purpose**: Returns where a feature is in its lifecycle: stable, experimental, under development, deprecated, or removed.

**Data flow**: It receives a `Feature`, finds its registry entry through `Feature::info`, and returns the stored stage.

**Call relations**: Code that needs to display or reason about feature maturity can call this. The actual source of truth remains the central `FEATURES` list.

*Call graph*: calls 1 internal fn (info).


##### `Feature::default_enabled`  (lines 285–287)

```
fn default_enabled(self) -> bool
```

**Purpose**: Tells whether a feature is normally on before any user config changes it.

**Data flow**: It receives a `Feature`, uses `Feature::info` to find the registry record, and returns the record’s default true-or-false value.

**Call relations**: This is the public shortcut for reading defaults from the registry. It keeps callers from searching the registry themselves.

*Call graph*: calls 1 internal fn (info).


##### `Feature::info`  (lines 289–294)

```
fn info(self) -> &'static FeatureSpec
```

**Purpose**: Finds the full registry record for a feature. This is the private lookup used by the feature convenience methods.

**Data flow**: It receives a `Feature`, scans the `FEATURES` list until it finds the matching `FeatureSpec`, and returns that record. If the registry is missing an entry, the code treats that as an impossible programmer error.

**Call relations**: `Feature::key`, `Feature::stage`, and `Feature::default_enabled` all call this. It is the link between the enum value and the metadata table.

*Call graph*: called by 3 (default_enabled, key, stage).


##### `FeatureOverrides::apply`  (lines 324–333)

```
fn apply(self, features: &mut Features)
```

**Purpose**: Applies direct override settings on top of the normal feature config. In this file, it specifically handles the legacy-style override for web search requests.

**Data flow**: It receives override values and a mutable `Features` set. If a web-search override is present, it enables or disables `WebSearchRequest` and records that a legacy setting was used.

**Call relations**: `Features::from_sources` calls this after base and profile config have been applied, so explicit overrides win. It uses `Features::enable`, `Features::disable`, and `Features::record_legacy_usage` to make the change and remember the warning.

*Call graph*: calls 3 internal fn (disable, enable, record_legacy_usage); called by 1 (from_sources).


##### `Features::with_defaults`  (lines 338–349)

```
fn with_defaults() -> Self
```

**Purpose**: Creates a fresh feature set using only the built-in defaults from the registry.

**Data flow**: It starts with an empty sorted set, walks through every `FeatureSpec`, inserts each feature whose default is enabled, and returns a `Features` value with no legacy usage records yet.

**Call relations**: This is the starting point for `Features::from_sources` and many tests. Later config layers edit the set it creates.

*Call graph*: called by 60 (web_search_mode_defaults_to_none_if_unset, web_search_mode_disabled_overrides_legacy_request, web_search_mode_prefers_config_over_legacy_flags, codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result, default_available_modes, default_mode_enabled_available_modes, elevated_flag_works_by_itself (+15 more)); 1 external calls (new).


##### `Features::enabled`  (lines 351–353)

```
fn enabled(&self, f: Feature) -> bool
```

**Purpose**: Answers the basic question: is this feature currently on?

**Data flow**: It receives a `Feature` and checks whether that feature is present in the enabled set. It returns true or false and changes nothing.

**Call relations**: Many parts of the system call this before using optional behavior. Within this file, it is also used by dependency cleanup, metrics, auth-specific app checks, and config materialization.

*Call graph*: called by 12 (validate_pinned_features_constraint, resolve_web_search_mode, from_features, apps_enabled_for_auth, emit_metrics, normalize_dependencies, use_legacy_landlock, materialize_resolved_enabled, unstable_features_warning_event, shell_command_backend_for_features (+2 more)); 1 external calls (contains).


##### `Features::apps_enabled_for_auth`  (lines 355–357)

```
fn apps_enabled_for_auth(&self, has_chatgpt_auth: bool) -> bool
```

**Purpose**: Checks whether apps should be treated as available for the current authentication state. Apps must be enabled, and the user must have ChatGPT authentication.

**Data flow**: It receives a boolean saying whether ChatGPT auth exists. It checks the `Apps` feature and combines both conditions into one true-or-false answer.

**Call relations**: This gives callers a single safe check instead of making them remember both requirements. It delegates the feature part to `Features::enabled`.

*Call graph*: calls 1 internal fn (enabled).


##### `Features::use_legacy_landlock`  (lines 359–361)

```
fn use_legacy_landlock(&self) -> bool
```

**Purpose**: Reports whether Codex should use the older Landlock Linux sandbox behavior. Landlock is a Linux security mechanism for restricting what a process can access.

**Data flow**: It reads the current enabled set and returns whether `UseLegacyLandlock` is present.

**Call relations**: Sandbox setup code can call this instead of knowing the exact feature enum. Internally it is just a named wrapper around `Features::enabled`.

*Call graph*: calls 1 internal fn (enabled).


##### `Features::enable`  (lines 363–366)

```
fn enable(&mut self, f: Feature) -> &mut Self
```

**Purpose**: Turns a feature on in the current feature set.

**Data flow**: It receives a mutable `Features` value and a `Feature`. It inserts that feature into the enabled set and returns the same `Features` value so callers can chain more edits.

**Call relations**: Config application, override application, dependency normalization, and other setters call this whenever a flag resolves to true.

*Call graph*: called by 5 (apply, apply_map, normalize_dependencies, set_enabled, set_feature); 1 external calls (insert).


##### `Features::disable`  (lines 368–371)

```
fn disable(&mut self, f: Feature) -> &mut Self
```

**Purpose**: Turns a feature off in the current feature set.

**Data flow**: It receives a mutable `Features` value and a `Feature`. It removes that feature from the enabled set and returns the same `Features` value for chaining.

**Call relations**: Config application, override application, and generic setters call this whenever a flag resolves to false.

*Call graph*: called by 4 (apply, apply_map, set_enabled, set_feature); 1 external calls (remove).


##### `Features::set_enabled`  (lines 373–379)

```
fn set_enabled(&mut self, f: Feature, enabled: bool) -> &mut Self
```

**Purpose**: Sets a feature to a requested true-or-false state without the caller needing to choose `enable` or `disable`.

**Data flow**: It receives a feature and a boolean. If the boolean is true it enables the feature; if false it disables it, then returns the edited feature set.

**Call relations**: Higher-level normalization code calls this when it has already computed the desired state. This function funnels both paths through `Features::enable` and `Features::disable`.

*Call graph*: calls 2 internal fn (disable, enable); called by 1 (normalize_candidate).


##### `Features::record_legacy_usage_force`  (lines 381–389)

```
fn record_legacy_usage_force(&mut self, alias: &str, feature: Feature)
```

**Purpose**: Records that the user used an old or compatibility feature name and prepares a warning message for it, even if the old name matches the current key.

**Data flow**: It receives the alias string and the real `Feature`. It asks `legacy_usage_notice` for human-readable warning text, then inserts a `LegacyFeatureUsage` record into the set of notices.

**Call relations**: `Features::apply_map` calls this for known deprecated config forms, and `Features::record_legacy_usage` calls it after deciding a warning is needed. The stored notices can later be shown to the user.

*Call graph*: calls 1 internal fn (legacy_usage_notice); called by 2 (apply_map, record_legacy_usage); 1 external calls (insert).


##### `Features::record_legacy_usage`  (lines 391–396)

```
fn record_legacy_usage(&mut self, alias: &str, feature: Feature)
```

**Purpose**: Records legacy feature-name usage only when the given name is not already the canonical feature key.

**Data flow**: It receives an alias and a feature. It compares the alias to `Feature::key`; if they match, it does nothing, otherwise it forwards to `Features::record_legacy_usage_force`.

**Call relations**: Override and config parsing code call this when a key may be old. It avoids noisy warnings for users who already use the right spelling.

*Call graph*: calls 2 internal fn (key, record_legacy_usage_force); called by 3 (apply, apply_map, set_if_some).


##### `Features::legacy_feature_usages`  (lines 398–400)

```
fn legacy_feature_usages(&self) -> impl Iterator<Item = &LegacyFeatureUsage> + '_
```

**Purpose**: Provides access to the collected legacy-usage notices.

**Data flow**: It reads the internal sorted set of `LegacyFeatureUsage` records and returns an iterator, which lets callers walk through the notices without taking ownership of them.

**Call relations**: Reporting or config-validation code can call this after feature resolution to show deprecation messages. This function only exposes what earlier parsing recorded.

*Call graph*: 1 external calls (iter).


##### `Features::emit_metrics`  (lines 402–418)

```
fn emit_metrics(&self, otel: &SessionTelemetry)
```

**Purpose**: Reports feature states that differ from their defaults to telemetry. Telemetry here means measurement data used to understand product behavior.

**Data flow**: It receives the final `Features` set and a telemetry session. For every non-removed feature, it compares the current state with the default; when they differ, it sends a counter with the feature name and current value.

**Call relations**: This is called after feature resolution when Codex wants observability about non-default settings. It uses `Features::enabled` to read the final state and the telemetry object to publish the count.

*Call graph*: calls 2 internal fn (enabled, counter); 1 external calls (matches!).


##### `Features::apply_map`  (lines 421–496)

```
fn apply_map(&mut self, m: &BTreeMap<String, bool>)
```

**Purpose**: Applies a plain map of feature-name strings to true-or-false values, like the contents of a `[features]` TOML table.

**Data flow**: It receives a map from strings to booleans. For each entry, it handles special deprecated or removed names, looks up the feature with `feature_for_key`, records legacy usage when needed, and then enables or disables the resolved feature. Unknown keys are logged as warnings.

**Call relations**: `Features::apply_toml` uses this after converting structured TOML into a flat map. This is the main place where user-written feature keys become changes to the effective `Features` set.

*Call graph*: calls 5 internal fn (disable, enable, record_legacy_usage, record_legacy_usage_force, feature_for_key); called by 1 (apply_toml); 2 external calls (matches!, warn!).


##### `Features::from_sources`  (lines 498–520)

```
fn from_sources(
        base: FeatureConfigSource<'_>,
        profile: FeatureConfigSource<'_>,
        overrides: FeatureOverrides,
    ) -> Self
```

**Purpose**: Builds the final feature set from layered configuration sources and explicit overrides.

**Data flow**: It starts with `Features::with_defaults`. It then applies the base source, then the profile source, including legacy toggles and TOML feature tables. After that it applies overrides and normalizes feature dependencies before returning the finished set.

**Call relations**: Config loading and validation code call this to get the effective flags for a session. It is the main orchestration point in this file, combining defaults, config files, legacy compatibility, overrides, and dependency rules.

*Call graph*: calls 2 internal fn (apply, with_defaults); called by 12 (load_config_with_layer_stack, resolve_bootstrap_auth_keyring_backend_kind, validate_feature_requirements_in_config_toml, from_sources_applies_base_profile_and_overrides, from_sources_ignores_removed_apply_patch_freeform_feature_key, from_sources_ignores_removed_image_detail_original_feature_key, from_sources_ignores_removed_js_repl_feature_keys, from_sources_ignores_removed_plugin_hooks_feature_key, from_sources_ignores_removed_terminal_resize_reflow_feature_key, from_sources_ignores_removed_undo_feature_key (+2 more)).


##### `Features::enabled_features`  (lines 522–524)

```
fn enabled_features(&self) -> Vec<Feature>
```

**Purpose**: Returns a list of all currently enabled features.

**Data flow**: It reads the internal sorted set, copies each enabled feature into a vector, and returns that vector.

**Call relations**: Callers use this when they need a snapshot list rather than one yes-or-no check. It does not alter the feature set.

*Call graph*: 1 external calls (iter).


##### `Features::normalize_dependencies`  (lines 526–533)

```
fn normalize_dependencies(&mut self)
```

**Purpose**: Turns on required parent features when a dependent feature is enabled. This prevents impossible combinations.

**Data flow**: It reads the current enabled set. If `SpawnCsv` is on without `Collab`, it enables `Collab`; if `CodeModeOnly` is on without `CodeMode`, it enables `CodeMode`.

**Call relations**: `Features::from_sources` calls this after all config layers are applied, so dependency fixes happen once at the end. Other normalization flows can also call it when adjusting candidates.

*Call graph*: calls 2 internal fn (enable, enabled); called by 1 (normalize_candidate).


##### `legacy_usage_notice`  (lines 536–584)

```
fn legacy_usage_notice(alias: &str, feature: Feature) -> (String, Option<String>)
```

**Purpose**: Creates the warning text shown when a user relies on a legacy, deprecated, or renamed feature setting.

**Data flow**: It receives the alias the user wrote and the real feature it maps to. It chooses a clear summary and optional details, with special wording for web search and legacy Landlock, and returns those strings.

**Call relations**: `Features::record_legacy_usage_force` calls this before storing a legacy-usage record. It uses `Feature::key` for canonical replacement names and `web_search_details` for web-search-specific instructions.

*Call graph*: calls 2 internal fn (key, web_search_details); called by 1 (record_legacy_usage_force); 1 external calls (format!).


##### `web_search_details`  (lines 586–588)

```
fn web_search_details() -> &'static str
```

**Purpose**: Returns the detailed help text for replacing old web-search feature flags.

**Data flow**: It takes no input and returns a fixed string explaining the newer `web_search` config values: live, cached, or disabled.

**Call relations**: `legacy_usage_notice` calls this when building warnings for deprecated web-search flags. Keeping this text in one function avoids repeating the same guidance.

*Call graph*: called by 1 (legacy_usage_notice).


##### `feature_for_key`  (lines 591–598)

```
fn feature_for_key(key: &str) -> Option<Feature>
```

**Purpose**: Translates a config key string into the matching `Feature`, accepting both current keys and legacy keys.

**Data flow**: It receives a string. It first searches the main `FEATURES` registry for an exact key match; if none is found, it asks the legacy feature-key module. It returns the matching feature or nothing.

**Call relations**: `Features::apply_map` uses this to understand user config keys, and `is_known_feature_key` uses it for validation. It is the broad lookup that includes compatibility names.

*Call graph*: calls 1 internal fn (feature_for_key); called by 2 (apply_map, is_known_feature_key).


##### `canonical_feature_for_key`  (lines 600–605)

```
fn canonical_feature_for_key(key: &str) -> Option<Feature>
```

**Purpose**: Translates only current, canonical feature keys into features. Unlike `feature_for_key`, it does not accept legacy names.

**Data flow**: It receives a string, searches the main `FEATURES` registry for that exact key, and returns the matching feature if found.

**Call relations**: This is useful when a caller wants to know whether a key is official rather than merely accepted for backward compatibility.


##### `is_known_feature_key`  (lines 608–610)

```
fn is_known_feature_key(key: &str) -> bool
```

**Purpose**: Checks whether a string is any known feature key, including legacy names.

**Data flow**: It receives a key string, calls `feature_for_key`, and returns true if the lookup found a feature.

**Call relations**: Validation code can use this as a simple yes-or-no check. The actual matching rules live in `feature_for_key`.

*Call graph*: calls 1 internal fn (feature_for_key).


##### `Features::apply_toml`  (lines 629–632)

```
fn apply_toml(&mut self, features: &FeaturesToml)
```

**Purpose**: Applies a parsed `FeaturesToml` config table to the current feature set.

**Data flow**: It receives structured TOML feature settings, asks that structure for its flattened entries map, and sends the map to `Features::apply_map`.

**Call relations**: `Features::from_sources` calls this for base and profile config. This function bridges rich TOML parsing and the simpler map-based feature application logic.

*Call graph*: calls 2 internal fn (apply_map, entries).


##### `FeaturesToml::clear_removed_compatibility_entries`  (lines 638–641)

```
fn clear_removed_compatibility_entries(&mut self)
```

**Purpose**: Removes config entries that are kept only so old files can still parse, but should not be written back into fresh resolved config.

**Data flow**: It mutates a `FeaturesToml` value by clearing the removed apps MCP path override field and deleting its old boolean entry from the general map.

**Call relations**: `FeaturesToml::materialize_resolved_enabled` calls this before writing resolved feature states. It keeps obsolete compatibility settings from reappearing in generated config.

*Call graph*: called by 1 (materialize_resolved_enabled).


##### `FeaturesToml::entries`  (lines 643–655)

```
fn entries(&self) -> BTreeMap<String, bool>
```

**Purpose**: Produces a flat map of feature keys to true-or-false values from a TOML feature table.

**Data flow**: It starts with the simple boolean entries already stored in the table. Then it looks inside richer config blocks for `code_mode`, `multi_agent_v2`, and `network_proxy`; when those blocks say enabled or disabled, it adds the corresponding canonical key to the map.

**Call relations**: `Features::apply_toml` calls this so all feature settings, simple and structured, can be processed by `Features::apply_map` in one common path.

*Call graph*: called by 1 (apply_toml).


##### `FeaturesToml::materialize_resolved_enabled`  (lines 657–681)

```
fn materialize_resolved_enabled(&mut self, features: &Features)
```

**Purpose**: Rewrites a TOML feature table so it explicitly reflects the final resolved enabled state of every feature.

**Data flow**: It receives the final `Features` set. It first removes compatibility-only entries and legacy keys. Then, for every feature in the registry, it writes the resolved true-or-false value into either the relevant structured feature block or the generic entries map.

**Call relations**: Config-writing or normalization code can call this when it wants a concrete, up-to-date feature table. It uses `Features::enabled` to read final states and `materialize_resolved_feature_enabled` for structured feature blocks.

*Call graph*: calls 4 internal fn (enabled, clear_removed_compatibility_entries, legacy_feature_keys, materialize_resolved_feature_enabled).


##### `materialize_resolved_feature_enabled`  (lines 684–692)

```
fn materialize_resolved_feature_enabled(
    feature: &mut Option<FeatureToml<T>>,
    enabled: bool,
)
```

**Purpose**: Sets the enabled value for a structured TOML feature entry, creating the entry if it does not already exist.

**Data flow**: It receives an optional `FeatureToml` block and a boolean. If the block exists, it updates its enabled field; if it is missing, it creates a simple enabled-or-disabled entry.

**Call relations**: `FeaturesToml::materialize_resolved_enabled` uses this for features such as code mode, multi-agent v2, and network proxy that may have richer config than a plain boolean.

*Call graph*: called by 1 (materialize_resolved_enabled); 1 external calls (Enabled).


##### `FeaturesToml::from`  (lines 695–700)

```
fn from(entries: BTreeMap<String, bool>) -> Self
```

**Purpose**: Builds a `FeaturesToml` value from a plain map of feature names to booleans.

**Data flow**: It receives a `BTreeMap<String, bool>`, stores it as the table’s generic entries, and fills every other field with its default empty value.

**Call relations**: Tests and config code use this when they already have simple feature toggles and need the structured TOML wrapper type.

*Call graph*: called by 11 (resolve_bootstrap_auth_keyring_backend_kind_uses_secret_auth_storage_feature, feature_table_overrides_legacy_flags, memory_tool_makes_memories_root_readable_without_creating_or_widening_writes, responses_websocket_features_do_not_change_wire_api, resolve_windows_sandbox_mode_falls_back_to_legacy_keys, from_sources_ignores_removed_apply_patch_freeform_feature_key, from_sources_ignores_removed_image_detail_original_feature_key, from_sources_ignores_removed_js_repl_feature_keys, from_sources_ignores_removed_plugin_hooks_feature_key, from_sources_ignores_removed_terminal_resize_reflow_feature_key (+1 more)); 1 external calls (default).


##### `FeatureToml::enabled`  (lines 713–718)

```
fn enabled(&self) -> Option<bool>
```

**Purpose**: Reads whether a feature TOML entry says the feature is enabled, even when that entry is a richer config object instead of a plain boolean.

**Data flow**: It receives a `FeatureToml`. If it is the simple boolean form, it returns that boolean. If it is the config form, it asks the config object for its enabled value, which may be absent.

**Call relations**: `FeaturesToml::entries` uses this to flatten structured feature settings into the same true-or-false map as simple settings.


##### `FeatureToml::set_enabled`  (lines 720–725)

```
fn set_enabled(&mut self, enabled: bool)
```

**Purpose**: Updates the enabled state inside a feature TOML entry, whether that entry is a plain boolean or a richer config block.

**Data flow**: It receives a mutable `FeatureToml` and a boolean. For the simple form it replaces the boolean; for the config form it calls the config object’s setter.

**Call relations**: `materialize_resolved_feature_enabled` uses this when writing final resolved states back into structured TOML entries.


##### `unstable_features_warning_event`  (lines 1278–1325)

```
fn unstable_features_warning_event(
    effective_features: Option<&Table>,
    suppress_unstable_features_warning: bool,
    features: &Features,
    config_path: &str,
) -> Option<Event>
```

**Purpose**: Creates a warning event when the user has explicitly enabled under-development features. The warning explains that these features may be incomplete or unpredictable.

**Data flow**: It receives the effective TOML feature table, a suppression flag, the final feature set, and the config path. If warnings are suppressed, it returns nothing. Otherwise it finds enabled feature entries whose registry stage is `UnderDevelopment` and that are truly enabled in `Features`; if any exist, it returns a warning event listing them.

**Call relations**: Startup or config reporting code can call this after feature resolution. It uses `Features::enabled` to avoid warning about entries that did not survive final resolution, then packages the message as a protocol `Event` for the rest of Codex to display.

*Call graph*: calls 1 internal fn (enabled); 5 external calls (new, new, format!, matches!, Warning).


### `core/src/config/managed_features.rs`

`config` · `config load and feature-setting changes`

This file is a guardrail around the project's feature flags. A feature flag is a switch that turns a behavior on or off. Some environments can declare requirements, such as “this feature must be enabled” or “that feature must be disabled.” This file reads those requirements, applies them to the configured feature set, and rejects any setting that would conflict with them.

The main type is `ManagedFeatures`, which wraps the normal `Features` value. Think of it like a thermostat with a locked minimum and maximum: users can still adjust the temperature, but the lock stops them from choosing values outside the allowed range. Here, “pinned” features are the locked switches.

When `ManagedFeatures` is built, it parses feature requirements from TOML configuration, normalizes the requested features by forcing pinned values, then checks that feature dependencies did not make the final result violate a pin. Later changes go through the same path: normalize first, validate second, then store.

The file also validates raw `ConfigToml` before startup continues. It catches direct contradictions, such as a config file explicitly disabling a feature that a requirement file says must be enabled. Unknown or older feature names are warned about rather than silently ignored when warnings are requested.

#### Function details

##### `ManagedFeatures::default`  (lines 30–38)

```
fn default() -> Self
```

**Purpose**: Creates a `ManagedFeatures` value with the normal default feature flags and no forced feature requirements. This is the unrestricted starting point.

**Data flow**: It takes no input. It builds default `Features`, wraps them in a constraint object that allows any value, records no source file, and starts with an empty map of pinned features. The result is a ready-to-use `ManagedFeatures` with no special locks.

**Call relations**: This is used when code needs a basic feature set before any requirement file is involved. It relies on the underlying `Features` default and the constraint wrapper to create the safe container.

*Call graph*: calls 2 internal fn (new, allow_any); 2 external calls (new, default).


##### `ManagedFeatures::from_configured`  (lines 42–51)

```
fn from_configured(
        configured_features: Features,
        feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
    ) -> std::io::Result<Self>
```

**Purpose**: Builds managed features from already-read feature settings, optionally applying feature requirements. It is the simple constructor for callers that do not need to collect startup warnings.

**Data flow**: It receives configured feature flags and optional sourced feature requirements. It passes them onward without a warnings list. The output is either a valid `ManagedFeatures` or an input/output error if the requirements cannot be satisfied.

**Call relations**: Other startup and validation code calls this when it needs required feature pins enforced. It delegates the real work to `ManagedFeatures::from_configured_with_optional_warnings`, so all construction paths share the same rules.

*Call graph*: called by 3 (resolve_bootstrap_auth_keyring_backend_kind, validate_feature_requirements_in_config_toml, guardian_review_session_config_allows_pinned_disabled_feature); 1 external calls (from_configured_with_optional_warnings).


##### `ManagedFeatures::from_configured_with_warnings`  (lines 53–63)

```
fn from_configured_with_warnings(
        configured_features: Features,
        feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
        startup_warnings: &mut Vec<String>,
    ) -> st
```

**Purpose**: Builds managed features while also collecting warning messages about feature requirement names. This is useful during startup, where warnings can be shown to the user.

**Data flow**: It receives configured features, optional sourced requirements, and a mutable list of startup warnings. It forwards all three to the shared constructor. The result is a valid `ManagedFeatures` or an error, and the warning list may have new messages added.

**Call relations**: The config loading flow calls this so it can keep going for non-fatal issues, such as old feature names, while still reporting them. The shared optional-warning constructor does the actual parsing and validation.

*Call graph*: called by 1 (load_config_with_layer_stack); 1 external calls (from_configured_with_optional_warnings).


##### `ManagedFeatures::from_configured_with_optional_warnings`  (lines 65–87)

```
fn from_configured_with_optional_warnings(
        configured_features: Features,
        feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
        startup_warnings: Option<&mut Vec<Stri
```

**Purpose**: This is the central constructor. It applies pinned feature requirements, normalizes dependencies, and refuses to create a managed feature set if the final result contradicts the required pins.

**Data flow**: It receives configured features, optional feature requirements with their source, and optionally a warnings list. If requirements exist, it parses them into a map of pinned feature switches. It then forces those pinned values into the configured feature set, normalizes feature dependencies, validates the result, and returns a `ManagedFeatures` containing the normalized features and the pins.

**Call relations**: Both public construction helpers call this so they behave consistently. It hands requirement parsing to `parse_feature_requirements`, feature adjustment to `normalize_candidate`, and final safety checking to `validate_pinned_features`.

*Call graph*: calls 5 internal fn (new, allow_any, normalize_candidate, parse_feature_requirements, validate_pinned_features); 1 external calls (new).


##### `ManagedFeatures::get`  (lines 89–91)

```
fn get(&self) -> &Features
```

**Purpose**: Returns the current feature flags inside `ManagedFeatures`. It lets other code inspect the active feature state without changing it.

**Data flow**: It reads the wrapped constrained value and returns a shared reference to the underlying `Features`. Nothing is changed.

**Call relations**: The dereference helper and `set_enabled` use this to access the current feature state. It is the safe read-only doorway into the wrapped feature set.

*Call graph*: called by 2 (deref, set_enabled); 1 external calls (get).


##### `ManagedFeatures::normalize_and_validate`  (lines 93–102)

```
fn normalize_and_validate(&self, candidate: Features) -> ConstraintResult<Features>
```

**Purpose**: Prepares a proposed feature set for use and checks whether it is allowed. It is the shared safety step before a feature set can be accepted.

**Data flow**: It receives a candidate `Features` value. It forces all pinned features to their required values, normalizes dependencies, asks the underlying constraint wrapper whether the value can be set, and checks the pinned features again. It returns the normalized features if valid, or a constraint error if not.

**Call relations**: `ManagedFeatures::can_set` uses this for a dry run, and `ManagedFeatures::set` uses it before storing a new value. It calls `normalize_candidate` first, then `validate_pinned_features_constraint` so changes cannot bypass the pin rules.

*Call graph*: calls 2 internal fn (normalize_candidate, validate_pinned_features_constraint); called by 2 (can_set, set); 1 external calls (can_set).


##### `ManagedFeatures::can_set`  (lines 104–106)

```
fn can_set(&self, candidate: &Features) -> ConstraintResult<()>
```

**Purpose**: Checks whether a proposed feature set would be accepted, without actually changing the stored features.

**Data flow**: It receives a reference to a candidate feature set, clones it, and sends the clone through normalization and validation. It returns success if the candidate would be allowed, or a constraint error if not. The current stored features remain unchanged.

**Call relations**: Callers can use this as a preview before attempting a real update. It relies on `ManagedFeatures::normalize_and_validate`, which keeps the dry-run rules identical to the real set operation.

*Call graph*: calls 1 internal fn (normalize_and_validate); 1 external calls (clone).


##### `ManagedFeatures::set`  (lines 108–111)

```
fn set(&mut self, candidate: Features) -> ConstraintResult<()>
```

**Purpose**: Replaces the current feature flags, but only after applying required pins and checking that the final result is valid.

**Data flow**: It receives a proposed `Features` value. It normalizes and validates that value, then writes the accepted normalized version into the wrapped constraint container. It returns success or a constraint error.

**Call relations**: `ManagedFeatures::set_enabled` calls this after changing one feature in a copy of the current state. This function is the commit point that prevents invalid feature states from being stored.

*Call graph*: calls 1 internal fn (normalize_and_validate); called by 1 (set_enabled).


##### `ManagedFeatures::set_enabled`  (lines 113–117)

```
fn set_enabled(&mut self, feature: Feature, enabled: bool) -> ConstraintResult<()>
```

**Purpose**: Turns one feature on or off while still respecting pinned feature requirements. It is the basic single-switch update helper.

**Data flow**: It receives a feature and the desired on/off value. It clones the current feature set, changes that one switch in the clone, and sends the result through `ManagedFeatures::set`. The stored value changes only if validation succeeds.

**Call relations**: `ManagedFeatures::enable` and `ManagedFeatures::disable` are small convenience wrappers around this. It reads through `ManagedFeatures::get` and commits through `ManagedFeatures::set`.

*Call graph*: calls 2 internal fn (get, set); called by 2 (disable, enable).


##### `ManagedFeatures::enable`  (lines 119–121)

```
fn enable(&mut self, feature: Feature) -> ConstraintResult<()>
```

**Purpose**: Convenience method that tries to turn one feature on. It still obeys any requirement that might force the feature off.

**Data flow**: It receives a feature, converts the request into `enabled = true`, and forwards it to `ManagedFeatures::set_enabled`. The result is success if the managed rules allow the change, or a constraint error otherwise.

**Call relations**: This is a human-friendly wrapper for callers that want to enable a feature without passing a boolean themselves. The real update path continues through `set_enabled`.

*Call graph*: calls 1 internal fn (set_enabled).


##### `ManagedFeatures::disable`  (lines 123–125)

```
fn disable(&mut self, feature: Feature) -> ConstraintResult<()>
```

**Purpose**: Convenience method that tries to turn one feature off. It still obeys any requirement that might force the feature on.

**Data flow**: It receives a feature, converts the request into `enabled = false`, and forwards it to `ManagedFeatures::set_enabled`. The result is success if the managed rules allow the change, or a constraint error otherwise.

**Call relations**: This mirrors `ManagedFeatures::enable` for turning a feature off. The same validation path in `set_enabled` decides whether the change is allowed.

*Call graph*: calls 1 internal fn (set_enabled).


##### `ManagedFeatures::from`  (lines 132–140)

```
fn from(features: Features) -> Self
```

**Purpose**: Test-only shortcut that wraps a plain `Features` value without applying requirement constraints. It exists so tests can build `ManagedFeatures` directly.

**Data flow**: It receives a `Features` value, wraps it in a constraint container that allows any value, records no source, and leaves the pinned-feature map empty. The output is a `ManagedFeatures` suited for tests that do not need requirement enforcement.

**Call relations**: Several tests use this to create controlled feature states quickly. Because it is compiled only for tests, normal runtime construction still goes through the requirement-aware constructors.

*Call graph*: calls 2 internal fn (new, allow_any); called by 4 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result); 1 external calls (new).


##### `ManagedFeatures::deref`  (lines 146–148)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets `ManagedFeatures` be read like a plain `Features` value in places where only inspection is needed. This is a convenience for Rust code.

**Data flow**: It receives a reference to `ManagedFeatures` and returns a reference to its inner `Features` by calling `ManagedFeatures::get`. Nothing is changed.

**Call relations**: Code that uses Rust's dereference behavior can read feature data without explicitly calling `get`. This helper funnels that access through the same read-only method.

*Call graph*: calls 1 internal fn (get).


##### `normalize_candidate`  (lines 151–160)

```
fn normalize_candidate(
    mut candidate: Features,
    pinned_features: &BTreeMap<Feature, bool>,
) -> Features
```

**Purpose**: Forces pinned feature values into a proposed feature set and then fixes up feature dependencies. This makes a candidate match the project's required feature rules before validation.

**Data flow**: It receives a mutable candidate feature set and a map of pinned features. For each pin, it sets that feature to the required on/off value. Then it asks the feature set to normalize dependencies, meaning related features are adjusted so the combination makes sense. It returns the adjusted candidate.

**Call relations**: The constructor and update validation both call this before accepting features. It is the step that turns a user's requested settings into the actual settings allowed under the pins.

*Call graph*: calls 2 internal fn (normalize_dependencies, set_enabled); called by 2 (from_configured_with_optional_warnings, normalize_and_validate).


##### `validate_pinned_features_constraint`  (lines 162–187)

```
fn validate_pinned_features_constraint(
    normalized_features: &Features,
    pinned_features: &BTreeMap<Feature, bool>,
    source: Option<&RequirementSource>,
) -> ConstraintResult<()>
```

**Purpose**: Checks that the final normalized feature set still matches all pinned requirements. This catches cases where dependency normalization would conflict with a required pin.

**Data flow**: It receives normalized features, pinned requirements, and optionally the source of those requirements. If there is no source, it treats the value as unrestricted and succeeds. Otherwise it compares each pinned feature's actual value with its required value. On mismatch, it returns a constraint error that includes the bad value, the allowed set, and where the requirement came from.

**Call relations**: `ManagedFeatures::normalize_and_validate` uses this during ordinary updates, and `validate_pinned_features` uses it during construction. It calls `feature_requirements_display` to produce a clear allowed-values message.

*Call graph*: calls 2 internal fn (feature_requirements_display, enabled); called by 2 (normalize_and_validate, validate_pinned_features); 1 external calls (format!).


##### `validate_pinned_features`  (lines 189–196)

```
fn validate_pinned_features(
    normalized_features: &Features,
    pinned_features: &BTreeMap<Feature, bool>,
    source: Option<&RequirementSource>,
) -> std::io::Result<()>
```

**Purpose**: Runs pinned-feature validation and converts any constraint failure into an input/output error. This fits construction code that reports invalid configuration as file/data errors.

**Data flow**: It receives normalized features, pinned requirements, and an optional requirement source. It delegates the comparison to `validate_pinned_features_constraint`. If that returns a constraint error, this function wraps it as an `InvalidData` I/O error; otherwise it returns success.

**Call relations**: The main constructor calls this after normalizing configured features. It is the bridge between feature-constraint logic and configuration-loading error reporting.

*Call graph*: calls 1 internal fn (validate_pinned_features_constraint); called by 1 (from_configured_with_optional_warnings).


##### `feature_requirements_display`  (lines 198–204)

```
fn feature_requirements_display(feature_requirements: &BTreeMap<Feature, bool>) -> String
```

**Purpose**: Turns pinned feature requirements into a short readable string for error messages. It helps users see exactly which feature values were allowed.

**Data flow**: It receives a map of features to required boolean values. It formats each entry as `feature_key=true` or `feature_key=false`, joins them with commas, wraps them in brackets, and returns the resulting string.

**Call relations**: Both pinned-feature validation and explicit-config validation use this when they need to explain a conflict. It does no checking itself; it only prepares the human-readable allowed list.

*Call graph*: called by 2 (validate_explicit_feature_settings_in_config_toml, validate_pinned_features_constraint); 1 external calls (format!).


##### `parse_feature_requirements`  (lines 206–242)

```
fn parse_feature_requirements(
    feature_requirements: FeatureRequirementsToml,
    source: &RequirementSource,
    mut startup_warnings: Option<&mut Vec<String>>,
) -> BTreeMap<Feature, bool>
```

**Purpose**: Reads feature requirements from TOML data and turns them into the internal pinned-feature map. It also warns about unknown or older feature names.

**Data flow**: It receives TOML feature requirements, the source they came from, and optionally a startup warning list. For each key, it maps known canonical names to `Feature` values, handles a special old name `auto_review`, accepts legacy names with a warning, and ignores unknown names with a warning. The output is a map saying which features must be on or off.

**Call relations**: The managed-features constructor calls this to understand requirement files, and explicit config validation calls it to compare requirements against direct config settings. It sends warning messages through `push_feature_requirement_warning`.

*Call graph*: calls 1 internal fn (push_feature_requirement_warning); called by 2 (from_configured_with_optional_warnings, validate_explicit_feature_settings_in_config_toml); 4 external calls (new, canonical_feature_for_key, feature_for_key, format!).


##### `push_feature_requirement_warning`  (lines 244–252)

```
fn push_feature_requirement_warning(
    startup_warnings: &mut Option<&mut Vec<String>>,
    message: String,
)
```

**Purpose**: Reports a non-fatal problem found while reading feature requirements. It logs the warning and, when requested, stores it for startup reporting.

**Data flow**: It receives an optional warning list and a message. It writes the message to the tracing log, then appends the same message to the list if one was provided. It returns nothing.

**Call relations**: `parse_feature_requirements` calls this when it sees legacy or unknown requirement keys. This keeps warning behavior consistent whether the caller wants collected startup warnings or only log output.

*Call graph*: called by 1 (parse_feature_requirements); 1 external calls (warn!).


##### `explicit_feature_settings_in_config`  (lines 254–272)

```
fn explicit_feature_settings_in_config(cfg: &ConfigToml) -> Vec<(String, Feature, bool)>
```

**Purpose**: Finds feature switches that were directly written in the main config file. This lets validation detect when the config explicitly fights a required feature pin.

**Data flow**: It receives a `ConfigToml` value. It scans the `[features]` entries and the separate `experimental_use_unified_exec_tool` setting, converts recognized keys into `Feature` values, and records each setting as a path, feature, and boolean value. It returns that list.

**Call relations**: `validate_explicit_feature_settings_in_config_toml` calls this before comparing explicit settings with pinned requirements. It focuses only on gathering what the user directly set in the config.

*Call graph*: called by 1 (validate_explicit_feature_settings_in_config_toml); 3 external calls (new, feature_for_key, format!).


##### `validate_explicit_feature_settings_in_config_toml`  (lines 274–314)

```
fn validate_explicit_feature_settings_in_config_toml(
    cfg: &ConfigToml,
    feature_requirements: Option<&Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<()>
```

**Purpose**: Checks whether the main config file directly contradicts feature requirements. It gives an early, clear error when a user writes a setting that a requirement file forbids.

**Data flow**: It receives the parsed config and optional sourced requirements. If there are no requirements, it succeeds. Otherwise it parses the pinned features, builds a readable allowed list, scans explicit config feature settings, and compares each one to the required value. On contradiction, it returns an `InvalidData` error describing the exact config path and requirement source.

**Call relations**: Higher-level config validation calls this as part of checking a `ConfigToml`. It uses `parse_feature_requirements` for the requirement map, `explicit_feature_settings_in_config` for the user's direct settings, and `feature_requirements_display` for the error text.

*Call graph*: calls 3 internal fn (explicit_feature_settings_in_config, feature_requirements_display, parse_feature_requirements); called by 1 (validate_feature_requirements_for_config_toml); 2 external calls (new, format!).


##### `validate_feature_requirements_in_config_toml`  (lines 316–329)

```
fn validate_feature_requirements_in_config_toml(
    cfg: &ConfigToml,
    feature_requirements: Option<&Sourced<FeatureRequirementsToml>>,
) -> std::io::Result<()>
```

**Purpose**: Checks whether the complete feature state derived from config can satisfy the feature requirements. This catches conflicts after all feature sources and defaults have been combined.

**Data flow**: It receives the parsed config and optional sourced requirements. It builds a `Features` value from the config's feature section, the experimental unified-exec option, default secondary sources, and default overrides. Then it constructs `ManagedFeatures` from that combined value and the requirements. The output is success if the combined state is valid, or an error if the requirements cannot be met.

**Call relations**: Higher-level config validation calls this alongside the explicit-setting check. It hands the combined feature state to `ManagedFeatures::from_configured`, so the same normalization and pinned-feature validation used at runtime is also used while checking config files.

*Call graph*: calls 2 internal fn (from_configured, from_sources); called by 1 (validate_feature_requirements_for_config_toml); 2 external calls (default, default).


### `tui/src/bottom_pane/experimental_features_view.rs`

`domain_logic` · `interactive popup`

This file is the user-facing switchboard for experimental features inside the terminal interface. Without it, the app could still know that experimental features exist, but users would not have this built-in screen for viewing them, moving through them, toggling them, and saving the result.

The main type is `ExperimentalFeaturesView`. It owns a list of feature items, remembers which row is selected, and knows when the popup is finished. Think of it like a small checklist dialog: each row has a name, a short description, and a checkbox marker showing whether it is enabled.

When the view is created, it builds a header explaining what the popup is for, creates a footer hint explaining the useful keys, and selects the first feature if there is one. Keyboard input then moves the selection up and down, jumps by page, jumps to the top or bottom, toggles the selected checkbox with Space, and exits with accept or cancel keys. Exiting is important: this is when the view sends an `UpdateFeatureFlags` app event containing every feature and its final enabled state.

For drawing, the file converts feature items into simple display rows, measures how tall those rows need to be, and renders them inside the available terminal space with a header and footer. It also handles empty lists gracefully by showing that no experimental features are available.

#### Function details

##### `ExperimentalFeaturesView::new`  (lines 52–74)

```
fn new(
        features: Vec<ExperimentalFeatureItem>,
        app_event_tx: AppEventSender,
        keymap: ListKeymap,
    ) -> Self
```

**Purpose**: Creates a new experimental-features popup with its feature list, event sender, and keyboard rules. It also prepares the title text, the help text at the bottom, and the starting selection.

**Data flow**: It receives the available features, a way to send events back to the app, and the keymap. It builds the header and footer text, stores the list and scrolling state, calls the selection setup step, and returns a ready-to-render view.

**Call relations**: This is called when the experimental-features popup is opened, including by normal UI code and snapshot or behavior tests. During construction it calls `experimental_popup_hint_line` for the footer text and then uses `ExperimentalFeaturesView::initialize_selection` to make the first row active when possible.

*Call graph*: calls 3 internal fn (experimental_popup_hint_line, new, new); called by 3 (open_experimental_popup, experimental_features_popup_snapshot, experimental_features_toggle_saves_on_exit); 2 external calls (new, from).


##### `ExperimentalFeaturesView::initialize_selection`  (lines 76–82)

```
fn initialize_selection(&mut self)
```

**Purpose**: Chooses the initial highlighted row. If there are no features, it leaves nothing selected; otherwise it selects the first feature when no selection already exists.

**Data flow**: It reads the current feature count through `ExperimentalFeaturesView::visible_len` and checks the current selection state. It then either clears the selection or sets it to index zero, changing only the view's scroll state.

**Call relations**: This is part of startup for the popup and is called by `ExperimentalFeaturesView::new`. It relies on `ExperimentalFeaturesView::visible_len` so the selection matches the actual number of visible rows.

*Call graph*: calls 1 internal fn (visible_len).


##### `ExperimentalFeaturesView::visible_len`  (lines 84–86)

```
fn visible_len(&self) -> usize
```

**Purpose**: Reports how many feature rows can be shown. In this view, every stored feature is visible, so it returns the length of the feature list.

**Data flow**: It reads `self.features`, counts its items, and returns that number. It does not change anything.

**Call relations**: Navigation and setup functions call this before moving the selection. It gives `initialize_selection`, `move_up`, `move_down`, `page_up`, `page_down`, `jump_top`, and `jump_bottom` the list size they need to avoid invalid positions.

*Call graph*: called by 7 (initialize_selection, jump_bottom, jump_top, move_down, move_up, page_down, page_up).


##### `ExperimentalFeaturesView::build_rows`  (lines 88–107)

```
fn build_rows(&self) -> Vec<GenericDisplayRow>
```

**Purpose**: Turns the internal feature list into rows that the shared popup renderer can draw. It adds the selection arrow and checkbox marker that users see on screen.

**Data flow**: It reads each feature item, the current selected index, and each item's enabled flag. For every item it creates a display row with text like a selected arrow, `[x]` or `[ ]`, the feature name, and the description, then returns the finished row list.

**Call relations**: Rendering code calls this whenever it needs to draw or measure the popup. `ExperimentalFeaturesView::render` uses the rows for display, and `ExperimentalFeaturesView::desired_height` uses the same rows to estimate how much vertical space the popup wants.

*Call graph*: called by 2 (desired_height, render); 3 external calls (default, with_capacity, format!).


##### `ExperimentalFeaturesView::move_up`  (lines 109–116)

```
fn move_up(&mut self)
```

**Purpose**: Moves the highlighted feature one row upward, wrapping around if needed. It also keeps the highlighted row inside the visible scroll window.

**Data flow**: It reads the feature count. If the list is empty, it does nothing; otherwise it updates the selected index through the scroll state and adjusts the scroll offset so the selected row remains visible.

**Call relations**: This is triggered by `ExperimentalFeaturesView::handle_key_event` when the user presses the configured move-up key. It delegates the actual selection and scroll math to `ScrollState` methods.

*Call graph*: calls 3 internal fn (visible_len, ensure_visible, move_up_wrap); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::move_down`  (lines 118–125)

```
fn move_down(&mut self)
```

**Purpose**: Moves the highlighted feature one row downward, wrapping around if needed. It keeps the screen scrolled so the chosen row can still be seen.

**Data flow**: It checks how many rows exist. With no rows it exits immediately; with rows it updates the selected index and then adjusts the visible window around that selection.

**Call relations**: This is called by `ExperimentalFeaturesView::handle_key_event` for the configured move-down key. Like `move_up`, it uses `ScrollState` to do the safe movement and visibility work.

*Call graph*: calls 3 internal fn (visible_len, ensure_visible, move_down_wrap); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::page_up`  (lines 127–131)

```
fn page_up(&mut self)
```

**Purpose**: Moves the selection upward by a page of rows rather than just one row. This is useful for longer feature lists.

**Data flow**: It reads the feature count and calculates how many rows can be considered visible, limited by the popup's maximum row count. It then asks the scroll state to move upward by that page amount without going outside the list.

**Call relations**: This is called from `ExperimentalFeaturesView::handle_key_event` when the page-up key binding is pressed. It uses `ExperimentalFeaturesView::visible_len` and then hands the movement to the scroll state.

*Call graph*: calls 2 internal fn (visible_len, page_up_clamped); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::page_down`  (lines 133–137)

```
fn page_down(&mut self)
```

**Purpose**: Moves the selection downward by a page of rows. It helps users travel through longer lists faster than pressing down repeatedly.

**Data flow**: It reads the list length, calculates the current page size from the maximum popup rows, and tells the scroll state to move down while staying within the list limits.

**Call relations**: This is called by `ExperimentalFeaturesView::handle_key_event` for the page-down key binding. It follows the same navigation pattern as `page_up`, but in the opposite direction.

*Call graph*: calls 2 internal fn (visible_len, page_down_clamped); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::jump_top`  (lines 139–143)

```
fn jump_top(&mut self)
```

**Purpose**: Moves the selection directly to the first feature in the list. It is a shortcut for quickly returning to the top.

**Data flow**: It reads how many visible rows exist and computes the visible row limit. It then updates the scroll state so the top row is selected and visible.

**Call relations**: This is called from `ExperimentalFeaturesView::handle_key_event` when the jump-to-top key is pressed. The scroll state performs the actual positioning.

*Call graph*: calls 2 internal fn (visible_len, jump_top); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::jump_bottom`  (lines 145–149)

```
fn jump_bottom(&mut self)
```

**Purpose**: Moves the selection directly to the last feature in the list. It is a shortcut for quickly reaching the end.

**Data flow**: It reads the visible list length, calculates the visible row limit, and asks the scroll state to select the bottom row while keeping the viewport in a sensible position.

**Call relations**: This is called by `ExperimentalFeaturesView::handle_key_event` when the jump-to-bottom key is pressed. It depends on the same list-size helper as the other movement functions.

*Call graph*: calls 2 internal fn (visible_len, jump_bottom); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::toggle_selected`  (lines 151–159)

```
fn toggle_selected(&mut self)
```

**Purpose**: Flips the checkbox state for the currently highlighted feature. If it was enabled, it becomes disabled; if it was disabled, it becomes enabled.

**Data flow**: It reads the selected row index from the scroll state. If there is no selected row or the index does not point to an item, it does nothing; otherwise it changes that feature item's `enabled` value in place.

**Call relations**: This is called by `ExperimentalFeaturesView::handle_key_event` when the user presses Space. The changed values stay in the view until `ExperimentalFeaturesView::on_ctrl_c` sends them back to the app.

*Call graph*: called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::rows_width`  (lines 161–163)

```
fn rows_width(total_width: u16) -> u16
```

**Purpose**: Calculates how much horizontal space the feature rows should use inside the popup. It leaves a small margin so text does not press against the border area.

**Data flow**: It receives the total available width and subtracts two columns, using safe subtraction so very small widths do not underflow below zero. It returns the usable row width.

**Call relations**: This helper is used when the view measures or renders rows. It keeps layout calculations consistent between drawing and height estimation.


##### `ExperimentalFeaturesView::handle_key_event`  (lines 167–187)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Responds to keyboard input while the popup is open. It turns key presses into actions like moving the selection, toggling a feature, or finishing the popup.

**Data flow**: It receives one key event and compares it against the configured key bindings and the Space key. Depending on the match, it changes selection state, toggles the selected feature, saves and closes, or ignores the key.

**Call relations**: The surrounding bottom-pane system calls this whenever the user presses a key. This function is the dispatcher: it sends movement keys to `move_up`, `move_down`, `page_up`, `page_down`, `jump_top`, or `jump_bottom`, sends Space to `toggle_selected`, and sends accept or cancel keys to `on_ctrl_c`.

*Call graph*: calls 8 internal fn (jump_bottom, jump_top, move_down, move_up, on_ctrl_c, page_down, page_up, toggle_selected).


##### `ExperimentalFeaturesView::is_complete`  (lines 189–191)

```
fn is_complete(&self) -> bool
```

**Purpose**: Tells the rest of the UI whether this popup is finished. Once it returns true, the bottom-pane system can close or replace the view.

**Data flow**: It reads the `complete` flag stored in the view and returns that boolean value. It does not alter any state.

**Call relations**: The bottom-pane framework calls this as part of its lifecycle checks. The flag becomes true when `ExperimentalFeaturesView::on_ctrl_c` finishes the popup.


##### `ExperimentalFeaturesView::on_ctrl_c`  (lines 193–207)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Finishes the popup and saves the current feature choices. Despite the name, it is used for both cancel-style and accept-style exit keys in this view.

**Data flow**: It reads all feature items and, if the list is not empty, converts them into pairs of feature identifier and enabled state. It sends those pairs in an `UpdateFeatureFlags` app event, marks the view complete, and returns that the cancellation or close action was handled.

**Call relations**: This is called by `ExperimentalFeaturesView::handle_key_event` when the user presses an accept or cancel key. It hands the final choices to the wider app through `AppEventSender::send`, which is what allows the settings to be saved outside this popup.

*Call graph*: calls 1 internal fn (send); called by 1 (handle_key_event).


##### `ExperimentalFeaturesView::render`  (lines 211–267)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the experimental-features popup into the terminal screen buffer. It lays out the header, feature rows, empty-list message, and footer hint.

**Data flow**: It receives a screen rectangle and a mutable drawing buffer. If there is no space, it returns; otherwise it divides the area into content and footer sections, prepares rows with `build_rows`, measures their height, renders the header and rows, and finally draws the dimmed keyboard hint at the bottom.

**Call relations**: The terminal rendering system calls this whenever the view needs to appear on screen. It uses shared rendering helpers such as `measure_rows_height` and `render_rows` so this popup looks and scrolls like other selection popups.

*Call graph*: calls 5 internal fn (build_rows, measure_rows_height, render_rows, vh, user_message_style); 7 external calls (default, Fill, Length, Max, vertical, clone, rows_width).


##### `ExperimentalFeaturesView::desired_height`  (lines 269–282)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Estimates how tall the popup wants to be for a given width. This helps the surrounding layout choose enough space before drawing.

**Data flow**: It receives an available width, builds the display rows, calculates the row width and row height, adds the header height plus spacing and footer space, and returns the total desired height.

**Call relations**: The layout system calls this before or during rendering decisions. It mirrors the row-building and measuring logic used by `ExperimentalFeaturesView::render`, which keeps measurement and actual drawing aligned.

*Call graph*: calls 2 internal fn (build_rows, measure_rows_height); 1 external calls (rows_width).


##### `experimental_popup_hint_line`  (lines 285–293)

```
fn experimental_popup_hint_line() -> Line<'static>
```

**Purpose**: Builds the footer help text shown at the bottom of the popup. It tells the user that Space toggles a feature and Enter saves for the next conversation.

**Data flow**: It creates a line made from plain text plus formatted key names for Space and Enter. It returns that line for the view to store and later draw.

**Call relations**: This is called by `ExperimentalFeaturesView::new` during setup. The returned line becomes the popup's footer hint and is rendered by `ExperimentalFeaturesView::render`.

*Call graph*: called by 1 (new); 2 external calls (from, vec!).


### Skills configuration and installation
These files describe skill-related config, install bundled system skills, seed extension assets, and load the final filtered skill set for runtime use.

### `config/src/skills_config.rs`

`config` · `config load`

This file is a small configuration blueprint for the project’s skill system. A “skill” here is something the system can select by file path or by name, then turn on or off through configuration. Without these types, different parts of the project would not have a shared, reliable way to understand the skill-related settings a user writes in a config file.

The file defines three main shapes of data. `SkillConfig` describes one selectable skill: it may point to a path, a name, and whether it is enabled. `SkillsConfig` is the larger container for all skill settings. It can include settings for bundled, built-in skills; a switch for whether automatic skill instructions are included in turns; and a list of individual skill rules. `BundledSkillsConfig` says whether the built-in skills are enabled.

The code also explains how these settings are read from TOML, a common human-friendly configuration file format. It uses serialization and schema traits so the same structures can be loaded from config files, written back out, compared in tests, and described in generated JSON Schema. The important default is that bundled skills are enabled unless the user explicitly says otherwise.

#### Function details

##### `default_enabled`  (lines 8–10)

```
fn default_enabled() -> bool
```

**Purpose**: This tiny helper supplies the default value for a missing `enabled` setting. It makes bundled skills turn on by default unless the user clearly disables them.

**Data flow**: Nothing goes in. The function always returns `true`, which is then used as the default value when a configuration file leaves out the bundled-skills `enabled` field.

**Call relations**: This function is used by the configuration reading machinery through the `serde` default setting on `BundledSkillsConfig.enabled`. When that field is absent in the user’s TOML, the deserializer calls on this helper so the loaded configuration still has a clear yes-or-no value.


##### `BundledSkillsConfig::default`  (lines 46–48)

```
fn default() -> Self
```

**Purpose**: This creates the standard bundled-skills configuration. The standard behavior is that bundled skills are enabled.

**Data flow**: Nothing goes in. It builds and returns a `BundledSkillsConfig` value whose `enabled` field is `true`; it does not change anything outside itself.

**Call relations**: This is the type’s default constructor, used whenever code asks for a normal `BundledSkillsConfig` without spelling out every field. It matches the same behavior used during config-file loading: built-in skills start enabled unless the user says otherwise.


##### `SkillsConfig::try_from`  (lines 54–56)

```
fn try_from(value: toml::Value) -> Result<Self, Self::Error>
```

**Purpose**: This converts a raw TOML configuration value into a typed `SkillsConfig`. It is the bridge between text-like configuration data and the safer Rust structure the rest of the program can use.

**Data flow**: A `toml::Value` goes in, representing parsed TOML data. The function asks the deserialization system to interpret that value as `SkillsConfig`; if the shape and field types are valid, a `SkillsConfig` comes out, and if not, a TOML decoding error comes out instead.

**Call relations**: When some other part of the configuration system has a TOML value and needs skill settings, it can call this conversion. This function hands the real parsing work to `deserialize`, which applies the field rules, defaults, and unknown-field checks defined on the configuration structs.

*Call graph*: 1 external calls (deserialize).


### `ext/skills/src/config.rs`

`config` · `config load and skill discovery setup`

The skills extension needs a few yes-or-no decisions from the larger application that is running it. This file gives those decisions a clear shape in one place. It defines `SkillsExtensionConfig`, a simple configuration record with two switches. The first switch, `include_instructions`, controls whether the catalog of available skills is included in the model's context. In plain terms, it decides whether the assistant is told what skills exist and how to use them. The second switch, `bundled_skills_enabled`, controls whether skills shipped with the system are allowed to appear during discovery. That is like deciding whether a toolbox should include the default tools that came in the box, or only tools supplied from somewhere else. Without this file, other parts of the skills extension would not have a shared, typed way to ask these questions. Each caller might invent its own flags or assumptions, which would make behavior harder to understand and easier to break.


### `skills/src/lib.rs`

`io_transport` · `startup`

This file is the bridge between skills bundled inside the application and skills available as normal files on the user’s machine. The program includes a sample skills directory at build time, like packing a small folder into the application binary. At startup, this code makes sure that folder exists under CODEX_HOME/skills/.system so the rest of the system can read those skills from disk in the usual way.

The main path is simple. First it creates the top-level skills folder if needed. Then it checks a marker file inside the system skills cache. That marker contains a fingerprint, which is a compact hash value representing the embedded folder’s paths and file contents. If the marker matches the current embedded skills, the installer stops early. This is like checking a shipping label before unpacking a box again.

If the cache is missing or stale, the file removes the old .system folder, writes the embedded directory tree back to disk, and saves a new marker. Errors are wrapped in SystemSkillsError with a short action label, so callers can tell whether the failure happened while creating a folder, reading the marker, writing a file, and so on. There is also a test that makes sure fingerprinting sees files inside nested folders, not just top-level files.

#### Function details

##### `system_cache_root_dir`  (lines 18–22)

```
fn system_cache_root_dir(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Builds the folder path where bundled system skills should live on disk. Given CODEX_HOME, it points to CODEX_HOME/skills/.system.

**Data flow**: It receives an absolute CODEX_HOME path, appends the skills folder name, then appends the hidden .system folder name. It returns the resulting absolute path without touching the filesystem.

**Call relations**: install_system_skills calls this when it needs to know where to check, remove, or write the cached system skills directory.

*Call graph*: calls 1 internal fn (join); called by 1 (install_system_skills).


##### `install_system_skills`  (lines 32–56)

```
fn install_system_skills(codex_home: &AbsolutePathBuf) -> Result<(), SystemSkillsError>
```

**Purpose**: Makes sure the built-in system skills are installed into the user’s CODEX_HOME folder. It skips the copy when a marker proves the existing cache already matches the bundled skills.

**Data flow**: It receives CODEX_HOME. It creates CODEX_HOME/skills if needed, calculates the destination .system directory, computes the expected fingerprint of the embedded skills, and reads the existing marker if one is present. If the marker matches, it returns success immediately. Otherwise it deletes the old .system folder if it exists, writes the embedded skills to disk, writes a fresh marker file, and returns success or a detailed error.

**Call relations**: This is the public entry point for this file’s work. It calls system_cache_root_dir to choose the cache location, embedded_system_skills_fingerprint to know what version should be present, read_marker to check the existing cache, and write_embedded_dir to unpack the bundled directory when needed.

*Call graph*: calls 5 internal fn (embedded_system_skills_fingerprint, read_marker, system_cache_root_dir, write_embedded_dir, join); 4 external calls (format!, create_dir_all, remove_dir_all, write).


##### `read_marker`  (lines 58–63)

```
fn read_marker(path: &AbsolutePathBuf) -> Result<String, SystemSkillsError>
```

**Purpose**: Reads the marker file that records which version of the embedded system skills was last installed. The marker is used to decide whether reinstalling is necessary.

**Data flow**: It receives the marker file path, reads the file as text, removes surrounding whitespace such as the trailing newline, and returns the cleaned marker string. If reading fails, it returns a SystemSkillsError that says the failure happened while reading the system skills marker.

**Call relations**: install_system_skills calls this after computing the expected fingerprint. Its result decides whether the installer can safely skip rewriting the system skills directory.

*Call graph*: calls 1 internal fn (as_path); called by 1 (install_system_skills); 1 external calls (read_to_string).


##### `embedded_system_skills_fingerprint`  (lines 65–77)

```
fn embedded_system_skills_fingerprint() -> String
```

**Purpose**: Creates a fingerprint for the system skills bundled inside the program. This fingerprint changes when a bundled file path, folder path, or file content changes.

**Data flow**: It starts with the embedded directory, asks collect_fingerprint_items to gather every relevant path and file-content hash, sorts those entries so the result is stable, then feeds them into a hasher along with a salt string. It returns the final hash as text.

**Call relations**: install_system_skills calls this before checking the marker file. It relies on collect_fingerprint_items to walk the embedded directory tree, then turns that collected list into the single value stored in the marker.

*Call graph*: calls 1 internal fn (collect_fingerprint_items); called by 1 (install_system_skills); 3 external calls (new, new, format!).


##### `collect_fingerprint_items`  (lines 79–96)

```
fn collect_fingerprint_items(dir: &Dir<'_>, items: &mut Vec<(String, Option<u64>)>)
```

**Purpose**: Walks through the embedded system skills directory and records what should count toward the cache fingerprint. It includes both directories and files, and for files it also records a hash of the contents.

**Data flow**: It receives an embedded directory and a mutable list to fill. For each entry, it adds directory paths with no content hash, and for files it hashes the file bytes and adds the file path plus that content hash. For subdirectories, it calls itself again so nested files are included too.

**Call relations**: embedded_system_skills_fingerprint uses this to gather the raw material for the final fingerprint. The test tests::fingerprint_traverses_nested_entries also calls it directly to confirm that nested skill files are not missed.

*Call graph*: called by 2 (embedded_system_skills_fingerprint, fingerprint_traverses_nested_entries); 2 external calls (new, entries).


##### `write_embedded_dir`  (lines 101–128)

```
fn write_embedded_dir(dir: &Dir<'_>, dest: &AbsolutePathBuf) -> Result<(), SystemSkillsError>
```

**Purpose**: Copies the embedded skills directory tree out of the program and onto disk. It preserves the embedded folder and file layout under the chosen destination.

**Data flow**: It receives an embedded directory and a destination path. It creates the destination folder, loops through embedded entries, creates subfolders as needed, and writes each embedded file’s bytes to the matching disk path. If any filesystem step fails, it returns a SystemSkillsError describing which step failed.

**Call relations**: install_system_skills calls this only when the existing cache is missing or stale. It is the part that actually unpacks the built-in skill files after the installer has decided a rewrite is needed.

*Call graph*: calls 2 internal fn (as_path, join); called by 1 (install_system_skills); 3 external calls (entries, create_dir_all, write).


##### `SystemSkillsError::io`  (lines 141–143)

```
fn io(action: &'static str, source: std::io::Error) -> Self
```

**Purpose**: Builds a consistent error value for filesystem failures. It records both the low-level input/output error and a short phrase explaining what the code was trying to do.

**Data flow**: It receives an action label such as “write system skill file” and the original std::io::Error from the operating system. It returns a SystemSkillsError::Io value containing both pieces of information.

**Call relations**: The filesystem-facing functions use this helper whenever they convert a raw disk error into the file’s public error type. That keeps error messages consistent across marker reading, directory creation, deletion, and file writing.


##### `tests::fingerprint_traverses_nested_entries`  (lines 152–168)

```
fn fingerprint_traverses_nested_entries()
```

**Purpose**: Checks that fingerprint collection sees files inside nested folders. This protects against a bug where only top-level skill files would affect the marker.

**Data flow**: It starts with an empty list, asks collect_fingerprint_items to fill it from the embedded system skills directory, extracts and sorts the collected paths, then asserts that known nested files are present. The output is a passing or failing test result.

**Call relations**: This test calls collect_fingerprint_items directly because that function is responsible for recursive traversal. By checking specific nested paths, it supports the reliability of embedded_system_skills_fingerprint and therefore the install-skipping logic in install_system_skills.

*Call graph*: calls 1 internal fn (collect_fingerprint_items); 2 external calls (new, assert!).


### `core-skills/src/system.rs`

`orchestration` · `setup and teardown of cached system skills`

The project has a set of built-in skills that can be installed into a local cache under the Codex home folder. This file acts like a simple front desk for that system. It re-exports two helper functions from the shared skills library: one to install the system skills, and one to compute the folder where those skills are cached.

It also adds one local cleanup function, `uninstall_system_skills`. Given the Codex home path, it finds the system skills cache folder and deletes that whole folder from disk. In plain terms, this is like clearing out a downloaded toolbox so the program can start fresh later.

One important detail is that deletion errors are ignored. If the folder is already gone, or if removal fails for some reason, this function does not stop the caller with an error. That makes sense for cleanup code where “nothing to delete” is usually not a problem, but it also means callers should not rely on this function to prove that the folder was definitely removed.

#### Function details

##### `uninstall_system_skills`  (lines 6–8)

```
fn uninstall_system_skills(codex_home: &AbsolutePathBuf)
```

**Purpose**: Removes the cached built-in system skills for a given Codex home directory. Someone would use this when they want to reset or restrict the available skills by clearing the previously installed system-skill files.

**Data flow**: It receives the Codex home folder as an absolute path. From that, it asks for the exact cache folder used for system skills, then tries to delete that folder and everything inside it. It returns nothing, and it deliberately ignores whether the delete attempt succeeded or failed.

**Call relations**: When `new_with_restriction_product` needs to create a restricted setup, it calls this cleanup step so old system-skill files do not remain in the cache. This function then hands the Codex home path to `system_cache_root_dir` to locate the right folder, and passes that folder to the filesystem removal operation.

*Call graph*: called by 1 (new_with_restriction_product); 2 external calls (system_cache_root_dir, remove_dir_all).


### `memories/write/src/extensions/ad_hoc.rs`

`io_transport` · `startup or memory extension setup`

This file is a small setup helper for an extension called `ad_hoc`. Its job is to place a built-in instructions template into the right folder inside the memory storage area. Think of it like putting a welcome note into a new project folder: it should appear the first time the folder is prepared, but if someone has already written their own note, it must be left alone.

The file embeds the template text at compile time using `include_str!`, so the program does not need to look up the template separately while running. When asked to seed the instructions, it first finds the root folder for memory extensions, then adds an `ad_hoc` subfolder, then targets `instructions.md` inside it.

It creates the folder if needed. Then it tries to create the instruction file only if it does not already exist. That “create only if new” behavior is important: it protects user edits from being silently replaced. If the file is new, the template text is written and flushed, meaning the program asks the operating system to push the data out rather than leaving it only in a temporary write buffer. If the file is already there, this helper treats that as success.

#### Function details

##### `seed_instructions`  (lines 8–26)

```
async fn seed_instructions(memory_root: &Path) -> std::io::Result<()>
```

**Purpose**: This function prepares the default `instructions.md` file for the `ad_hoc` extension. It is used when the system is setting up extension instruction files, and it carefully avoids overwriting an existing file.

**Data flow**: It receives the main memory folder path. From that, it asks `memory_extensions_root` for the extensions folder, adds the `ad_hoc` folder name, and then points to `instructions.md` inside it. It creates the folder if it is missing, then tries to create a brand-new file. If creation succeeds, it writes the embedded template text and flushes it to disk. If the file already exists, it returns success without changing it. If any other disk error happens, it returns that error to the caller.

**Call relations**: This function is called by `seed_extension_instructions` when the broader setup flow is preparing instruction files for extensions. Inside its own work, it relies on `memory_extensions_root` to find the correct parent folder, uses `create_dir_all` to ensure the folder exists, and uses `OpenOptions::new` to open the file in a safe create-only mode before writing the template.

*Call graph*: called by 1 (seed_extension_instructions); 3 external calls (memory_extensions_root, new, create_dir_all).


### `memories/write/src/extensions/mod.rs`

`orchestration` · `startup and memory test setup`

This module acts like a reception desk for extension-related memory-writing work. Other parts of the program do not need to know which internal file contains which extension feature; they can come through this file instead.

It connects two extension pieces. The `ad_hoc` extension is used to place initial instruction files under the memory root, which is the folder where this memory system stores its data. The `prune` extension provides cleanup for old extension resources, and this file re-exports that cleanup function so callers can use it without reaching into the private `prune` module directly.

The main function here, `seed_extension_instructions`, does not create the instructions itself. It delegates to `ad_hoc::seed_instructions`. This is important because startup code can ask for extension instructions to be seeded through one clear function, while the details stay inside the extension implementation. If this file were missing, callers would either need to know the internal module layout or duplicate that wiring themselves, making the system harder to change safely.

#### Function details

##### `seed_extension_instructions`  (lines 6–8)

```
async fn seed_extension_instructions(memory_root: &Path) -> std::io::Result<()>
```

**Purpose**: This function makes sure extension instruction files are seeded under the given memory root folder. It gives startup code one simple place to ask for that setup, without exposing the lower-level `ad_hoc` module.

**Data flow**: It receives a path to the memory root folder. It passes that path to `ad_hoc::seed_instructions`, waits for the asynchronous file setup to finish, and returns either success or an input/output error if the filesystem work fails. It does not produce a separate value; its result says whether the seeding completed.

**Call relations**: During normal startup, `start_memories_startup_task` calls this function as part of preparing the memory system. A memory phase-two model request test also calls it so the test environment has the same extension instructions available. This function then hands the real work to `seed_instructions`, keeping callers insulated from the extension’s internal layout.

*Call graph*: calls 1 internal fn (seed_instructions); called by 2 (start_memories_startup_task, run_memory_phase_two_model_request_test).


### `core-skills/src/config_rules.rs`

`config` · `config load and skill discovery`

Skills can be enabled or disabled in more than one place: a user config file, session flags, and possibly other config layers. This file is the place that reads those layers and turns them into one ordered list of rules. Think of it like a stack of sticky notes: later notes can cover earlier ones, and the final visible note is what matters.

A rule can point to a skill in two ways. It can name a skill by its name, or it can point directly to the skill file path. The file keeps these two selector types separate because they behave differently: a path affects one exact file, while a name may affect every loaded skill with that name.

The main flow has two stages. First, `skill_config_rules_from_stack` reads only the config layers that are allowed to control skills here, namely user config and session flags. It ignores invalid skill config entries and logs warnings when something cannot be used. It preserves rule order so later settings can override earlier settings.

Second, `resolve_disabled_skill_paths` takes the loaded skill metadata and those rules, then produces the final set of skill file paths that are disabled. This matters because later code can simply ask, “is this path disabled?” without re-reading every config layer.

#### Function details

##### `skill_config_rules_from_stack`  (lines 30–69)

```
fn skill_config_rules_from_stack(config_layer_stack: &ConfigLayerStack) -> SkillConfigRules
```

**Purpose**: This function reads the layered configuration and extracts skill enable/disable rules from the layers that are meant to affect skills. It creates a clean ordered rule list that later code can apply to actual discovered skills.

**Data flow**: It receives a `ConfigLayerStack`, which is a pile of configuration layers with different priority levels. It reads the layers from lowest priority to highest priority, looks for a `skills` section in user and session layers, converts that section into skill config entries, and turns each usable entry into a rule. If a later rule uses the same selector as an earlier one, it removes the older one and keeps the newer one. The output is a `SkillConfigRules` value containing the final ordered list of rules.

**Call relations**: This is called when the system is preparing skills or plugins from configuration, such as during skill loading, plugin loading, marketplace plugin detail lookup, and tests that check override behavior. During its work it calls `skill_config_rule_selector` to interpret each individual config entry, and it logs a warning instead of stopping the whole process when a skills config section is invalid.

*Call graph*: calls 2 internal fn (get_layers, skill_config_rule_selector); called by 9 (load_plugins_from_layer_stack, plugins_for_config_with_force_reload, read_plugin_detail_for_marketplace_plugin, skills_for_config, skills_for_cwd, disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, disabled_paths_for_skills_disables_matching_name_selectors); 3 external calls (new, matches!, warn!).


##### `resolve_disabled_skill_paths`  (lines 71–103)

```
fn resolve_disabled_skill_paths(
    skills: &[SkillMetadata],
    rules: &SkillConfigRules,
) -> HashSet<AbsolutePathBuf>
```

**Purpose**: This function applies the collected rules to the actual skills that were found, and returns the file paths of the skills that should be disabled. It is the point where abstract config rules become concrete paths the loader can skip or mark inactive.

**Data flow**: It receives a list of loaded `SkillMetadata` records and a `SkillConfigRules` list. It starts with an empty set of disabled paths. Then it walks through the rules in order. A path rule directly adds or removes that path from the disabled set depending on whether the rule disables or enables it. A name rule finds every loaded skill with that name, then adds or removes each matching skill path. The result is a `HashSet` of absolute paths for disabled skills.

**Call relations**: This is called by skill loading and outcome-building code after rules have already been extracted from configuration. It does not read config itself; it only applies the already-prepared rules to the known skills, so callers get a simple final answer: which skill paths are disabled.

*Call graph*: called by 2 (load_plugin_skills, build_skill_outcome); 2 external calls (new, iter).


##### `skill_config_rule_selector`  (lines 105–128)

```
fn skill_config_rule_selector(entry: &SkillConfig) -> Option<SkillConfigRuleSelector>
```

**Purpose**: This helper interprets one skill config entry and decides what kind of selector it contains: a path selector or a name selector. It also protects the rest of the code from unclear or unusable entries.

**Data flow**: It receives one `SkillConfig` entry. If the entry has a path and no name, it turns the path into a path selector, using the canonical path when possible and falling back to the original path if that fails. If the entry has a name and no path, it trims extra spaces and returns a name selector unless the name is empty. If the entry has both path and name, or neither, it logs a warning and returns nothing. The output is either a usable selector or `None`.

**Call relations**: This function is used only by `skill_config_rules_from_stack` while that function is building the ordered rule list. It acts like a small gatekeeper: valid entries move forward as selectors, while ambiguous or empty entries are ignored with a warning so one bad config item does not break the whole skill-loading process.

*Call graph*: called by 1 (skill_config_rules_from_stack); 3 external calls (Name, Path, warn!).


### `core-skills/src/loader.rs`

`orchestration` · `startup / skill discovery`

A “skill” is a small package of instructions and optional metadata that Codex can discover and offer to the user or invoke later. This file is the skill loader: it answers two practical questions. First, where should the app look for skills? Second, when it finds a SKILL.md file, is it valid enough to use?

The file starts by building a list of skill roots, meaning folders that may contain skills. Those roots can come from configuration layers, the current repository, the user’s home folder, cached system skills, plugins, or explicit extra paths. It keeps track of each root’s scope, such as repo or user, because scope affects priority and behavior.

Then it walks through each root like a careful librarian searching shelves. It skips hidden names, limits scan depth and total directories so a bad folder tree cannot make loading run forever, and follows symlinks only for certain scopes. When it finds SKILL.md, it reads the YAML frontmatter at the top, cleans up names and descriptions, optionally reads an agents/openai.yaml metadata file, validates length limits, and records any user-visible errors.

The final result is deduplicated, sorted by priority, and linked back to the file system that supplied each skill. Without this file, the app would not reliably know what skills exist, where they came from, or whether their metadata is safe to trust.

#### Function details

##### `SkillParseError::fmt`  (lines 138–150)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns a skill parsing problem into a clear human-readable message. This is what makes errors like missing frontmatter or invalid YAML understandable instead of showing only raw internal error types.

**Data flow**: It receives a specific SkillParseError value and a text formatter. It matches the error kind, writes an appropriate sentence into the formatter, and produces the normal formatting result.

**Call relations**: It is used whenever a SkillParseError needs to be displayed as text, especially after parse_skill_file fails and the loader records an error message for the caller.

*Call graph*: 1 external calls (write!).


##### `load_skills_from_roots`  (lines 163–233)

```
async fn load_skills_from_roots(roots: I) -> SkillLoadOutcome
```

**Purpose**: Loads all skills from a supplied set of root folders and returns one clean loading result. It is the main collector that turns many possible directories into a deduplicated, sorted list of usable skills.

**Data flow**: It receives SkillRoot entries, each with a path, scope, file system, and optional plugin information. For each root it canonicalizes the path, scans for skills, records which root and file system produced each skill, removes duplicate SKILL.md paths, sorts skills by scope and name, and returns a SkillLoadOutcome.

**Call relations**: Higher-level flows such as plugin skill loading, building a skill outcome, listing skills, and tests call this when they already know which roots to search. It delegates actual directory walking to discover_skills_under_root and path normalization to canonicalize_for_skill_identity, then packages the combined result.

*Call graph*: calls 3 internal fn (canonicalize_for_skill_identity, discover_skills_under_root, new); called by 4 (load_plugin_skills, build_skill_outcome, list, skill_loading_and_reads_use_the_supplied_executor_file_system); 5 external calls (new, new, new, new, default).


##### `skill_roots`  (lines 235–253)

```
async fn skill_roots(
    fs: Option<Arc<dyn ExecutorFileSystem>>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
    plugin_skill_roots: Vec<PluginSkillRoot>,
    extra_skill_r
```

**Purpose**: Builds the list of places where skills should be searched, using the real home directory when available. It is the public helper for turning configuration and the current working directory into SkillRoot entries.

**Data flow**: It receives an optional repository file system, the configuration layer stack, the current directory, plugin roots, and extra roots. It finds the user’s home directory, passes all of that to skill_roots_with_home_dir, and returns the resulting root list.

**Call relations**: Callers such as skill_roots_for_config and skills_for_cwd use this before loading skills. It is a thin wrapper around skill_roots_with_home_dir so tests can inject a fake home directory through the lower-level helper.

*Call graph*: calls 1 internal fn (skill_roots_with_home_dir); called by 2 (skill_roots_for_config, skills_for_cwd); 1 external calls (home_dir).


##### `skill_roots_with_home_dir`  (lines 255–281)

```
async fn skill_roots_with_home_dir(
    fs: Option<Arc<dyn ExecutorFileSystem>>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
    home_dir: Option<&AbsolutePathBuf>,
    plugi
```

**Purpose**: Combines all known sources of skill folders into one list, then removes repeated paths. It is the central root-building routine used by both production code and tests.

**Data flow**: It receives configuration, current directory, optional home directory, plugin roots, and extra roots. It starts with roots from configuration layers, appends plugin and explicit roots, adds repository .agents/skills roots between the project root and current directory, deduplicates by path, and returns the final list.

**Call relations**: skill_roots calls it during normal operation, and skill_roots_from_layer_stack calls it in tests. It relies on skill_roots_from_layer_stack_inner for config-derived roots, repo_agents_skill_roots for repository-local roots, and dedupe_skill_roots_by_path to avoid searching the same folder twice.

*Call graph*: calls 3 internal fn (dedupe_skill_roots_by_path, repo_agents_skill_roots, skill_roots_from_layer_stack_inner); called by 2 (skill_roots, skill_roots_from_layer_stack).


##### `skill_roots_from_layer_stack_inner`  (lines 283–362)

```
fn skill_roots_from_layer_stack_inner(
    config_layer_stack: &ConfigLayerStack,
    home_dir: Option<&AbsolutePathBuf>,
    repo_fs: Option<Arc<dyn ExecutorFileSystem>>,
) -> Vec<SkillRoot>
```

**Purpose**: Extracts skill search folders from the app’s configuration layers. It translates config locations into concrete skill directories with the correct scope, such as repo, user, system, or admin.

**Data flow**: It reads the configuration layers from highest to lowest precedence, looks at each layer’s source and folder, and creates SkillRoot records for recognized skill locations. It returns those roots without adding plugin, extra, or repository .agents paths.

**Call relations**: skill_roots_with_home_dir calls this as its first source of roots. The result is later extended with plugin roots, explicit roots, and repository-local roots before deduplication.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (skill_roots_with_home_dir); 3 external calls (clone, new, system_cache_root_dir).


##### `repo_agents_skill_roots`  (lines 364–398)

```
async fn repo_agents_skill_roots(
    fs: Option<Arc<dyn ExecutorFileSystem>>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
) -> Vec<SkillRoot>
```

**Purpose**: Finds .agents/skills folders that live inside the current repository path. This lets a project provide skills close to the code they are meant to help with.

**Data flow**: It receives the repository file system, configuration, and current directory. It determines project root markers, finds the project root, walks the directories from that root down to the current directory, checks each one for a .agents/skills directory, and returns SkillRoot entries for the directories that exist.

**Call relations**: skill_roots_with_home_dir calls this after adding configured and explicit roots. It uses project_root_markers_from_stack, find_project_root, and dirs_between_project_root_and_cwd so repository skill discovery respects project boundaries.

*Call graph*: calls 4 internal fn (dirs_between_project_root_and_cwd, find_project_root, project_root_markers_from_stack, from_abs_path); called by 1 (skill_roots_with_home_dir); 3 external calls (clone, new, warn!).


##### `project_root_markers_from_stack`  (lines 400–420)

```
fn project_root_markers_from_stack(config_layer_stack: &ConfigLayerStack) -> Vec<String>
```

**Purpose**: Decides which filenames or folder names mark the root of a project. These markers are used to stop repository skill searching at the right top-level directory.

**Data flow**: It merges non-project configuration layers from lowest to highest precedence, asks the config parser for project root markers, and falls back to defaults if none are set or the setting is invalid. It returns a list of marker names.

**Call relations**: repo_agents_skill_roots calls this before searching upward from the current directory. Its output guides find_project_root, much like landmarks telling the loader where the project starts.

*Call graph*: calls 1 internal fn (get_layers); called by 1 (repo_agents_skill_roots); 7 external calls (Table, default_project_root_markers, merge_toml_values, project_root_markers_from_config, matches!, new, warn!).


##### `find_project_root`  (lines 422–449)

```
async fn find_project_root(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
    project_root_markers: &[String],
) -> AbsolutePathBuf
```

**Purpose**: Searches upward from the current directory to find the nearest ancestor that looks like the project root. It prevents repository skill discovery from wandering too far up the filesystem.

**Data flow**: It receives a file system, the current directory, and marker names. For each ancestor directory, it checks whether any marker exists there; if it finds one, it returns that ancestor, otherwise it returns the current directory as a safe fallback.

**Call relations**: repo_agents_skill_roots calls this after choosing marker names. Its answer is passed to dirs_between_project_root_and_cwd so only relevant directories are checked for .agents/skills.

*Call graph*: calls 2 internal fn (ancestors, from_abs_path); called by 1 (repo_agents_skill_roots); 3 external calls (get_metadata, warn!, clone).


##### `dirs_between_project_root_and_cwd`  (lines 451–470)

```
fn dirs_between_project_root_and_cwd(
    cwd: &AbsolutePathBuf,
    project_root: &AbsolutePathBuf,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds the ordered path of directories from the project root to the current directory. This gives the loader every level where a repository might define nearby skills.

**Data flow**: It receives the current directory and project root. It walks upward from the current directory until it reaches the project root, then reverses the list so it runs from root down to current directory.

**Call relations**: repo_agents_skill_roots uses this list to check each directory for a .agents/skills folder. It supplies the route for repository-local skill discovery.

*Call graph*: calls 1 internal fn (ancestors); called by 1 (repo_agents_skill_roots).


##### `dedupe_skill_roots_by_path`  (lines 472–475)

```
fn dedupe_skill_roots_by_path(roots: &mut Vec<SkillRoot>)
```

**Purpose**: Removes repeated skill roots that point to the same path. This avoids scanning the same folder more than once.

**Data flow**: It receives a mutable list of SkillRoot records. It remembers paths it has already seen, keeps the first root for each path, and removes later duplicates from the list in place.

**Call relations**: skill_roots_with_home_dir calls this after combining config, plugin, extra, and repository roots. It is the final cleanup step before the root list is returned.

*Call graph*: called by 1 (skill_roots_with_home_dir); 1 external calls (new).


##### `canonicalize_for_skill_identity`  (lines 477–486)

```
async fn canonicalize_for_skill_identity(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
) -> AbsolutePathBuf
```

**Purpose**: Normalizes a path so the same real file or folder has one stable identity. This helps deduplication work even when paths involve symlinks or different spellings.

**Data flow**: It receives a file system and an absolute path. It asks the file system to canonicalize the path; if that succeeds, it returns the resolved absolute path, and if it fails, it returns the original path.

**Call relations**: load_skills_from_roots uses it to identify roots, discover_skills_under_root uses it for directories and plugin roots, and parse_skill_file uses it for the final SKILL.md path. It is a safety net around path comparison.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (discover_skills_under_root, load_skills_from_roots, parse_skill_file); 1 external calls (canonicalize).


##### `discover_skills_under_root`  (lines 488–637)

```
async fn discover_skills_under_root(
    fs: &dyn ExecutorFileSystem,
    root: &AbsolutePathBuf,
    scope: SkillScope,
    plugin_id: Option<&str>,
    plugin_root: Option<&AbsolutePathBuf>,
    out
```

**Purpose**: Walks through one skill root folder and finds every valid SKILL.md file below it. It is the directory scanner for the loader.

**Data flow**: It receives a file system, root path, scope, optional plugin information, and the mutable load outcome. It verifies the root is a directory, scans breadth-first with depth and directory-count limits, skips hidden entries, follows allowed symlinked directories, parses SKILL.md files, appends successful skills, and records non-system parse errors.

**Call relations**: load_skills_from_roots calls this once per root. It hands each discovered SKILL.md to parse_skill_file, uses canonicalize_for_skill_identity to avoid duplicate directory identities, and writes successful or failed discoveries into the shared SkillLoadOutcome.

*Call graph*: calls 3 internal fn (canonicalize_for_skill_identity, parse_skill_file, from_abs_path); called by 1 (load_skills_from_roots); 8 external calls (new, from, error!, get_metadata, read_directory, matches!, warn!, clone).


##### `parse_skill_file`  (lines 639–705)

```
async fn parse_skill_file(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    scope: SkillScope,
    plugin_id: Option<&str>,
    plugin_root: Option<&AbsolutePathBuf>,
) -> Result<Skill
```

**Purpose**: Reads one SKILL.md file and turns it into structured SkillMetadata. It checks the required frontmatter, cleans text fields, attaches optional metadata, and rejects invalid core fields.

**Data flow**: It receives a file system, SKILL.md path, scope, plugin id, and optional plugin root. It reads the file text, extracts YAML frontmatter, parses name and description fields, chooses a default name if needed, adds a namespace when appropriate, loads optional openai.yaml metadata, validates lengths, canonicalizes the final path, and returns SkillMetadata or a SkillParseError.

**Call relations**: discover_skills_under_root calls this whenever it finds a SKILL.md file. It delegates frontmatter splitting to extract_frontmatter, optional metadata loading to load_skill_metadata, name qualification to namespaced_skill_name, and final path identity to canonicalize_for_skill_identity.

*Call graph*: calls 7 internal fn (canonicalize_for_skill_identity, extract_frontmatter, load_skill_metadata, namespaced_skill_name, validate_len, read_file_text, from_abs_path); called by 1 (discover_skills_under_root); 1 external calls (from_str).


##### `default_skill_name`  (lines 707–717)

```
fn default_skill_name(path: &AbsolutePathBuf) -> String
```

**Purpose**: Chooses a fallback skill name from the folder that contains SKILL.md. This lets a skill still load when the frontmatter does not provide a usable name.

**Data flow**: It receives the SKILL.md path. It looks at the parent folder name, cleans it into a single line, and returns it if non-empty; otherwise it returns the generic name "skill".

**Call relations**: parse_skill_file uses this when the frontmatter name is missing or blank after cleanup. It keeps skill loading forgiving while later validation still enforces length and non-empty rules.

*Call graph*: calls 1 internal fn (parent).


##### `namespaced_skill_name`  (lines 719–728)

```
async fn namespaced_skill_name(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    base_name: &str,
) -> String
```

**Purpose**: Adds a plugin namespace to a skill name when the skill belongs to a plugin. Namespacing helps avoid two plugins accidentally publishing skills with the same plain name.

**Data flow**: It receives the file system, skill path, and base name. It asks plugin utilities whether the path belongs to a plugin namespace; if yes, it returns namespace:base_name, otherwise it returns the base name unchanged.

**Call relations**: parse_skill_file calls this after choosing the base name. The result becomes the public skill name that is validated and stored in SkillMetadata.

*Call graph*: called by 1 (parse_skill_file); 1 external calls (plugin_namespace_for_skill_path).


##### `load_skill_metadata`  (lines 730–799)

```
async fn load_skill_metadata(
    fs: &dyn ExecutorFileSystem,
    skill_path: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
) -> LoadedSkillMetadata
```

**Purpose**: Loads optional extra metadata from agents/openai.yaml next to a skill. This file can describe interface details, tool dependencies, and policy without making SKILL.md itself more crowded.

**Data flow**: It receives a file system, the SKILL.md path, and optional plugin root. It finds the skill directory, looks for agents/openai.yaml, reads and parses it if present, and resolves its interface, dependencies, and policy sections. If anything optional is missing or invalid, it logs a warning and returns empty metadata rather than blocking the skill.

**Call relations**: parse_skill_file calls this after reading the main frontmatter. It passes parsed sections to resolve_interface, resolve_dependencies, and resolve_policy, then returns a LoadedSkillMetadata bundle.

*Call graph*: calls 7 internal fn (resolve_dependencies, resolve_interface, resolve_policy, read_file_text, parent, new, from_abs_path); called by 1 (parse_skill_file); 4 external calls (default, get_metadata, from_str, warn!).


##### `resolve_interface`  (lines 801–844)

```
fn resolve_interface(
    interface: Option<Interface>,
    skill_dir: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
) -> Option<SkillInterface>
```

**Purpose**: Turns the optional interface section from openai.yaml into safe display metadata for a skill. This includes user-facing labels, icons, colors, and a default prompt.

**Data flow**: It receives an optional raw Interface, the skill directory, and optional plugin root. It cleans and length-checks text fields, validates icon paths and color format, then returns a SkillInterface only if at least one field survived.

**Call relations**: load_skill_metadata calls this after parsing openai.yaml. It relies on resolve_str for text, resolve_asset_path for icons, and resolve_color_str for brand color.

*Call graph*: calls 3 internal fn (resolve_asset_path, resolve_color_str, resolve_str); called by 1 (load_skill_metadata).


##### `resolve_dependencies`  (lines 846–858)

```
fn resolve_dependencies(dependencies: Option<Dependencies>) -> Option<SkillDependencies>
```

**Purpose**: Turns the optional dependencies section into a list of required tools for the skill. Empty or invalid dependency lists are treated as absent.

**Data flow**: It receives an optional raw Dependencies value. It resolves each listed tool, drops tools missing required safe fields, and returns SkillDependencies if at least one valid tool remains.

**Call relations**: load_skill_metadata calls this while building LoadedSkillMetadata. Each tool is checked by resolve_dependency_tool before it is exposed to the rest of the app.

*Call graph*: called by 1 (load_skill_metadata).


##### `resolve_policy`  (lines 860–865)

```
fn resolve_policy(policy: Option<Policy>) -> Option<SkillPolicy>
```

**Purpose**: Turns the optional policy section into the app’s SkillPolicy type. Policy says things like whether the skill can be invoked implicitly and which products it applies to.

**Data flow**: It receives an optional raw Policy. If present, it copies the allowed implicit invocation setting and product list into SkillPolicy; if absent, it returns none.

**Call relations**: load_skill_metadata calls this alongside interface and dependency resolution. Its output is attached to the final skill metadata created by parse_skill_file.

*Call graph*: called by 1 (load_skill_metadata).


##### `resolve_dependency_tool`  (lines 867–903)

```
fn resolve_dependency_tool(tool: DependencyTool) -> Option<SkillToolDependency>
```

**Purpose**: Validates and cleans one tool dependency entry. It keeps only dependencies with the required type and value fields, while accepting optional details when they are safe.

**Data flow**: It receives one raw DependencyTool. It requires and cleans the tool type and value, cleans optional description, transport, command, and URL fields, and returns a SkillToolDependency if the required fields are valid.

**Call relations**: resolve_dependencies uses this as the per-tool filter. It relies on resolve_required_str for required fields and resolve_str for optional fields.

*Call graph*: calls 2 internal fn (resolve_required_str, resolve_str).


##### `resolve_asset_path`  (lines 905–952)

```
fn resolve_asset_path(
    skill_dir: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
    field: &'static str,
    path: Option<PathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Checks that an icon path from metadata points to an allowed asset location. This prevents a skill from pointing its icon at arbitrary files elsewhere on disk.

**Data flow**: It receives the skill directory, optional plugin root, the field name for warnings, and an optional relative path. It rejects empty or absolute paths, normalizes simple relative paths, requires normal icons to live under the skill’s assets folder, and lets plugin skills resolve certain parent-directory paths through resolve_plugin_shared_asset_path.

**Call relations**: resolve_interface calls this for small and large icon fields. If a path includes '..', it hands off to resolve_plugin_shared_asset_path to decide whether the path safely stays inside plugin shared assets.

*Call graph*: calls 2 internal fn (resolve_plugin_shared_asset_path, join); called by 1 (resolve_interface); 2 external calls (new, warn!).


##### `resolve_plugin_shared_asset_path`  (lines 954–978)

```
fn resolve_plugin_shared_asset_path(
    skill_dir: &AbsolutePathBuf,
    plugin_root: Option<&AbsolutePathBuf>,
    field: &'static str,
    path: &Path,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Allows plugin skills to use shared plugin-level assets while still blocking unsafe path traversal. It is the special case for icon paths that contain '..'.

**Data flow**: It receives the skill directory, optional plugin root, field name, and raw path. If there is no plugin root it rejects the path; otherwise it normalizes the plugin assets directory and the requested path, verifies the result stays under plugin assets, converts it to an absolute path, and returns it if valid.

**Call relations**: resolve_asset_path calls this only when a metadata icon path tries to move upward with '..'. It uses lexically_normalize to compare paths without needing to touch the file system.

*Call graph*: calls 3 internal fn (lexically_normalize, join, try_from); called by 1 (resolve_asset_path); 1 external calls (warn!).


##### `lexically_normalize`  (lines 980–994)

```
fn lexically_normalize(path: &Path) -> PathBuf
```

**Purpose**: Simplifies a path by processing '.' and '..' components in the text of the path. It is used for safe path comparison, not for checking whether files exist.

**Data flow**: It receives a path. It walks through each path component, skips current-directory markers, removes the previous component for parent-directory markers, keeps roots and normal names, and returns the cleaned PathBuf.

**Call relations**: resolve_plugin_shared_asset_path uses this to compare a requested plugin icon path against the plugin assets directory. This helps decide whether the request stays inside the allowed folder.

*Call graph*: called by 1 (resolve_plugin_shared_asset_path); 2 external calls (components, new).


##### `sanitize_single_line`  (lines 996–998)

```
fn sanitize_single_line(raw: &str) -> String
```

**Purpose**: Cleans user-provided text into one tidy line. It removes repeated whitespace and line breaks so names and descriptions are safe to show in compact UI places.

**Data flow**: It receives a raw string, splits it on any whitespace, joins the pieces with single spaces, and returns the cleaned string.

**Call relations**: resolve_str uses this for metadata strings, and parsing code also uses the same cleanup idea for skill names and descriptions. It is the common text tidying helper.

*Call graph*: called by 1 (resolve_str).


##### `validate_len`  (lines 1000–1015)

```
fn validate_len(
    value: &str,
    max_len: usize,
    field_name: &'static str,
) -> Result<(), SkillParseError>
```

**Purpose**: Enforces required text fields and maximum character lengths for core SKILL.md data. This prevents missing names and oversized descriptions from entering the loaded skill list.

**Data flow**: It receives a string value, a maximum length, and a field name. It returns a missing-field error if the string is empty, an invalid-field error if it is too long, or success if the value is acceptable.

**Call relations**: parse_skill_file calls this for the base name, qualified name, description, and short description. Unlike optional metadata cleanup, failure here stops that skill from loading.

*Call graph*: called by 1 (parse_skill_file); 2 external calls (MissingField, format!).


##### `resolve_str`  (lines 1017–1029)

```
fn resolve_str(value: Option<String>, max_len: usize, field: &'static str) -> Option<String>
```

**Purpose**: Cleans and validates an optional string field from optional metadata. Bad optional fields are ignored with a warning instead of failing the whole skill.

**Data flow**: It receives an optional string, maximum length, and field name. If there is no value it returns none; otherwise it makes the text single-line, rejects empty or too-long values with warnings, and returns the cleaned string when valid.

**Call relations**: resolve_interface and resolve_dependency_tool call this for optional text fields, and resolve_required_str builds on it for required dependency fields.

*Call graph*: calls 1 internal fn (sanitize_single_line); called by 3 (resolve_dependency_tool, resolve_interface, resolve_required_str); 1 external calls (warn!).


##### `resolve_required_str`  (lines 1031–1041)

```
fn resolve_required_str(
    value: Option<String>,
    max_len: usize,
    field: &'static str,
) -> Option<String>
```

**Purpose**: Validates a required string inside optional metadata, especially dependency tool fields. Missing or invalid required values cause that item to be dropped.

**Data flow**: It receives an optional string, maximum length, and field name. If the value is missing it warns and returns none; otherwise it passes the value through resolve_str and returns the cleaned result if valid.

**Call relations**: resolve_dependency_tool calls this for dependency type and value. It is stricter than resolve_str because those fields are needed to make a meaningful dependency.

*Call graph*: calls 1 internal fn (resolve_str); called by 1 (resolve_dependency_tool); 1 external calls (warn!).


##### `resolve_color_str`  (lines 1043–1057)

```
fn resolve_color_str(value: Option<String>, field: &'static str) -> Option<String>
```

**Purpose**: Validates a brand color string from metadata. It accepts only the common #RRGGBB hex color format, such as #3366FF.

**Data flow**: It receives an optional string and field name. It trims whitespace, rejects empty values, checks for a leading # followed by six hexadecimal characters, and returns the color string only if it matches.

**Call relations**: resolve_interface calls this for interface.brand_color. Invalid colors are logged and ignored rather than preventing the skill from loading.

*Call graph*: called by 1 (resolve_interface); 1 external calls (warn!).


##### `extract_frontmatter`  (lines 1059–1080)

```
fn extract_frontmatter(contents: &str) -> Option<String>
```

**Purpose**: Pulls the YAML frontmatter block from the top of a SKILL.md file. Frontmatter is the metadata section between two lines containing only ---.

**Data flow**: It receives the whole SKILL.md text. It checks that the first line is an opening delimiter, collects following lines until a closing delimiter, rejects empty or unclosed blocks, and returns the frontmatter text when present.

**Call relations**: parse_skill_file calls this immediately after reading SKILL.md. If it returns none, parse_skill_file reports a missing-frontmatter error and the skill is not loaded.

*Call graph*: called by 1 (parse_skill_file); 2 external calls (new, matches!).


##### `skill_roots_from_layer_stack`  (lines 1082–1097)

```
async fn skill_roots_from_layer_stack(
    fs: Arc<dyn ExecutorFileSystem>,
    config_layer_stack: &ConfigLayerStack,
    cwd: &AbsolutePathBuf,
    home_dir: Option<&AbsolutePathBuf>,
) -> Vec<Skill
```

**Purpose**: Provides a test-only way to build skill roots with an injected file system and home directory. This makes root discovery testable without relying on the developer’s real machine.

**Data flow**: It receives a file system, configuration stack, current directory, and optional home directory. It calls skill_roots_with_home_dir with no plugin roots and no extra roots, then returns the resulting list.

**Call relations**: This function exists only in test builds. It routes tests through the same core logic used by skill_roots, while letting tests control inputs that are normally discovered from the environment.

*Call graph*: calls 1 internal fn (skill_roots_with_home_dir); 1 external calls (new).


### `core-skills/src/manager.rs`

`orchestration` · `startup and skill loading`

This file solves a practical problem: loading skills can involve checking several places, reading configuration, respecting disabled-skill rules, and installing or hiding bundled system skills. Without this manager, different parts of the program could load different skill sets, reuse stale results, or accidentally expose skills that should be disabled.

The main type is `SkillsManager`. Think of it like a librarian for skills. Given a current working directory, configuration layers, plugin roots, and optional file-system access, it first builds a list of places where skills may live. These places can include repository skills, user skills, system bundled skills, plugin skills, and extra runtime roots. It then loads the skills from those roots, filters them for the current product, applies configuration rules that disable particular skills, and builds lookup tables used later for automatic skill invocation.

The file also keeps two caches. One cache is keyed by current directory for older or file-system-based loading. The other is keyed by the effective skill-related configuration, so two sessions in the same directory but with different overrides do not accidentally share results. A read-write lock is used around shared state; this is a lock that allows many readers or one writer at a time.

A subtle but important behavior is bundled skill installation. When the manager is created, it installs bundled system skills if enabled, or tries to remove stale cached bundled skills if disabled. Even if removal fails, later root filtering still prevents disabled system skills from being selected.

#### Function details

##### `SkillsLoadInput::new`  (lines 37–49)

```
fn new(
        cwd: AbsolutePathBuf,
        effective_skill_roots: Vec<PluginSkillRoot>,
        config_layer_stack: ConfigLayerStack,
        bundled_skills_enabled: bool,
    ) -> Self
```

**Purpose**: Creates a single bundle of information needed to load skills. Callers use it so the manager receives the current directory, plugin skill roots, configuration layers, and bundled-skill setting together.

**Data flow**: It takes the current working directory, the effective plugin skill roots, the layered configuration, and a true-or-false bundled-skills flag. It stores those values unchanged in a `SkillsLoadInput` object and returns it.

**Call relations**: This is used by setup and test flows that need to ask the skill manager for skills. Later, methods such as `SkillsManager::skills_for_config`, `SkillsManager::skill_roots_for_config`, and `SkillsManager::skills_for_cwd` read the fields from this input.

*Call graph*: called by 8 (register_thread_config, set_extra_roots_replaces_runtime_roots_and_clears_cache, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_with_stack, skills_for_cwd_loads_repo_and_user_roots_with_local_fs, skills_for_cwd_uses_cached_result_until_force_reload, skills_for_cwd_without_fs_skips_repo_roots, skills_load_input_from_config).


##### `SkillsManager::new`  (lines 61–63)

```
fn new(codex_home: AbsolutePathBuf, bundled_skills_enabled: bool) -> Self
```

**Purpose**: Creates a normal `SkillsManager` for Codex. It is the simple constructor used when the manager should restrict loaded skills to the Codex product.

**Data flow**: It receives the Codex home directory and whether bundled skills are enabled. It passes those values, plus `Product::Codex` as the product restriction, into the more general constructor and returns the resulting manager.

**Call relations**: Most callers use this shortcut instead of the more flexible constructor. Internally it hands off all real setup work to `SkillsManager::new_with_restriction_product`.

*Call graph*: called by 17 (new_with_disabled_bundled_skills_removes_stale_cached_system_skills, set_extra_roots_applies_to_config_loads_and_empty_clears, set_extra_roots_replaces_runtime_roots_and_clears_cache, skills_for_config_disables_plugin_skills_by_name, skills_for_config_excludes_bundled_skills_when_disabled_in_config, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_reuses_cache_for_same_effective_config, skills_for_cwd_loads_repo_and_user_roots_with_local_fs, skills_for_cwd_uses_cached_result_until_force_reload, skills_for_cwd_without_fs_skips_repo_roots (+7 more)); 1 external calls (new_with_restriction_product).


##### `SkillsManager::new_with_restriction_product`  (lines 65–85)

```
fn new_with_restriction_product(
        codex_home: AbsolutePathBuf,
        bundled_skills_enabled: bool,
        restriction_product: Option<Product>,
    ) -> Self
```

**Purpose**: Creates a `SkillsManager` with an optional product restriction. It also performs the startup work needed for bundled system skills: install them when enabled, or try to remove cached copies when disabled.

**Data flow**: It receives the Codex home directory, the bundled-skills setting, and an optional product name to restrict skills to. It builds a manager with empty extra roots and empty caches. Then it either installs bundled system skills under the Codex home directory, or asks for old bundled system skills to be removed. The finished manager is returned.

**Call relations**: `SkillsManager::new` calls this for the usual Codex setup, while tests and specialized setup can call it directly. It calls `install_system_skills` or `uninstall_system_skills` during construction, and logs an error if installation fails.

*Call graph*: calls 1 internal fn (uninstall_system_skills); called by 2 (new, with_models_provider_home_and_state_for_tests); 5 external calls (new, new, new, install_system_skills, error!).


##### `SkillsManager::set_extra_roots`  (lines 87–96)

```
fn set_extra_roots(&self, extra_roots: Vec<AbsolutePathBuf>)
```

**Purpose**: Replaces the manager’s runtime-added skill directories. This is used when the program wants to add or change extra places where skills can be found.

**Data flow**: It receives a new list of absolute directory paths. It takes a write lock, replaces the stored extra roots with the new list, then clears all cached skill-loading results so old answers do not survive after the search path changed.

**Call relations**: After updating the roots, it calls `SkillsManager::clear_cache`. Later calls to `SkillsManager::skill_roots_for_config` or `SkillsManager::skills_for_cwd` pick up the new extra roots through `SkillsManager::extra_roots`.

*Call graph*: calls 1 internal fn (clear_cache).


##### `SkillsManager::skills_for_config`  (lines 105–124)

```
async fn skills_for_config(
        &self,
        input: &SkillsLoadInput,
        fs: Option<Arc<dyn ExecutorFileSystem>>,
    ) -> SkillLoadOutcome
```

**Purpose**: Loads the correct skills for an already-built configuration, without re-reading configuration layers. This is the safer path when session-specific or role-specific skill overrides may differ even in the same directory.

**Data flow**: It receives a `SkillsLoadInput` and optional file-system access. It computes the skill roots for that exact input, extracts the skill enable/disable rules from the configuration stack, and builds a cache key from the roots plus those rules. If that key is already cached, it returns the cached result. Otherwise it loads and finalizes the skills, stores the result in the configuration-based cache, and returns it.

**Call relations**: This method calls `SkillsManager::skill_roots_for_config` to find search roots, `skill_config_rules_from_stack` to read skill rules, `config_skills_cache_key` to create a safe cache key, `SkillsManager::cached_outcome_for_config` to reuse prior work, and `SkillsManager::build_skill_outcome` when a fresh load is needed.

*Call graph*: calls 5 internal fn (skill_config_rules_from_stack, build_skill_outcome, cached_outcome_for_config, skill_roots_for_config, config_skills_cache_key); called by 1 (skills_for_config_with_stack).


##### `SkillsManager::skill_roots_for_config`  (lines 126–143)

```
async fn skill_roots_for_config(
        &self,
        input: &SkillsLoadInput,
        fs: Option<Arc<dyn ExecutorFileSystem>>,
    ) -> Vec<SkillRoot>
```

**Purpose**: Builds the list of directories that should be searched for skills for a specific configuration. It also removes bundled system roots if the input says bundled skills are disabled.

**Data flow**: It reads the input’s current directory, configuration stack, plugin roots, and the manager’s extra roots. It passes those into `skill_roots`, which returns candidate skill roots. If bundled skills are disabled in the input, it removes roots marked as system scope. The filtered list is returned.

**Call relations**: `SkillsManager::skills_for_config` calls this before loading skills. This method calls `SkillsManager::extra_roots` to include runtime-added directories and delegates the root-discovery work to `skill_roots`.

*Call graph*: calls 2 internal fn (skill_roots, extra_roots); called by 1 (skills_for_config).


##### `SkillsManager::skills_for_cwd`  (lines 145–180)

```
async fn skills_for_cwd(
        &self,
        input: &SkillsLoadInput,
        force_reload: bool,
        fs: Option<Arc<dyn ExecutorFileSystem>>,
    ) -> SkillLoadOutcome
```

**Purpose**: Loads skills for a current working directory, with an optional directory-based cache. This supports the older flow where the directory is the main identity for cached skill results.

**Data flow**: It receives load input, a force-reload flag, and optional file-system access. If file-system access is present, caching by current directory is allowed; if there is a cached result and reload was not forced, that result is returned. Otherwise it finds skill roots, removes bundled system roots if the effective configuration disables them, reads skill configuration rules, builds the final skill outcome, and stores it in the directory cache when that cache is being used.

**Call relations**: This method calls `SkillsManager::cached_outcome_for_cwd` to reuse old results, `skill_roots` to find possible skill locations, `SkillsManager::extra_roots` for runtime roots, `bundled_skills_enabled_from_stack` to honor configuration, `skill_config_rules_from_stack` for disable rules, and `SkillsManager::build_skill_outcome` for the actual loading and final shaping.

*Call graph*: calls 6 internal fn (skill_config_rules_from_stack, skill_roots, build_skill_outcome, cached_outcome_for_cwd, extra_roots, bundled_skills_enabled_from_stack).


##### `SkillsManager::build_skill_outcome`  (lines 183–194)

```
async fn build_skill_outcome(
        &self,
        roots: Vec<SkillRoot>,
        skill_config_rules: &SkillConfigRules,
    ) -> SkillLoadOutcome
```

**Purpose**: Turns a list of skill roots into the final loaded skill result. It is where raw loaded skills are filtered, disabled paths are applied, and lookup tables are prepared.

**Data flow**: It receives the skill roots and skill configuration rules. It loads skills from those roots, filters the loaded result for the manager’s product restriction, resolves which skill paths should be disabled, and then finalizes the result with those disabled paths. The completed `SkillLoadOutcome` is returned.

**Call relations**: Both `SkillsManager::skills_for_config` and `SkillsManager::skills_for_cwd` use this when they need a fresh result. It delegates loading to `load_skills_from_roots`, product filtering to `filter_skill_load_outcome_for_product`, disabled-path calculation to `resolve_disabled_skill_paths`, and finishing work to `finalize_skill_outcome`.

*Call graph*: calls 3 internal fn (resolve_disabled_skill_paths, load_skills_from_roots, finalize_skill_outcome); called by 2 (skills_for_config, skills_for_cwd); 1 external calls (filter_skill_load_outcome_for_product).


##### `SkillsManager::clear_cache`  (lines 196–217)

```
fn clear_cache(&self)
```

**Purpose**: Empties all stored skill-loading results. This prevents the manager from returning old skill lists after something important, such as extra roots, has changed.

**Data flow**: It takes write locks on both caches, counts how many entries each contains, clears them, adds the counts together, and logs how many cached entries were removed. It does not return a value.

**Call relations**: `SkillsManager::set_extra_roots` calls this after replacing the extra roots. The log message helps operators or developers understand when cached skill data was discarded.

*Call graph*: called by 1 (set_extra_roots); 1 external calls (info!).


##### `SkillsManager::cached_outcome_for_cwd`  (lines 219–224)

```
fn cached_outcome_for_cwd(&self, cwd: &AbsolutePathBuf) -> Option<SkillLoadOutcome>
```

**Purpose**: Looks up a previously loaded skill result for a current working directory. It is a small helper that keeps cache reading in one place.

**Data flow**: It receives an absolute current-directory path. It takes a read lock on the directory cache, recovers even if the lock was previously poisoned by a panic, clones the cached outcome if present, and returns either that cloned outcome or nothing.

**Call relations**: `SkillsManager::skills_for_cwd` calls this before doing fresh loading. If it returns a result, the larger loading flow can stop early and avoid scanning skill roots again.

*Call graph*: called by 1 (skills_for_cwd).


##### `SkillsManager::cached_outcome_for_config`  (lines 226–234)

```
fn cached_outcome_for_config(
        &self,
        cache_key: &ConfigSkillsCacheKey,
    ) -> Option<SkillLoadOutcome>
```

**Purpose**: Looks up a previously loaded skill result for a specific effective skill configuration. This avoids mixing results between sessions whose settings differ.

**Data flow**: It receives a configuration cache key. It reads the configuration cache, recovers if the lock was poisoned, clones the cached outcome if one exists for that key, and returns it. If no entry exists, it returns nothing.

**Call relations**: `SkillsManager::skills_for_config` calls this after building a cache key from roots and skill rules. A successful lookup lets that method return immediately without reloading skills.

*Call graph*: called by 1 (skills_for_config).


##### `SkillsManager::extra_roots`  (lines 236–241)

```
fn extra_roots(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns a snapshot of the manager’s runtime-added skill directories. This gives loading code a safe copy without exposing the internal shared list.

**Data flow**: It takes a read lock on the stored extra roots, clones the list, and returns the clone. If the lock was poisoned, it still recovers the stored list and clones it.

**Call relations**: `SkillsManager::skill_roots_for_config` and `SkillsManager::skills_for_cwd` call this when assembling all places to search for skills. It supplies the extra roots that may have been set by `SkillsManager::set_extra_roots`.

*Call graph*: called by 2 (skill_roots_for_config, skills_for_cwd).


##### `bundled_skills_enabled_from_stack`  (lines 250–270)

```
fn bundled_skills_enabled_from_stack(
    config_layer_stack: &codex_config::ConfigLayerStack,
) -> bool
```

**Purpose**: Reads the effective configuration and answers whether bundled system skills are enabled. If the setting is missing or invalid, it chooses the safe default of treating bundled skills as enabled.

**Data flow**: It receives a configuration layer stack and asks for the effective merged configuration. It looks for a `skills` table and tries to convert it into `SkillsConfig`. If no `skills` section exists, it returns true. If conversion fails, it logs a warning and returns true. Otherwise it returns the configured bundled-skills enabled value.

**Call relations**: `SkillsManager::skills_for_cwd` calls this before deciding whether to remove system-scope roots. Other code can also call it when it needs the same answer from the configuration stack.

*Call graph*: calls 1 internal fn (effective_config); called by 2 (skills_for_cwd, bundled_skills_enabled); 1 external calls (warn!).


##### `config_skills_cache_key`  (lines 272–291)

```
fn config_skills_cache_key(
    roots: &[SkillRoot],
    skill_config_rules: &SkillConfigRules,
) -> ConfigSkillsCacheKey
```

**Purpose**: Builds the key used to cache skill results by effective configuration. The key captures the skill roots and the rules that enable or disable skills.

**Data flow**: It receives a slice of skill roots and the skill configuration rules. For each root, it records the root path, a numeric rank for its scope, and any plugin ID. It also clones the rules. These pieces are returned as a `ConfigSkillsCacheKey`.

**Call relations**: `SkillsManager::skills_for_config` calls this after root discovery and rule extraction. The resulting key is then passed to `SkillsManager::cached_outcome_for_config` and used for storing newly built outcomes.

*Call graph*: called by 1 (skills_for_config); 2 external calls (clone, iter).


##### `finalize_skill_outcome`  (lines 293–303)

```
fn finalize_skill_outcome(
    mut outcome: SkillLoadOutcome,
    disabled_paths: HashSet<AbsolutePathBuf>,
) -> SkillLoadOutcome
```

**Purpose**: Adds the last pieces to a loaded skill result before it is returned to callers. In particular, it records disabled paths and builds indexes used for automatic skill selection.

**Data flow**: It receives a `SkillLoadOutcome` and a set of disabled absolute paths. It writes those disabled paths into the outcome. Then it asks the outcome which skills are still allowed for implicit invocation, meaning automatic use without a direct explicit request. From those skills it builds two lookup maps, one by scripts directory and one by documentation path, stores them in shared `Arc` pointers, and returns the updated outcome.

**Call relations**: `SkillsManager::build_skill_outcome` calls this after loading, product filtering, and disabled-path resolution. It calls `build_implicit_skill_path_indexes` so later parts of the system can quickly find skills related to a script directory or document path.

*Call graph*: calls 1 internal fn (allowed_skills_for_implicit_invocation); called by 1 (build_skill_outcome); 2 external calls (new, build_implicit_skill_path_indexes).


### Plugin marketplaces and MCP catalogs
These files resolve marketplace roots, describe plugin loading outcomes, normalize plugin MCP declarations, and build the final runtime MCP server catalog.

### `core-plugins/src/installed_marketplaces.rs`

`domain_logic` · `config load and marketplace discovery`

A marketplace is a source of plug-ins, and the program needs a safe, predictable way to find the marketplaces a user has installed or configured. This file is the small map-reader for that job. It knows the default folder under the Codex home directory where installed marketplaces live, and it knows how to read the user's configuration to find marketplace roots.

The main flow starts with the active user configuration. If there is no user config, no marketplace table, or the table is shaped wrong, the file returns no marketplace roots and, where useful, writes a warning. For each configured marketplace, it checks that the entry is a table, checks that the marketplace name is a safe plug-in-style path segment, decides which folder should be used, and only keeps it if a marketplace manifest can be found there. A manifest is like the label on a box: without it, the program cannot confidently say the folder is really a marketplace.

The file also supports local marketplace sources. If a marketplace says its source type is local, the configured source path is used directly. Otherwise, the marketplace is assumed to live under the default installed-marketplaces directory. Returned paths are converted to absolute paths and sorted so callers get stable, repeatable results.

#### Function details

##### `marketplace_install_root`  (lines 13–15)

```
fn marketplace_install_root(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the standard folder path where installed marketplaces are stored under the Codex home directory. Callers use it whenever they need to write, remove, inspect, or compare installed marketplace files in the default location.

**Data flow**: It receives the Codex home path as input. It appends the fixed relative folder name `.tmp/marketplaces` to that path. It returns the resulting path and does not change the filesystem.

**Call relations**: This is the shared path rule used across marketplace operations. Install, remove, add-local-source, snapshot-checking, and discovery code call on it so they all agree about where default marketplace installations belong. `installed_marketplace_roots_from_layer_stack` also uses it before resolving individual configured marketplaces.

*Call graph*: called by 18 (marketplace_remove_deletes_config_and_installed_root, write_installed_marketplace, configured_marketplace_sources_by_root, configured_marketplace_snapshot_issues, marketplace_add_local_directory_source, marketplace_remove_json_prints_remove_outcome, write_installed_marketplace, installed_marketplace_roots_from_layer_stack, list_marketplaces_ignores_installed_roots_missing_from_config, list_marketplaces_includes_installed_marketplace_roots (+8 more)); 1 external calls (join).


##### `installed_marketplace_roots_from_layer_stack`  (lines 17–61)

```
fn installed_marketplace_roots_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    codex_home: &Path,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Reads the effective user configuration and returns the marketplace folders that are both configured and valid enough to use. It protects the rest of the system from bad configuration by quietly skipping unusable entries and warning about obvious mistakes.

**Data flow**: It takes the layered configuration and the Codex home path. First it asks for the effective user config, then looks for a `marketplaces` table. If anything important is missing or wrongly shaped, it returns an empty list or skips the bad entry. For each marketplace entry, it validates the name, resolves the folder path, checks that a marketplace manifest exists there, converts the path to an absolute path, sorts the final list, and returns it.

**Call relations**: Marketplace discovery code calls this when it needs the current set of marketplace roots. Inside that process, it uses `marketplace_install_root` to get the default installation base, then relies on the configured marketplace root logic and manifest checking before handing back clean, stable paths to the caller.

*Call graph*: calls 2 internal fn (effective_user_config, marketplace_install_root); called by 1 (marketplace_roots); 2 external calls (new, warn!).


##### `resolve_configured_marketplace_root`  (lines 63–76)

```
fn resolve_configured_marketplace_root(
    marketplace_name: &str,
    marketplace: &toml::Value,
    default_install_root: &Path,
) -> Option<PathBuf>
```

**Purpose**: Chooses the folder path for one configured marketplace. It supports two cases: a local marketplace whose path is written directly in the config, or a normal installed marketplace stored under the default install root.

**Data flow**: It receives the marketplace name, that marketplace's configuration value, and the default install root. If the configuration says `source_type` is `local`, it looks for a non-empty `source` string and returns that as a path. For all other source types, including missing source type, it returns the default install root joined with the marketplace name. If a local source is requested but no usable source path is present, it returns nothing.

**Call relations**: Other marketplace features call this when they need to connect a configured marketplace name to its actual folder on disk, such as checking snapshot issues, finding a marketplace by name, or deciding the installed root for a source. It is the small decision point that keeps local marketplace paths and default installed paths following the same rule everywhere.

*Call graph*: called by 3 (configured_marketplace_snapshot_issues, find_marketplace_root_by_name, installed_marketplace_root_for_source); 2 external calls (join, get).


### `cli/src/marketplace_cmd.rs`

`orchestration` · `command handling`

A plugin marketplace is a place where Codex can find plugins. This file is the command-line front desk for those marketplaces. Without it, users would not have a simple terminal command for telling Codex where plugin marketplaces live, checking which ones are active, updating Git-based copies, or removing old entries.

The file defines the shape of the command using `clap`, a command-line parsing library. It accepts subcommands such as `add`, `list`, `upgrade`, and `remove`, plus flags like `--json`. The main `MarketplaceCli::run` function reads any configuration overrides, then sends the request to the right helper.

Most real marketplace work is delegated to the plugin core library. For example, adding and removing call dedicated marketplace functions, while listing and upgrading use `PluginsManager`. This file focuses on turning terminal input into those library calls, then turning the results back into useful output.

It also has small JSON output structs. These are like neatly labeled receipts: they convert internal results into stable field names that other programs can read. The file is careful to report loading or upgrade problems clearly, and it refuses to claim success if any requested marketplace upgrade failed.

#### Function details

##### `MarketplaceCli::run`  (lines 124–142)

```
async fn run(self) -> Result<()>
```

**Purpose**: This is the dispatcher for the marketplace command. It reads the chosen subcommand and sends the work to the matching helper for add, list, upgrade, or remove.

**Data flow**: It receives the parsed command-line object, including configuration override text and the selected marketplace action. It turns the override text into structured override values, then calls the proper action function. It returns success if that action succeeds, or passes back the error if anything fails.

**Call relations**: This function is the local entry point for this command group. When the wider CLI has parsed `codex plugin marketplace ...`, it calls `MarketplaceCli::run`; this function then hands off to `run_add`, `run_list`, `run_upgrade`, or `run_remove` depending on what the user asked for.

*Call graph*: calls 4 internal fn (run_add, run_list, run_remove, run_upgrade).


##### `run_add`  (lines 145–187)

```
async fn run_add(args: AddMarketplaceArgs) -> Result<()>
```

**Purpose**: This adds a new marketplace source to Codex. The source can be a local folder or a Git repository, and the function reports where the marketplace was installed.

**Data flow**: It takes the user's source, optional Git reference, optional sparse checkout paths, and JSON preference. It finds the Codex home directory, sends an add request to the plugin library, then prints either a plain message or a JSON receipt. The result is a configured marketplace, or an error explaining why it could not be added.

**Call relations**: It is called by `MarketplaceCli::run` when the user chooses `add`. It relies on `find_codex_home` to locate Codex's storage area, calls `add_marketplace` to do the actual add work, and uses `JsonMarketplaceAddOutput::from_outcome` when the user requested machine-readable output.

*Call graph*: calls 3 internal fn (from_outcome, add_marketplace, find_codex_home); called by 1 (run); 1 external calls (println!).


##### `JsonMarketplaceAddOutput::from_outcome`  (lines 198–204)

```
fn from_outcome(outcome: MarketplaceAddOutcome) -> Self
```

**Purpose**: This turns the internal result of adding a marketplace into a simple JSON-friendly shape. It keeps only the fields that should be shown to users or scripts.

**Data flow**: It receives a `MarketplaceAddOutcome`, which includes the marketplace name, installed folder, and whether it was already present. It converts the folder path into display text and builds a `JsonMarketplaceAddOutput` value. Nothing else is changed.

**Call relations**: It is used by `run_add` only when `--json` was requested. It acts as a small translation step between the plugin library's internal result and the command-line JSON output.

*Call graph*: called by 1 (run_add).


##### `run_list`  (lines 207–295)

```
async fn run_list(overrides: Vec<(String, toml::Value)>, args: ListMarketplaceArgs) -> Result<()>
```

**Purpose**: This lists the plugin marketplaces Codex is currently considering. It can print a readable table for people or JSON for tools.

**Data flow**: It receives configuration overrides and the user's JSON preference. It loads the Codex configuration, creates a plugin manager, applies the CLI authentication mode, asks the manager to discover marketplaces, checks for marketplace loading problems, and then prints the results. If any marketplace snapshot cannot be loaded, it stops with a clear grouped error instead of showing a misleading partial list.

**Call relations**: It is called by `MarketplaceCli::run` for the `list` subcommand. It calls configuration and plugin-manager code to find marketplaces, asks helper functions from `plugin_cmd` to explain snapshot issues, uses `configured_marketplace_sources_by_root` to enrich JSON output with source information, and uses `JsonMarketplaceListOutput::from_marketplaces` to prepare JSON.

*Call graph*: calls 6 internal fn (from_marketplaces, configured_marketplace_sources_by_root, configured_marketplace_snapshot_issues, load_cli_auth_mode, new, marketplace_root_dir); called by 1 (run); 5 external calls (new, new, load_with_cli_overrides, bail!, println!).


##### `JsonMarketplaceListOutput::from_marketplaces`  (lines 304–325)

```
fn from_marketplaces(
        marketplaces: Vec<codex_core_plugins::marketplace::Marketplace>,
        marketplace_sources: &HashMap<PathBuf, JsonMarketplaceSource>,
    ) -> Self
```

**Purpose**: This prepares the marketplace list for JSON output. It removes duplicate roots so the same marketplace folder is not reported more than once.

**Data flow**: It receives discovered marketplace records and a lookup table that maps marketplace root folders to their configured source information. For each marketplace, it works out the root folder, skips duplicates, attaches source details when available, and returns a JSON output object containing the cleaned list.

**Call relations**: It is called by `run_list` when the user passes `--json`. It depends on marketplace root calculation and the source map built by `configured_marketplace_sources_by_root`, then hands the finished structure back to `run_list` for printing.

*Call graph*: called by 1 (run_list); 1 external calls (new).


##### `configured_marketplace_sources_by_root`  (lines 337–365)

```
fn configured_marketplace_sources_by_root(
    codex_home: &Path,
    plugins_input: &PluginsConfigInput,
) -> HashMap<PathBuf, JsonMarketplaceSource>
```

**Purpose**: This builds a lookup table from installed marketplace folders to the source settings that created them. It helps JSON listing explain not just where a marketplace is, but where it came from.

**Data flow**: It receives the Codex home path and the plugin configuration input. It reads the effective user configuration, finds the configured `marketplaces` table, works out each marketplace's install root, and pairs that root with source details such as local or Git origin. If the needed user configuration is missing, it returns an empty table.

**Call relations**: It is called by `run_list` for JSON output. It uses `configured_marketplace_sources` to read source descriptions, `marketplace_install_root` to know the default install area, and `resolve_configured_marketplace_root` to match each configured marketplace to its actual folder.

*Call graph*: calls 2 internal fn (configured_marketplace_sources, marketplace_install_root); called by 1 (run_list); 1 external calls (new).


##### `run_upgrade`  (lines 367–389)

```
async fn run_upgrade(
    overrides: Vec<(String, toml::Value)>,
    args: UpgradeMarketplaceArgs,
) -> Result<()>
```

**Purpose**: This refreshes configured Git-backed marketplaces. The user can refresh one named marketplace or all configured Git marketplaces.

**Data flow**: It receives configuration overrides plus an optional marketplace name and JSON preference. It loads configuration, finds the Codex home directory, creates a plugin manager, asks it to upgrade the selected configured marketplaces, and then sends the result to either the plain-text or JSON printer.

**Call relations**: It is called by `MarketplaceCli::run` for the `upgrade` subcommand. It delegates the actual refresh work to `PluginsManager`, then calls `print_upgrade_outcome` or `print_upgrade_outcome_json` to report the result in the requested format.

*Call graph*: calls 4 internal fn (print_upgrade_outcome, print_upgrade_outcome_json, new, find_codex_home); called by 1 (run); 1 external calls (load_with_cli_overrides).


##### `run_remove`  (lines 391–418)

```
async fn run_remove(args: RemoveMarketplaceArgs) -> Result<()>
```

**Purpose**: This removes a marketplace from the user's configured marketplace sources. If Codex also removes an installed copy, it tells the user which folder was removed.

**Data flow**: It takes the marketplace name and JSON preference from the command line. It finds the Codex home directory, sends a remove request to the plugin library, then prints either plain text or JSON. The configuration is changed by the lower-level remove operation, and the function reports the final outcome.

**Call relations**: It is called by `MarketplaceCli::run` when the user chooses `remove`. It uses `remove_marketplace` for the real removal work and `JsonMarketplaceRemoveOutput::from_outcome` when the user requested JSON.

*Call graph*: calls 3 internal fn (from_outcome, remove_marketplace, find_codex_home); called by 1 (run); 1 external calls (println!).


##### `JsonMarketplaceRemoveOutput::from_outcome`  (lines 428–435)

```
fn from_outcome(outcome: MarketplaceRemoveOutcome) -> Self
```

**Purpose**: This turns the internal result of removing a marketplace into a JSON-friendly response. It records the marketplace name and, when relevant, the installed folder that was removed.

**Data flow**: It receives a `MarketplaceRemoveOutcome`. It copies the marketplace name, converts the optional removed folder path into display text, and returns a small serializable output object.

**Call relations**: It is called by `run_remove` only for `--json` output. It is the final translation step before `run_remove` prints the removal result.

*Call graph*: called by 1 (run_remove).


##### `print_upgrade_outcome_json`  (lines 438–452)

```
fn print_upgrade_outcome_json(outcome: &PluginMarketplaceUpgradeOutcome) -> Result<()>
```

**Purpose**: This prints the result of a marketplace upgrade as JSON, but only after making sure every requested upgrade succeeded. It still writes individual failure messages to standard error so people can see what went wrong.

**Data flow**: It receives the upgrade outcome. It prints each recorded error to standard error, checks whether all upgrades succeeded, and stops with an error if any failed. If everything succeeded, it converts the outcome into a JSON output object and prints it.

**Call relations**: It is called by `run_upgrade` when the user passes `--json`. It uses `JsonMarketplaceUpgradeOutput::from_outcome` to build the JSON response and uses the outcome's success check to decide whether to return success or fail the command.

*Call graph*: calls 1 internal fn (from_outcome); called by 1 (run_upgrade); 4 external calls (all_succeeded, bail!, eprintln!, println!).


##### `JsonMarketplaceUpgradeOutput::from_outcome`  (lines 463–480)

```
fn from_outcome(outcome: &PluginMarketplaceUpgradeOutcome) -> Self
```

**Purpose**: This converts the internal upgrade result into a JSON response for scripts and other tools. It includes what was selected, which roots were updated, and any errors recorded in the outcome.

**Data flow**: It receives a borrowed upgrade outcome. It copies the selected marketplace names, converts updated root paths into strings, converts each error into a simple name-and-message object, and returns the JSON-ready structure.

**Call relations**: It is called by `print_upgrade_outcome_json` after that function has checked for failures. It provides the clean data shape that `serde_json` can print.

*Call graph*: called by 1 (print_upgrade_outcome_json).


##### `print_upgrade_outcome`  (lines 490–526)

```
fn print_upgrade_outcome(
    outcome: &PluginMarketplaceUpgradeOutcome,
    marketplace_name: Option<&str>,
) -> Result<()>
```

**Purpose**: This prints a human-readable summary of a marketplace upgrade. It chooses wording that matches the situation, such as nothing to upgrade, already up to date, one marketplace upgraded, or several upgraded.

**Data flow**: It receives the upgrade outcome and the optional marketplace name the user selected. It prints any individual errors to standard error, fails the command if any upgrade failed, then prints a success or no-op message and any installed roots that changed.

**Call relations**: It is called by `run_upgrade` when JSON output was not requested. It is the plain-language counterpart to `print_upgrade_outcome_json`, using the same upgrade outcome but formatting it for a person reading the terminal.

*Call graph*: called by 1 (run_upgrade); 4 external calls (all_succeeded, bail!, eprintln!, println!).


##### `tests::sparse_paths_parse_before_or_after_source`  (lines 534–561)

```
fn sparse_paths_parse_before_or_after_source()
```

**Purpose**: This test checks that the `--sparse` option for adding a marketplace works whether it appears before or after the source. It also checks that repeated `--sparse` flags are collected in order.

**Data flow**: It feeds example command-line argument lists into the parser. It then compares the parsed source and sparse path list against the expected values. The output is only a passing or failing test result.

**Call relations**: This test exercises the command-line parser for `AddMarketplaceArgs`. It does not call the add operation itself; it protects the user-facing command syntax so later changes do not accidentally break accepted argument order.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::upgrade_subcommand_parses_optional_marketplace_name`  (lines 564–570)

```
fn upgrade_subcommand_parses_optional_marketplace_name()
```

**Purpose**: This test checks that the upgrade command accepts either no marketplace name or one marketplace name. That matters because `upgrade` means all Git marketplaces, while `upgrade debug` means just `debug`.

**Data flow**: It parses one argument list with only `upgrade` and another with `upgrade debug`. It then checks that the first has no selected name and the second stores `debug` as the selected marketplace. The result is a test pass or failure.

**Call relations**: This test exercises `UpgradeMarketplaceArgs` parsing. It supports the behavior later used by `run_upgrade`, which relies on the optional name to decide whether to refresh all configured Git marketplaces or just one.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::remove_subcommand_parses_marketplace_name`  (lines 573–576)

```
fn remove_subcommand_parses_marketplace_name()
```

**Purpose**: This test checks that the remove command correctly reads the required marketplace name. Removing without the right name would affect the wrong user expectation or fail confusingly.

**Data flow**: It parses an example `remove debug` argument list. It then checks that the parsed marketplace name is exactly `debug`. The only output is whether the test passes.

**Call relations**: This test exercises `RemoveMarketplaceArgs` parsing. It protects the input shape that `run_remove` depends on before it sends the name to the actual marketplace removal code.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


### `plugin/src/provider.rs`

`data_model` · `plugin discovery and resolution`

Plugins can come from different “authorities,” such as a particular environment with its own filesystem. This file makes sure the system remembers that authority alongside every plugin path. That matters because a path by itself is not enough: `/plugin/config.json` only makes sense if you also know which environment owns that filesystem.

The main type is `ResolvedPlugin`, an inert plugin descriptor. “Inert” means it describes the plugin package and its manifest, but does not start or execute the plugin. It stores the selected root ID, where the plugin package lives, where its manifest file came from, and the parsed manifest itself.

A key safety rule appears here: every resource mentioned by the manifest must stay inside the plugin package root. This is like checking that all files listed in a shipping box inventory are actually inside that box, not somewhere else in the warehouse. If a resource points outside the root, construction fails with `ResolvedPluginError::ResourceOutsideRoot`.

The `PluginProvider` trait is the extension point. A provider is something that can inspect a selected capability root, using that root’s proper filesystem authority, and return either no plugin or a safely resolved `ResolvedPlugin`.

#### Function details

##### `ResolvedPlugin::from_environment`  (lines 51–70)

```
fn from_environment(
        selected_root_id: String,
        environment_id: String,
        root: AbsolutePathBuf,
        manifest_path: AbsolutePathBuf,
        manifest: PluginManifest<AbsoluteP
```

**Purpose**: Builds a `ResolvedPlugin` for a plugin package that belongs to a specific environment. It checks that the manifest file and every resource path inside the manifest are actually under the package root before accepting them.

**Data flow**: It receives a selected root ID, an environment ID, the package root path, the manifest file path, and a parsed manifest whose resource fields are plain absolute paths. It converts the manifest path and each manifest resource into an environment-bound resource locator, rejecting any path outside the package root. If all checks pass, it returns a complete `ResolvedPlugin`; if not, it returns a construction error.

**Call relations**: This is the main constructor used when plugin roots are resolved, including by `resolve_plugin_root` and test helpers such as `resolved_plugin`. It calls `environment_resource` for the manifest path and uses the manifest’s `try_map_resources` step to apply the same conversion to every resource named in the manifest.

*Call graph*: calls 2 internal fn (try_map_resources, environment_resource); called by 5 (host_and_executor_sources_parse_the_same_manifest, resolve_plugin_root, resolved_plugin, environment_descriptor_binds_every_manifest_resource, environment_descriptor_rejects_resources_outside_package_root).


##### `ResolvedPlugin::selected_root_id`  (lines 73–75)

```
fn selected_root_id(&self) -> &str
```

**Purpose**: Returns the opaque ID for the capability root that was selected for this plugin. Callers use it to connect the resolved plugin back to the root choice that produced it.

**Data flow**: It reads the stored `selected_root_id` string from the `ResolvedPlugin` and returns it as borrowed text. It does not change the plugin descriptor.

**Call relations**: This is used by `load_from_file_system` when that later loading step needs to know which selected root the resolved plugin came from.

*Call graph*: called by 1 (load_from_file_system).


##### `ResolvedPlugin::location`  (lines 78–80)

```
fn location(&self) -> &ResolvedPluginLocation
```

**Purpose**: Returns the authority-bound package location for the plugin. This tells callers both where the plugin root is and which environment owns that path.

**Data flow**: It reads the stored `location` field and returns a borrowed reference to it. Nothing is copied or modified.

**Call relations**: This is used by `load_from_file_system` so that loading code can access the plugin package through the correct environment and root path.

*Call graph*: called by 1 (load_from_file_system).


##### `ResolvedPlugin::manifest_path`  (lines 83–85)

```
fn manifest_path(&self) -> &PluginResourceLocator
```

**Purpose**: Returns the exact resource locator for the manifest file that was used to resolve the plugin. This is useful when code needs to know where the plugin description originally came from.

**Data flow**: It reads the stored `manifest_path` field and returns a borrowed reference. The descriptor stays unchanged.

**Call relations**: This accessor is available for later code that needs the manifest’s authority-aware location, matching the same resource-location model used throughout this file.


##### `ResolvedPlugin::manifest`  (lines 88–90)

```
fn manifest(&self) -> &PluginManifest<PluginResourceLocator>
```

**Purpose**: Returns the parsed plugin manifest, with all of its resource paths already tied to their owning environment. Callers use this to read the plugin’s declared metadata and files safely.

**Data flow**: It reads the stored manifest and returns a borrowed reference to it. The manifest has already had its plain paths converted into `PluginResourceLocator` values during construction.

**Call relations**: This is used by `load_from_file_system` after resolution, when the system needs the plugin metadata and resource list without losing track of which environment owns those resources.

*Call graph*: called by 1 (load_from_file_system).


##### `environment_resource`  (lines 93–108)

```
fn environment_resource(
    environment_id: &str,
    root: &AbsolutePathBuf,
    path: AbsolutePathBuf,
) -> Result<PluginResourceLocator, ResolvedPluginError>
```

**Purpose**: Turns an absolute path into an environment-owned plugin resource, but only if that path stays inside the plugin package root. This is the small safety gate that prevents a plugin manifest from pointing at files outside its package.

**Data flow**: It receives an environment ID, the package root, and a resource path. It compares the resource path with the root path; if the resource does not start inside the root, it returns `ResourceOutsideRoot`. If the path is valid, it returns a `PluginResourceLocator::Environment` containing the environment ID and the path.

**Call relations**: This helper is called by `ResolvedPlugin::from_environment` first for the manifest path and then, through manifest resource mapping, for each resource path declared by the manifest. It supplies the validation and wrapping step that makes the finished descriptor authority-aware.

*Call graph*: calls 1 internal fn (as_path); called by 1 (from_environment); 1 external calls (clone).


### `plugin/src/load_outcome.rs`

`domain_logic` · `after plugin load, before runtime feature use`

After plugins are read from disk, the system needs one clean view of what is actually usable. This file provides that view. A loaded plugin may exist on disk but still be disabled, broken, or empty. The code here separates “found” from “effective”: only enabled plugins with no load error are treated as active.

The main data type, LoadedPlugin, is a record of one plugin: its configured name, optional manifest name and description, root folder, skill folders, MCP server definitions, app declarations, hook files, warnings, and any load error. Think of it like a shipping label plus contents checklist for one package.

PluginLoadOutcome is the combined result for all plugins. It keeps the full plugin list, but also precomputes short capability summaries for active plugins that have something useful to offer. These summaries are safe to show to the model: descriptions are cleaned up, whitespace is normalized, and very long text is cut down.

The file also answers practical questions for later parts of the program: “Which skill folders should be searched?”, “Which MCP servers are available?”, “Which apps can plugins connect to?”, and “Which hooks should run?” Duplicate skill paths are removed, and duplicate MCP server names keep the first active plugin’s version. Without this file, later code would have to repeatedly re-check plugin status and might accidentally use disabled or failed plugins.

#### Function details

##### `LoadedPlugin::is_active`  (lines 34–36)

```
fn is_active(&self) -> bool
```

**Purpose**: Checks whether a plugin should count as usable. A plugin is active only when it is enabled and did not record a load error.

**Data flow**: It reads the plugin’s enabled flag and error field. If enabled is true and error is empty, it returns true; otherwise it returns false. It does not change the plugin.

**Call relations**: When building a capability summary, plugin_capability_summary_from_loaded asks this first. If the answer is no, the plugin is ignored for model-facing capabilities.

*Call graph*: called by 1 (plugin_capability_summary_from_loaded).


##### `LoadedPlugin::display_name`  (lines 38–40)

```
fn display_name(&self) -> &str
```

**Purpose**: Chooses the human-friendly name to show for a plugin. It prefers the name from the plugin manifest, and falls back to the configured name if the manifest did not provide one.

**Data flow**: It reads manifest_name and config_name. If manifest_name exists, it returns that text; otherwise it returns config_name. Nothing is copied or changed.

**Call relations**: plugin_capability_summary_from_loaded uses this when creating the name that appears in a plugin capability summary.

*Call graph*: called by 1 (plugin_capability_summary_from_loaded).


##### `plugin_capability_summary_from_loaded`  (lines 43–66)

```
fn plugin_capability_summary_from_loaded(
    plugin: &LoadedPlugin<M>,
) -> Option<PluginCapabilitySummary>
```

**Purpose**: Builds a short, safe summary of what one loaded plugin can do, but only if the plugin is active and has at least one visible capability. This is the bridge from a detailed loaded plugin record to the compact information shown to the model or other capability readers.

**Data flow**: It receives one LoadedPlugin. It first checks whether the plugin is active. If not, it returns nothing. For an active plugin, it sorts MCP server names, cleans the manifest description, collects app connector IDs from app declarations, and records whether the plugin has enabled skills. If the plugin has no skills, no MCP servers, and no app connectors, it returns nothing; otherwise it returns a PluginCapabilitySummary.

**Call relations**: PluginLoadOutcome::from_plugins uses this while constructing the overall result. Inside, it relies on LoadedPlugin::is_active, LoadedPlugin::display_name, prompt_safe_plugin_description, and app_connector_ids_from_declarations to turn detailed plugin data into a concise summary.

*Call graph*: calls 3 internal fn (display_name, is_active, prompt_safe_plugin_description); 1 external calls (app_connector_ids_from_declarations).


##### `prompt_safe_plugin_description`  (lines 69–84)

```
fn prompt_safe_plugin_description(description: Option<&str>) -> Option<String>
```

**Purpose**: Cleans a plugin description so it is safe and tidy to include in a model-facing capability summary. It removes odd spacing and limits the text length.

**Data flow**: It receives an optional description. If there is no description, or if the cleaned description is empty, it returns nothing. Otherwise it collapses all whitespace into single spaces, cuts the result to the maximum allowed length, and returns the cleaned string.

**Call relations**: plugin_capability_summary_from_loaded calls this before putting a plugin’s manifest description into a capability summary. This keeps plugin-provided text from being overly long or messy.

*Call graph*: called by 1 (plugin_capability_summary_from_loaded).


##### `PluginLoadOutcome::default`  (lines 96–98)

```
fn default() -> Self
```

**Purpose**: Creates an empty plugin load result. This is useful when there are no plugins or when plugin loading is skipped or not yet available.

**Data flow**: It starts with no input besides the type being created. It builds an empty plugin list and passes it through the normal construction path, producing a PluginLoadOutcome with no plugins and no capability summaries.

**Call relations**: Higher-level plugin loading paths such as plugins_for_config_with_force_reload and plugins_for_layer_stack call this when they need a harmless empty outcome. It delegates to from_plugins so even the empty case is built the same way as the normal case.

*Call graph*: called by 2 (plugins_for_config_with_force_reload, plugins_for_layer_stack); 2 external calls (from_plugins, new).


##### `PluginLoadOutcome::from_plugins`  (lines 102–111)

```
fn from_plugins(plugins: Vec<LoadedPlugin<M>>) -> Self
```

**Purpose**: Creates the final load outcome from a list of loaded plugins. It keeps the full list and derives the compact capability summaries at the same time.

**Data flow**: It receives a vector of LoadedPlugin records. It walks through them, tries to build a capability summary for each active and useful plugin, collects those summaries, and returns a PluginLoadOutcome containing both the original plugin records and the derived summaries.

**Call relations**: This is the main constructor used after plugin resolution, including by resolve_loaded_plugins_for_auth and by tests that check filtering behavior. It uses plugin_capability_summary_from_loaded to decide which plugins deserve a capability summary.

*Call graph*: called by 3 (resolve_loaded_plugins_for_auth, capability_index_filters_inactive_and_zero_capability_plugins, effective_plugin_skill_roots_preserves_first_plugin_for_shared_root).


##### `PluginLoadOutcome::effective_mcp_servers`  (lines 144–154)

```
fn effective_mcp_servers(&self) -> HashMap<String, M>
```

**Purpose**: Returns the MCP servers that should actually be available at runtime. MCP here means Model Context Protocol, a way for the system to talk to external tools or services exposed by plugins.

**Data flow**: It starts with the stored plugins. It looks only at active plugins, then copies each MCP server definition into a new map. If two active plugins use the same server name, the first one wins and later duplicates are ignored. The result is a map from server name to server configuration.

**Call relations**: Code that needs runtime MCP server names, such as sorted_effective_mcp_server_names, calls this to get the already-filtered set. This method does the active-plugin filtering so callers do not have to repeat it.

*Call graph*: called by 1 (sorted_effective_mcp_server_names); 1 external calls (new).


##### `PluginLoadOutcome::effective_apps`  (lines 156–163)

```
fn effective_apps(&self) -> Vec<AppConnectorId>
```

**Purpose**: Returns the app connector IDs from active plugins. An app connector ID is the system’s compact identifier for an app integration declared by a plugin.

**Data flow**: It reads all active plugins, gathers their app declarations, and passes them to app_connector_ids_from_declarations. The result is a list of connector IDs derived from those declarations.

**Call relations**: This method is used when later code needs to know which plugin app integrations are actually available. It hands the declaration-to-ID conversion to app_connector_ids_from_declarations, keeping this method focused on filtering to active plugins.

*Call graph*: 1 external calls (app_connector_ids_from_declarations).


##### `PluginLoadOutcome::effective_plugin_hook_sources`  (lines 165–171)

```
fn effective_plugin_hook_sources(&self) -> Vec<PluginHookSource>
```

**Purpose**: Returns the hook sources from active plugins. Hooks are plugin-provided pieces that can be run at certain points in the program’s flow.

**Data flow**: It reads the plugin list, skips inactive plugins, copies each active plugin’s hook sources, and returns them in one combined list. It does not change the stored plugins.

**Call relations**: Later hook-loading or hook-running code can call this to get only the hook sources that should count. The method centralizes the rule that disabled or failed plugins must not contribute hooks.


##### `PluginLoadOutcome::effective_plugin_hook_warnings`  (lines 173–179)

```
fn effective_plugin_hook_warnings(&self) -> Vec<String>
```

**Purpose**: Returns hook-loading warnings from active plugins. These warnings explain non-fatal hook problems while ignoring plugins that are disabled or failed.

**Data flow**: It scans active plugins, copies their hook_load_warnings strings, and returns all of them in a single list. The original warning lists remain unchanged.

**Call relations**: User-facing or logging code can call this after plugins are loaded to report hook issues that matter for active plugins. It keeps inactive plugin warnings from cluttering the runtime view.


##### `PluginLoadOutcome::capability_summaries`  (lines 181–183)

```
fn capability_summaries(&self) -> &[PluginCapabilitySummary]
```

**Purpose**: Gives read-only access to the precomputed plugin capability summaries. These summaries describe what active plugins can offer in a compact form.

**Data flow**: It reads the PluginLoadOutcome and returns a borrowed slice of its capability_summaries list. Nothing is copied or changed.

**Call relations**: Callers use this when they need the model-facing or UI-facing capability list. Because from_plugins already built the summaries, this method simply exposes them safely.


##### `PluginLoadOutcome::plugins`  (lines 185–187)

```
fn plugins(&self) -> &[LoadedPlugin<M>]
```

**Purpose**: Gives read-only access to the full loaded plugin records. This includes active plugins, inactive plugins, and plugins with load errors.

**Data flow**: It reads the PluginLoadOutcome and returns a borrowed slice of its plugins list. It does not filter, copy, or modify anything.

**Call relations**: Callers use this when they need the detailed raw plugin load results rather than only the effective runtime capabilities.


##### `PluginLoadOutcome::effective_skill_roots`  (lines 199–201)

```
fn effective_skill_roots(&self) -> Vec<AbsolutePathBuf>
```

**Purpose**: Provides the effective skill folders through the EffectiveSkillRoots trait. A skill root is a folder where plugin-provided skills can be found.

**Data flow**: It receives the outcome through the trait method and forwards the request to PluginLoadOutcome’s built-in skill-root calculation. The result is a list of active, deduplicated skill paths.

**Call relations**: This trait method lets other crates depend on the idea of “something that can provide effective skill roots” without naming the plugin outcome’s MCP configuration type. It delegates to the concrete PluginLoadOutcome implementation.


##### `PluginLoadOutcome::effective_plugin_skill_roots`  (lines 203–205)

```
fn effective_plugin_skill_roots(&self) -> Vec<PluginSkillRoot>
```

**Purpose**: Provides effective skill folders together with the plugin they came from, through the EffectiveSkillRoots trait. This is useful when code needs both the folder path and its owning plugin.

**Data flow**: It receives the outcome through the trait method and forwards to PluginLoadOutcome’s concrete plugin-skill-root calculation. The result is a sorted list of PluginSkillRoot records, with duplicate paths assigned to the first active plugin that provided them.

**Call relations**: This is the trait-facing version of the plugin skill-root lookup. It allows skills-related code to call the method without caring about the exact MCP server configuration type used inside PluginLoadOutcome.

*Call graph*: 2 external calls (new, new).


##### `tests::test_path`  (lines 212–215)

```
fn test_path(name: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an absolute temporary path for tests. It gives tests realistic absolute paths without hard-coding machine-specific directories.

**Data flow**: It takes a short name, appends it to the system temporary directory, checks that the result is an absolute path, and returns it as an AbsolutePathBuf. If the temporary directory path were unexpectedly not absolute, the test would fail.

**Call relations**: The test helper tests::loaded_plugin and the test case use this to build plugin roots and shared skill paths. It relies on temp_dir and from_absolute_path_checked to make valid test paths.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (temp_dir).


##### `tests::loaded_plugin`  (lines 217–233)

```
fn loaded_plugin(config_name: &str, skill_roots: Vec<AbsolutePathBuf>) -> LoadedPlugin<()>
```

**Purpose**: Builds a simple active plugin record for tests. It fills in only the fields needed by the skill-root test and uses empty values for everything else.

**Data flow**: It takes a config name and a list of skill roots. It creates a LoadedPlugin with that name, a temporary root path, enabled set to true, no error, skills marked as present, and empty MCP server, app, hook, warning, and disabled-skill collections. The result is a ready-to-use test plugin.

**Call relations**: The test effective_plugin_skill_roots_preserves_first_plugin_for_shared_root calls this twice to create two plugins that point at the same skill folder. It uses tests::test_path to create each plugin’s root path.

*Call graph*: 4 external calls (new, new, new, test_path).


##### `tests::effective_plugin_skill_roots_preserves_first_plugin_for_shared_root`  (lines 236–251)

```
fn effective_plugin_skill_roots_preserves_first_plugin_for_shared_root()
```

**Purpose**: Checks an important duplicate-handling rule: if two active plugins point to the same skill folder, the first plugin in load order keeps ownership of that folder. This prevents later plugins from silently taking credit for a shared path.

**Data flow**: It creates one shared skill path, builds two active test plugins that both use it, constructs a PluginLoadOutcome, and asks for effective plugin skill roots. It then compares the result with the expected single entry owned by the first plugin, zeta@test.

**Call relations**: This test exercises PluginLoadOutcome::from_plugins and the effective plugin skill-root calculation. It uses tests::test_path and tests::loaded_plugin to set up the data, then assert_eq! to confirm the first-plugin-wins behavior.

*Call graph*: calls 1 internal fn (from_plugins); 3 external calls (assert_eq!, test_path, vec!).


### `codex-mcp/src/plugin_config.rs`

`config` · `config load`

Plugins can declare MCP servers, where MCP means “Model Context Protocol,” a way for Codex to talk to external tools or services. This file is the translator between the plugin’s JSON file and the stricter configuration format Codex uses while running. Without it, plugins would either need to write configuration in exactly Codex’s internal shape, or a single mistake in one server entry could make all plugin MCP settings unusable.

The file accepts two JSON layouts: either an object with an mcpServers field, or a plain map of server names to server settings. For each server, it cleans up small differences in naming and shape. For example, it ignores a plugin-declared transport type field after checking whether it looks familiar, rewrites OAuth clientId into the internal client_id form, and warns when a plugin sets options Codex will not use.

A key idea is “placement,” meaning where the plugin’s server will run. If Codex preserves the plugin’s declared placement, relative working directories are resolved under the plugin’s folder. If an executor-owned environment is assigned, the file adds that environment id, gives stdio servers a safe default working directory, and checks environment variables so local and remote values are not mixed incorrectly. This is like checking a delivery address before sending a package: the settings may look close, but they must be made safe and unambiguous before use.

#### Function details

##### `PluginMcpFile::into_mcp_servers`  (lines 50–55)

```
fn into_mcp_servers(self) -> BTreeMap<String, JsonValue>
```

**Purpose**: This converts either supported plugin file shape into the same simple form: a map from server name to raw JSON settings. It lets the rest of the parser ignore which top-level layout the plugin used.

**Data flow**: It receives a parsed plugin MCP file, which may either wrap servers inside an mcpServers field or already be a server map. It extracts the server map from whichever shape was used. The result is one collection of named server JSON values ready for per-server normalization.

**Call relations**: This is the small adapter at the front of the parsing path. Once the plugin JSON has been decoded, the parser uses this to get a uniform list of servers before each server is normalized and either accepted or reported as invalid.


##### `parse_plugin_mcp_config`  (lines 62–82)

```
fn parse_plugin_mcp_config(
    plugin_root: &Path,
    contents: &str,
    placement: PluginMcpServerPlacement<'_>,
) -> Result<PluginMcpConfigParseOutcome, serde_json::Error>
```

**Purpose**: This is the main entry point for turning a plugin’s MCP JSON text into usable Codex server configuration. It returns both the servers that worked and clear per-server errors for the ones that did not.

**Data flow**: It takes the plugin’s root folder, the JSON text, and a placement rule. First it parses the top-level JSON document. If the whole document is malformed, it returns a JSON parse error. If the document is readable, it walks through each named server, asks the normalizer to turn that server into a runtime config, stores successful results in a map, and stores failures as named error messages.

**Call relations**: This function drives the file’s overall flow. It creates an empty outcome, then calls normalize_plugin_mcp_server for each server. That design means one bad server does not stop its valid sibling servers from being returned.

*Call graph*: calls 1 internal fn (normalize_plugin_mcp_server); 1 external calls (default).


##### `normalize_plugin_mcp_server`  (lines 84–120)

```
fn normalize_plugin_mcp_server(
    plugin_root: &Path,
    value: JsonValue,
    placement: PluginMcpServerPlacement<'_>,
) -> Result<McpServerConfig, String>
```

**Purpose**: This turns one raw plugin server entry into an McpServerConfig, the stricter configuration Codex can actually run. It also applies special rules when the server is bound to a particular execution environment.

**Data flow**: It receives the plugin folder, one server’s JSON value, and the placement rule. It first cleans the raw JSON into a better-shaped object. If the placement is an executor environment, it adds the environment id, adjusts the working directory for command-based stdio servers, and defaults the working directory to the plugin root when none is given. It then asks serde, the JSON conversion library, to deserialize the object into McpServerConfig. Finally, for environment-bound servers, it validates and rewrites environment variable sources before returning the finished config or an error string.

**Call relations**: parse_plugin_mcp_config calls this once per declared server. This function coordinates the lower-level helpers: normalize_plugin_mcp_server_value does general cleanup, executor_plugin_cwd safely resolves relative working directories, and bind_environment_env_vars enforces local-versus-remote environment variable rules.

*Call graph*: calls 3 internal fn (bind_environment_env_vars, executor_plugin_cwd, normalize_plugin_mcp_server_value); called by 1 (parse_plugin_mcp_config); 4 external calls (Object, String, to_string_lossy, matches!).


##### `executor_plugin_cwd`  (lines 122–139)

```
fn executor_plugin_cwd(plugin_root: &Path, configured_cwd: &str) -> Result<PathBuf, String>
```

**Purpose**: This safely resolves a plugin server’s working directory when the server is owned by an executor environment. It prevents a relative path from escaping the plugin’s folder.

**Data flow**: It takes the plugin root path and the configured cwd string. If the configured path is absolute, it returns it unchanged. If it is relative, it checks for path parts like .., a filesystem root, or a platform prefix that could point outside the plugin root. Safe relative paths are joined onto the plugin root; unsafe ones become an explanatory error.

**Call relations**: normalize_plugin_mcp_server calls this when an environment-bound command server has a string cwd. Its result is put back into the JSON object before the server is converted into the final runtime configuration.

*Call graph*: called by 1 (normalize_plugin_mcp_server); 3 external calls (join, new, format!).


##### `bind_environment_env_vars`  (lines 141–175)

```
fn bind_environment_env_vars(config: &mut McpServerConfig) -> Result<(), String>
```

**Purpose**: This checks environment variable declarations for stdio MCP servers and makes sure they match where the server will run. It prevents a remote executor-owned plugin from accidentally asking for local-only values, and prevents a local environment from using remote-only values.

**Data flow**: It receives a mutable McpServerConfig. It first asks whether the target environment is local. If the server is not a stdio server, it leaves the config unchanged. For stdio servers, it walks through each environment variable entry. Plain variable names in a remote environment are rewritten into explicit remote-sourced config entries. Explicit config entries are accepted, filled in with a remote source when appropriate, or rejected when their source conflicts with the environment. It returns success after updating the config, or an error message for an invalid source choice.

**Call relations**: normalize_plugin_mcp_server calls this after the server has been deserialized into McpServerConfig and only when environment placement is being applied. It is the final safety check before a normalized environment-bound config is accepted.

*Call graph*: calls 1 internal fn (is_local_environment); called by 1 (normalize_plugin_mcp_server); 3 external calls (format!, take, unreachable!).


##### `normalize_plugin_mcp_server_value`  (lines 177–228)

```
fn normalize_plugin_mcp_server_value(
    plugin_root: &Path,
    value: JsonValue,
    placement: PluginMcpServerPlacement<'_>,
) -> JsonMap<String, JsonValue>
```

**Purpose**: This performs lightweight cleanup on one raw server JSON object before stricter deserialization happens. It smooths over plugin-friendly field names and removes or warns about settings Codex does not use directly.

**Data flow**: It takes the plugin root, a raw JSON value, and the placement rule. If the value is not a JSON object, it returns an empty object, which will later fail normal config parsing with a useful error. For object values, it removes the type field after warning about unknown transport names, rewrites OAuth clientId to client_id, ignores OAuth callbackPort with a warning, and keeps any remaining OAuth settings. When placement is declared and cwd is a relative string, it turns that cwd into a path under the plugin root. The output is a cleaned JSON object ready for final conversion.

**Call relations**: normalize_plugin_mcp_server calls this at the start of per-server normalization. Its cleaned object becomes the input for placement-specific edits and then for conversion into McpServerConfig.

*Call graph*: called by 1 (normalize_plugin_mcp_server); 7 external calls (new, Object, String, join, new, matches!, warn!).


### `codex-mcp/src/catalog.rs`

`domain_logic` · `config load and runtime catalog resolution`

MCP means Model Context Protocol, a way for Codex to connect to external tool servers. This file is the rulebook for building the final list of those servers. Different sources can offer servers: plugins, explicitly selected plugins, user configuration, compatibility shims, and extensions. Sometimes they use the same server name, or one source wants to remove a server that another source added. Without this catalog, the rest of the system would not know which server should win, whether a disabled server should stay disabled, or how to explain conflicts.

The main workflow is like collecting sign-up sheets for the same event. `McpCatalogBuilder` records every action: register this server, remove that server, or mark a name disabled. When `build` runs, it sorts actions by a fixed precedence order, uses later/higher-priority actions as the winners for each name, records same-level collisions as conflicts, and then applies disabled-server rules. One important detail is that disabled registrations from most sources can become a name-wide veto, meaning later overlays keep that name disabled. A selected plugin is different: its disabled policy applies only to its own registration and does not poison an unrelated runtime server with the same name.

The result, `ResolvedMcpCatalog`, is immutable. Other code can ask it for one server, all server configs, plugin attribution for tool provenance, selected-plugin server names, or conflict reports.

#### Function details

##### `McpPluginAttribution::new`  (lines 16–21)

```
fn new(plugin_id: String, display_name: String) -> Self
```

**Purpose**: Creates a small identity record for the plugin that supplied an MCP server. This matters because later, when a tool comes from a plugin-owned server, Codex can say which plugin it came from.

**Data flow**: It receives a plugin ID and a human-friendly display name. It stores both strings in a new `McpPluginAttribution` value and returns that value unchanged.

**Call relations**: Plugin discovery, selected-plugin setup, runtime configuration building, and provenance tests create these attribution records before registering plugin-owned MCP servers.

*Call graph*: called by 6 (plugin, selected_mcp_attribution_does_not_join_an_unrelated_local_summary, tool_plugin_provenance_collects_app_and_mcp_sources, to_mcp_config_with_plugin_registrations, selected_plugin_wins_after_discovered_plugin_requirements, runtime_config_with_context).


##### `McpPluginAttribution::plugin_id`  (lines 23–25)

```
fn plugin_id(&self) -> &str
```

**Purpose**: Returns the stable internal ID of the plugin. Code uses this when it needs the exact plugin identity rather than the display label.

**Data flow**: It reads the stored plugin ID from the attribution object and returns it as borrowed text. Nothing is changed.

**Call relations**: This is an accessor for consumers of resolved plugin attribution, especially after `ResolvedMcpCatalog::plugin_attributions_by_server_name` has exposed the winning plugin-owned servers.


##### `McpPluginAttribution::display_name`  (lines 27–29)

```
fn display_name(&self) -> &str
```

**Purpose**: Returns the plugin's user-facing name. This is useful for messages, summaries, or provenance displays where a readable label is better than an internal ID.

**Data flow**: It reads the stored display name and returns it as borrowed text. The attribution object stays the same.

**Call relations**: This is used by code that receives plugin attribution and wants to show people which plugin supplied a server or tool.


##### `McpServerSource::disabled_registration_is_name_veto`  (lines 49–53)

```
fn disabled_registration_is_name_veto(&self) -> bool
```

**Purpose**: Decides whether a disabled winning registration should disable the whole server name for later overlays. The special case is a selected plugin, whose disabled setting should not block an unrelated runtime source that happens to reuse the same name.

**Data flow**: It looks at the source variant. It returns `false` for `SelectedPlugin` and `true` for every other source.

**Call relations**: `McpCatalogBuilder::build` calls this while applying disabled rules, so the final catalog knows whether to preserve a disabled name as a broader veto.

*Call graph*: 1 external calls (matches!).


##### `RegistrationPrecedence::tier`  (lines 66–74)

```
fn tier(self) -> u8
```

**Purpose**: Groups registration priorities into broad levels, such as plugin, selected plugin, config, compatibility, and extension. This is used to notice conflicts among actions that are competing at the same level.

**Data flow**: It receives one precedence value and converts it to a small number: lower numbers are lower tiers and higher numbers are higher tiers. It ignores ordering details inside a tier, such as plugin order.

**Call relations**: `McpCatalogBuilder::build` uses this after sorting actions, so it can report same-tier name collisions separately from normal higher-priority overrides.


##### `McpServerRegistration::from_config`  (lines 87–94)

```
fn from_config(name: String, config: McpServerConfig) -> Self
```

**Purpose**: Creates a registration for an MCP server declared by user or app configuration. Configuration has higher priority than plugin registrations but lower priority than compatibility and extension sources.

**Data flow**: It receives a server name and its `McpServerConfig`, labels the source as `Config`, assigns config-level precedence, and returns a complete registration.

**Call relations**: Configuration-building code and catalog tests use this before handing the registration to `McpCatalogBuilder::register`; internally it delegates to `McpServerRegistration::new`.

*Call graph*: called by 5 (disabled_winner_remains_a_veto_when_the_catalog_is_extended, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration, effective_mcp_servers_preserve_runtime_servers, to_mcp_config_with_plugin_registrations); 1 external calls (new).


##### `McpServerRegistration::from_plugin`  (lines 96–108)

```
fn from_plugin(
        name: String,
        attribution: McpPluginAttribution,
        plugin_order: usize,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates a registration for an MCP server supplied by a discovered plugin. It includes plugin attribution so later tool provenance can point back to that plugin.

**Data flow**: It receives the server name, plugin identity, discovery order, and server config. It wraps the attribution as a plugin source, converts the order into plugin precedence, and returns a registration.

**Call relations**: Plugin registration paths and tests call this before adding the registration to the builder. It delegates the final struct creation to `McpServerRegistration::new`.

*Call graph*: called by 6 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, earlier_plugin_wins_with_an_explicit_conflict, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration, tool_plugin_provenance_collects_app_and_mcp_sources, to_mcp_config_with_plugin_registrations); 4 external calls (new, Plugin, Plugin, Reverse).


##### `McpServerRegistration::from_selected_plugin`  (lines 111–123)

```
fn from_selected_plugin(
        name: String,
        attribution: McpPluginAttribution,
        selection_order: usize,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates a registration for a plugin that was explicitly selected for the current thread or context. These registrations beat ordinary discovered plugins but do not beat configuration.

**Data flow**: It receives a name, selected-plugin attribution, selection order, and server config. It marks the source as `SelectedPlugin`, assigns selected-plugin precedence, and returns a registration.

**Call relations**: Runtime context setup and selected-plugin tests use this to feed selected plugin servers into the catalog. It builds the final value through `McpServerRegistration::new`.

*Call graph*: called by 5 (disabled_selected_plugin_does_not_veto_runtime_overlays, selected_plugins_override_discovered_plugins_but_not_config, selected_mcp_attribution_does_not_join_an_unrelated_local_summary, selected_plugin_wins_after_discovered_plugin_requirements, runtime_config_with_context); 4 external calls (new, SelectedPlugin, SelectedPlugin, Reverse).


##### `McpServerRegistration::from_compatibility`  (lines 125–136)

```
fn from_compatibility(
        name: String,
        id: impl Into<String>,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates a registration for a compatibility-provided MCP server. Compatibility registrations sit above config in the precedence order.

**Data flow**: It receives a server name, a compatibility ID, and a config. It turns the ID into a string, marks the source as `Compatibility`, assigns compatibility precedence, and returns the registration.

**Call relations**: Runtime configuration and precedence tests call this before registration. It uses `McpServerRegistration::new` to assemble the shared registration shape.

*Call graph*: called by 3 (equal_precedence_uses_insertion_order_not_source_identity, source_precedence_preserves_the_winning_registration, runtime_config_with_context); 2 external calls (into, new).


##### `McpServerRegistration::from_extension`  (lines 138–150)

```
fn from_extension(
        name: String,
        id: impl Into<String>,
        contribution_order: usize,
        config: McpServerConfig,
    ) -> Self
```

**Purpose**: Creates a registration for an MCP server contributed by an extension. Extensions have the highest broad source tier in this catalog.

**Data flow**: It receives a server name, extension ID, contribution order, and config. It stores the ID as an extension source, records the extension precedence, and returns the registration.

**Call relations**: Runtime configuration and disabled-rule tests use this for extension overlays. It hands the final assembly to `McpServerRegistration::new`.

*Call graph*: called by 6 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, disabled_veto_only_disables_the_winning_registration, disabled_winner_remains_a_veto_when_the_catalog_is_extended, source_precedence_preserves_the_winning_registration, runtime_config_with_context); 3 external calls (into, new, Extension).


##### `McpServerRegistration::new`  (lines 152–164)

```
fn new(
        name: String,
        source: McpServerSource,
        config: McpServerConfig,
        precedence: RegistrationPrecedence,
    ) -> Self
```

**Purpose**: Builds the common registration object used by all source-specific constructors. It keeps the source, config, name, and precedence together so the resolver can compare registrations fairly.

**Data flow**: It receives the already-decided name, source, config, and precedence. It places them into a `McpServerRegistration` and returns it.

**Call relations**: All public `from_*` constructors call this after they have chosen the right source label and precedence for their kind of registration.


##### `CatalogAction::name`  (lines 194–199)

```
fn name(&self) -> &str
```

**Purpose**: Gets the server name affected by a catalog action, whether the action registers a server or removes one. This lets the builder compare actions that target the same logical server.

**Data flow**: It reads either the registration name or the removal name and returns borrowed text. The action is not changed.

**Call relations**: `McpCatalogBuilder::build` uses this while grouping actions by server name and while deciding the winning action for each name.


##### `CatalogAction::precedence`  (lines 201–206)

```
fn precedence(&self) -> RegistrationPrecedence
```

**Purpose**: Gets the priority value for a catalog action. The resolver uses this to decide which source wins when multiple actions mention the same server name.

**Data flow**: It reads the precedence from either a registration or a removal action and returns that value. Nothing else changes.

**Call relations**: `McpCatalogBuilder::build` uses this to sort all actions and to group same-tier actions for conflict reporting.


##### `CatalogAction::conflict_action`  (lines 208–215)

```
fn conflict_action(&self) -> McpServerConflictAction
```

**Purpose**: Converts an internal action into the public conflict-report form. This hides the full server config and reports only whether a source registered or removed the server.

**Data flow**: It looks at the action. A registration becomes `Register(source)`, and a removal becomes `Remove(source)`, cloning the source identity for the report.

**Call relations**: `McpCatalogBuilder::build` calls this when it records same-tier name collisions and when it describes the final outcome of such a collision.

*Call graph*: 2 external calls (Register, Remove).


##### `McpCatalogBuilder::register`  (lines 226–229)

```
fn register(&mut self, registration: McpServerRegistration)
```

**Purpose**: Adds a server registration to the list of inputs that will later be resolved. It does not decide the winner immediately; it simply records the claim.

**Data flow**: It receives a completed `McpServerRegistration`, wraps it as a register action, and appends it to the builder's action list.

**Call relations**: Code that discovers config, plugin, compatibility, or extension servers calls this before `McpCatalogBuilder::build` performs the final precedence pass.

*Call graph*: 2 external calls (new, Register).


##### `McpCatalogBuilder::disable`  (lines 232–234)

```
fn disable(&mut self, name: String)
```

**Purpose**: Marks a server name as disabled using the legacy name-based rule. This is a broad veto that is applied after the winning source is chosen.

**Data flow**: It receives a server name and inserts it into the builder's disabled-name set. Later, any winning registration with that name will be forced disabled.

**Call relations**: This feeds disabled information into `McpCatalogBuilder::build`, which combines it with per-registration enabled flags and source-specific veto rules.

*Call graph*: 1 external calls (insert).


##### `McpCatalogBuilder::remove_compatibility`  (lines 236–242)

```
fn remove_compatibility(&mut self, name: String, id: impl Into<String>)
```

**Purpose**: Records that a compatibility source removes a server name. This lets a compatibility layer cancel a server without pretending to register a replacement config.

**Data flow**: It receives a server name and compatibility ID, turns the ID into a string, creates a removal action with compatibility precedence, and appends it to the action list.

**Call relations**: When `McpCatalogBuilder::build` later resolves actions, this removal can become the winning action for that server name, causing no server to appear in the final catalog.

*Call graph*: 1 external calls (into).


##### `McpCatalogBuilder::remove_extension`  (lines 244–255)

```
fn remove_extension(
        &mut self,
        name: String,
        id: impl Into<String>,
        contribution_order: usize,
    )
```

**Purpose**: Records that an extension removes a server name. This gives extensions a high-priority way to take a server out of the final catalog.

**Data flow**: It receives a server name, extension ID, and contribution order. It creates an extension removal action with that precedence and appends it to the builder.

**Call relations**: `McpCatalogBuilder::build` treats this alongside registrations; if the removal wins for its name, the final resolved catalog simply omits that server.

*Call graph*: 2 external calls (into, Extension).


##### `McpCatalogBuilder::build`  (lines 257–322)

```
fn build(mut self) -> ResolvedMcpCatalog
```

**Purpose**: Turns all recorded registrations, removals, and disabled names into the final resolved catalog. This is the heart of the file: it decides winners, records conflicts, and applies disabled behavior.

**Data flow**: It starts with the builder's action list and disabled-name set. It stably sorts actions by precedence, walks them so stronger or later tie-breaking actions overwrite earlier winners for the same name, groups same-name same-tier actions into conflict reports, then converts winning register actions into `ResolvedMcpServer` entries while dropping winning removal actions. It also forces disabled configs when a name is disabled or a winning registration was already disabled, and it may preserve that name as a future veto.

**Call relations**: After callers have filled a `McpCatalogBuilder` using `register`, `disable`, and remove methods, they call `build` to produce the immutable `ResolvedMcpCatalog` used by the rest of MCP setup and runtime configuration.

*Call graph*: 3 external calls (new, new, new).


##### `ResolvedMcpServer::source`  (lines 333–335)

```
fn source(&self) -> &McpServerSource
```

**Purpose**: Returns where the winning server came from, such as a plugin, config, compatibility layer, or extension. This is important for attribution and source-specific behavior.

**Data flow**: It reads the stored source from a resolved server and returns it by reference. The server is unchanged.

**Call relations**: Catalog query methods, especially plugin attribution and selected-plugin filtering, use this source information to decide how to present or filter resolved servers.


##### `ResolvedMcpServer::config`  (lines 337–339)

```
fn config(&self) -> &McpServerConfig
```

**Purpose**: Returns the actual server configuration that won resolution. Other code uses this to start or expose the MCP server with the correct settings.

**Data flow**: It reads the stored `McpServerConfig` from the resolved server and returns it by reference. Nothing is modified.

**Call relations**: This is the basic accessor behind consumers that need the chosen configuration, including the catalog method that exports all configured servers.


##### `ResolvedMcpCatalog::builder`  (lines 352–354)

```
fn builder() -> McpCatalogBuilder
```

**Purpose**: Creates an empty catalog builder. This is the normal starting point for collecting MCP registrations before resolving them.

**Data flow**: It creates the builder's default state: no actions and no disabled names. It returns that empty builder to the caller.

**Call relations**: Catalog tests and runtime configuration paths call this first, then add registrations or removals, and finally call `McpCatalogBuilder::build`.

*Call graph*: called by 12 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, disabled_veto_only_disables_the_winning_registration, disabled_winner_remains_a_veto_when_the_catalog_is_extended, earlier_plugin_wins_with_an_explicit_conflict, equal_precedence_uses_insertion_order_not_source_identity, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration, effective_mcp_servers_preserve_runtime_servers, selected_mcp_attribution_does_not_join_an_unrelated_local_summary (+2 more)); 1 external calls (default).


##### `ResolvedMcpCatalog::to_builder`  (lines 356–361)

```
fn to_builder(&self) -> McpCatalogBuilder
```

**Purpose**: Turns an already resolved catalog back into a mutable builder. This is useful when later runtime overlays need to extend or adjust an existing catalog while preserving earlier actions and disabled-name vetoes.

**Data flow**: It copies the catalog's stored action history and disabled-name set into a new `McpCatalogBuilder`. The resolved catalog remains unchanged.

**Call relations**: After a catalog has been built, callers can use this to reopen the input list, add more actions, and run `build` again with the old resolution context preserved.

*Call graph*: 1 external calls (clone).


##### `ResolvedMcpCatalog::server`  (lines 363–365)

```
fn server(&self, name: &str) -> Option<&ResolvedMcpServer>
```

**Purpose**: Looks up one resolved MCP server by name. This is the direct way to ask, 'Did this server make it into the final catalog, and if so, what won?'

**Data flow**: It receives a server name, searches the resolved server map, and returns either a reference to the matching `ResolvedMcpServer` or no result.

**Call relations**: Consumers use this after `McpCatalogBuilder::build` when they need details for one specific server rather than the whole catalog.


##### `ResolvedMcpCatalog::configured_servers`  (lines 367–372)

```
fn configured_servers(&self) -> HashMap<String, McpServerConfig>
```

**Purpose**: Exports the final winning server configurations as a plain name-to-config map. This is useful for code that only needs to run or pass along server configs and does not care about source metadata.

**Data flow**: It walks the resolved server map, clones each server name and config, and returns them in a `HashMap`. Source information and conflicts are left out.

**Call relations**: Runtime MCP configuration code can call this on the resolved catalog to get the concrete set of server configs to use.


##### `ResolvedMcpCatalog::plugin_attributions_by_server_name`  (lines 375–388)

```
fn plugin_attributions_by_server_name(&self) -> HashMap<String, McpPluginAttribution>
```

**Purpose**: Returns plugin identity for every winning server that came from a plugin or selected plugin. This supports provenance: showing which plugin supplied a tool or server.

**Data flow**: It scans all resolved servers. For plugin and selected-plugin sources, it clones the server name and attribution into a new map; for config, compatibility, and extension sources, it skips the server.

**Call relations**: Tool provenance and plugin-summary code use this after resolution so only the plugin-owned servers that actually won are credited.


##### `ResolvedMcpCatalog::selected_plugin_server_names`  (lines 391–395)

```
fn selected_plugin_server_names(&self) -> impl Iterator<Item = &str>
```

**Purpose**: Lists the names of winning servers that came specifically from thread-selected plugins. This lets runtime code distinguish explicitly selected plugin servers from ordinary discovered plugin servers.

**Data flow**: It scans the resolved servers and yields only the names whose source is `SelectedPlugin`. It returns an iterator, so names are produced as the caller loops over them.

**Call relations**: Runtime context code can call this after catalog resolution to know which selected plugin servers are active in the current thread or request context.


##### `ResolvedMcpCatalog::conflicts`  (lines 397–399)

```
fn conflicts(&self) -> &[McpServerConflict]
```

**Purpose**: Returns the recorded same-tier name conflicts. These reports explain cases where multiple equal-level actions targeted the same server name, even though final precedence still produced one outcome.

**Data flow**: It reads the catalog's conflict list and returns it as a borrowed slice. The catalog is not changed.

**Call relations**: After `McpCatalogBuilder::build` has detected conflicts, callers can use this accessor to inspect or report them without rerunning resolution.


### `core/src/mcp.rs`

`orchestration` · `config load and session/thread setup`

This file is the meeting point for all sources of MCP server configuration. MCP means “Model Context Protocol,” a way for Codex to talk to outside tools and services. A user may define servers in their config, plugins may add more, Codex may add a built-in legacy “apps” server, and host extensions may add or remove servers at runtime. Without this file, those sources would stay separate, and Codex would not have one reliable answer to the question: “Which MCP servers are available right now?”

The main type is McpManager. It keeps a plugin manager and, optionally, an extension registry. When asked for runtime configuration, it first asks extensions for their contributions. These contributions can set a server, remove a server, or register a selected plugin-backed server. It records the order of those actions because later actions can intentionally override earlier ones, like sticky notes placed on top of one another.

Then it converts the normal Codex config into an MCP config, adds plugin-selected registrations, adds or removes the legacy Codex Apps server depending on whether apps are enabled, and applies extension overlays. If several sources fight over the same server name, it keeps the catalog’s resolved result and logs a warning. The file also offers simpler views: only configured servers, runtime servers before authentication filtering, and effective servers after login-based access rules are applied.

#### Function details

##### `McpManager::new`  (lines 44–49)

```
fn new(plugins_manager: Arc<PluginsManager>) -> Self
```

**Purpose**: Creates a basic MCP manager using the given plugin manager and no host-installed extensions. This is useful in normal paths or tests where only config and plugins should affect MCP servers.

**Data flow**: It receives a shared plugin manager. It also creates an empty extension registry, meaning there are no runtime extension contributions. It returns an McpManager that can later build MCP server lists from config and plugins only.

**Call relations**: Many command and session setup paths call this when they need MCP support without extension contributions. Internally it asks the extension API for an empty registry so the rest of the manager can use the same flow whether extensions exist or not.

*Call graph*: called by 14 (run_get, run_list, run_login, run_logout, list_accessible_connectors_from_mcp_tools_with_environment_manager, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx (+4 more)); 1 external calls (empty_extension_registry).


##### `McpManager::new_with_extensions`  (lines 52–60)

```
fn new_with_extensions(
        plugins_manager: Arc<PluginsManager>,
        extensions: Arc<ExtensionRegistry<Config>>,
    ) -> Self
```

**Purpose**: Creates an MCP manager that can include servers contributed by host-installed extensions. This is the constructor to use when the surrounding app wants extensions to affect the MCP server catalog.

**Data flow**: It receives a shared plugin manager and a shared extension registry. It stores both inside the new McpManager. Nothing is resolved yet; the manager simply keeps these sources ready for later configuration building.

**Call relations**: Setup code that has an extension registry calls this to produce a manager with extension awareness. Later, runtime configuration methods use the stored registry to ask extensions what MCP servers they want to add or remove.

*Call graph*: called by 3 (new, installed_manager, later_extension_can_remove_same_name_registration).


##### `McpManager::runtime_config`  (lines 64–67)

```
async fn runtime_config(&self, config: &Config) -> McpConfig
```

**Purpose**: Builds the MCP configuration for the current global runtime context. It includes normal config, plugins, compatibility behavior, and extension contributions.

**Data flow**: It receives the main Codex config. It passes that config along with no thread-specific extension data into the shared runtime-building helper. The result is an McpConfig ready to be used for server lookup.

**Call relations**: Higher-level methods call this when they need the runtime MCP picture, such as before listing runtime servers or computing effective servers. It delegates the real work to McpManager::runtime_config_with_context so the global and thread-specific paths stay consistent.

*Call graph*: calls 1 internal fn (runtime_config_with_context); called by 2 (effective_servers, runtime_servers).


##### `McpManager::runtime_config_for_thread`  (lines 69–76)

```
async fn runtime_config_for_thread(
        &self,
        config: &Config,
        thread_init: &ExtensionDataInit,
    ) -> McpConfig
```

**Purpose**: Builds an MCP configuration for a specific thread or conversation setup. This lets extensions make thread-specific MCP contributions when they have extra initialization data.

**Data flow**: It receives the main Codex config and thread initialization data from the extension system. It passes both into the shared runtime-building helper. The output is an McpConfig that reflects that particular thread context.

**Call relations**: This is the thread-aware counterpart to McpManager::runtime_config. It uses McpManager::runtime_config_with_context so all ordering, plugin registration, compatibility, and conflict behavior is identical to the global path.

*Call graph*: calls 1 internal fn (runtime_config_with_context).


##### `McpManager::runtime_config_with_context`  (lines 78–183)

```
async fn runtime_config_with_context(
        &self,
        config: &Config,
        thread_init: Option<&ExtensionDataInit>,
    ) -> McpConfig
```

**Purpose**: Assembles the full runtime MCP configuration from every active source. It is the core routine that decides which MCP server registrations are present after config, plugins, built-ins, and extensions are combined.

**Data flow**: It starts with the Codex config and optional thread initialization data. From that it creates an extension contribution context, then asks each MCP contributor for its actions. It separates plugin selections from add/remove overlays, preserving the order of extension actions. Next it turns the base config plus selected plugin registrations into an MCP config, opens the server catalog for editing, adds or removes the legacy Codex Apps server depending on app settings, applies extension additions and removals, logs any conflicts the catalog reports, and returns the completed McpConfig.

**Call relations**: Both public runtime configuration entry points call this helper. It calls into extension contributors, config conversion, MCP catalog registration helpers, and conflict reporting. In the bigger flow, it is the central “merge desk” where all MCP server sources are reconciled before other code asks for server maps or authentication-filtered results.

*Call graph*: calls 6 internal fn (new, from_compatibility, from_extension, from_selected_plugin, for_thread, global); called by 2 (runtime_config, runtime_config_for_thread); 4 external calls (new, to_mcp_config_with_plugin_registrations, codex_apps_mcp_server_config, warn!).


##### `McpManager::configured_servers`  (lines 186–189)

```
async fn configured_servers(&self, config: &Config) -> HashMap<String, McpServerConfig>
```

**Purpose**: Returns only the MCP servers that come from user config and plugins, without runtime extension additions or compatibility overlays. This is useful when code wants the base configured view rather than the full runtime view.

**Data flow**: It receives the Codex config. It converts that config into an MCP config using the plugin manager, then extracts the configured MCP servers as a name-to-server map. It does not change the manager or apply extension contributions.

**Call relations**: Callers use this when they specifically need config-backed and plugin-backed servers only. Unlike McpManager::runtime_servers, it does not call the runtime merge path, so extension overlays and compatibility-only runtime additions are left out.

*Call graph*: 2 external calls (to_mcp_config, configured_mcp_servers).


##### `McpManager::runtime_servers`  (lines 192–195)

```
async fn runtime_servers(&self, config: &Config) -> HashMap<String, McpServerConfig>
```

**Purpose**: Returns the MCP servers available at runtime before login or authentication rules are applied. This answers “what servers are configured or contributed right now?” without yet asking whether the user is allowed to use each one.

**Data flow**: It receives the Codex config. It first builds the full runtime MCP config, then extracts the configured server map from that result. The returned map is keyed by server name and contains raw server configuration values.

**Call relations**: This method calls McpManager::runtime_config to get the merged runtime picture, then hands that config to the MCP helper that extracts server configs. It sits above the core merge logic and below callers that need a simple server list.

*Call graph*: calls 1 internal fn (runtime_config); 1 external calls (configured_mcp_servers).


##### `McpManager::effective_servers`  (lines 198–205)

```
async fn effective_servers(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> HashMap<String, EffectiveMcpServer>
```

**Purpose**: Returns the MCP servers that are actually usable after authentication rules are considered. This is the practical final answer for code that needs to know which servers the current user can access.

**Data flow**: It receives the Codex config and an optional authentication object, which represents the current login state. It builds the runtime MCP config, then passes that config and the authentication information to the MCP helper that filters or annotates servers according to access rules. The result is a name-to-effective-server map.

**Call relations**: Callers use this when they need the final, access-aware MCP server list. It depends on McpManager::runtime_config for the merged catalog, then hands off to the MCP layer to apply authentication gating and produce EffectiveMcpServer values.

*Call graph*: calls 1 internal fn (runtime_config); 1 external calls (effective_mcp_servers).


### Model and provider presets
These files define provider registries, model-manager configuration and helpers, collaboration presets, approval presets, and lightweight TUI wrappers around model data and update actions.

### `model-provider-info/src/lib.rs`

`config` · `startup and config load`

Codex can send model requests to different services, and each service needs practical details: where its API lives, how to authenticate, what headers to send, and how long to retry when the network is flaky. This file is the central recipe book for those provider definitions.

It contains the data shape for a provider, `ModelProviderInfo`, plus rules that keep invalid combinations out. For example, a provider should not ask for both an environment-variable API key and AWS signing at the same time. That would be like giving two different payment methods for the same checkout and not saying which one wins.

The file also creates built-in providers so Codex works without extra setup. OpenAI gets special defaults, including login support and WebSocket support. Amazon Bedrock gets AWS authentication settings and a required client-agent header. Local open-source providers use localhost URLs and can be adjusted with experimental environment variables.

Finally, it turns these human-facing provider settings into the lower-level API provider object used when Codex actually makes network requests. It also merges user-defined providers from config, while protecting built-in providers from being accidentally overwritten except for the narrow Bedrock AWS profile and region settings.

#### Function details

##### `WireApi::fmt`  (lines 60–65)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This turns the provider wire protocol value into text for display or serialization. Right now the only supported protocol is `responses`.

**Data flow**: It starts with a `WireApi` value, chooses the matching lowercase text, and writes that text into the formatter. The visible result is the string `responses`.

**Call relations**: This is used whenever Rust formatting asks how to print a `WireApi`. It hands the final text to the standard formatter so logs, messages, or serialized output can show a readable value.

*Call graph*: 1 external calls (write_str).


##### `WireApi::deserialize`  (lines 69–79)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: This reads a provider wire protocol from configuration text. It accepts `responses` and deliberately rejects the old `chat` value with a helpful migration message.

**Data flow**: It receives serialized data, reads it as a string, and compares the string to known protocol names. `responses` becomes the internal enum value; `chat` becomes a clear custom error; anything else becomes an unknown-value error.

**Call relations**: This runs while provider config is being parsed. It protects the rest of the system from seeing unsupported protocol choices, so later request code can assume the provider uses the supported Responses API.

*Call graph*: 3 external calls (deserialize, custom, unknown_variant).


##### `ModelProviderInfo::validate`  (lines 150–208)

```
fn validate(&self) -> std::result::Result<(), String>
```

**Purpose**: This checks whether a provider definition makes sense before Codex tries to use it. It catches unsafe or contradictory authentication settings early, when the user can still get a clear config error.

**Data flow**: It reads the provider's authentication-related fields, such as AWS settings, command-based auth, environment-variable keys, bearer tokens, OpenAI login requirements, and WebSocket support. If the combination is valid, it returns success; if not, it returns a plain error message explaining the conflict.

**Call relations**: This function is part of the config safety gate. Later code that creates clients and sends requests can rely on these rules having ruled out confusing combinations, such as AWS signing mixed with bearer-token authentication.

*Call graph*: 2 external calls (new, format!).


##### `ModelProviderInfo::build_header_map`  (lines 210–235)

```
fn build_header_map(&self) -> CodexResult<HeaderMap>
```

**Purpose**: This builds the actual HTTP headers that should be sent to a provider. Headers are small name-value labels attached to a web request, such as organization IDs or provider-specific flags.

**Data flow**: It reads fixed headers from the provider config and also reads optional headers whose values come from environment variables. Valid, non-empty values are inserted into an HTTP header map; invalid names or values are skipped. The result is the header map used by outgoing requests.

**Call relations**: This is called by `ModelProviderInfo::to_api_provider` when turning config into a ready-to-use API provider. It gathers the request labels before the lower-level API layer starts making network calls.

*Call graph*: called by 1 (to_api_provider); 4 external calls (with_capacity, try_from, try_from, var).


##### `ModelProviderInfo::to_api_provider`  (lines 237–273)

```
fn to_api_provider(&self, auth_mode: Option<AuthMode>) -> CodexResult<ApiProvider>
```

**Purpose**: This converts Codex's provider configuration into the lower-level provider object used by the API client. It bridges friendly config settings and the concrete request settings needed to call a model service.

**Data flow**: It reads the provider name, base URL, query parameters, headers, retry settings, stream timeout, and the current authentication mode. If no base URL is set, it chooses the normal OpenAI API URL or the ChatGPT Codex backend URL depending on the auth mode. It returns an API provider object ready for model requests.

**Call relations**: This is called when code such as `list_models` needs to contact a provider. It asks `build_header_map`, `request_max_retries`, and `stream_idle_timeout` for the pieces needed by the network layer, then hands off a complete provider description.

*Call graph*: calls 3 internal fn (build_header_map, request_max_retries, stream_idle_timeout); called by 1 (list_models); 2 external calls (from_millis, matches!).


##### `ModelProviderInfo::api_key`  (lines 278–294)

```
fn api_key(&self) -> CodexResult<Option<String>>
```

**Purpose**: This retrieves an API key from the environment when a provider is configured to use one. It avoids storing secrets directly in config files.

**Data flow**: It checks whether the provider names an environment variable. If so, it reads that variable and requires it to be non-empty; if the value is missing, it returns an error that can include setup instructions. If no environment key is configured, it returns no key without error.

**Call relations**: This is called by authentication code such as `realtime_api_key` and `bearer_auth_for_provider`. Those callers use the returned secret, if present, to authorize requests to the provider.

*Call graph*: called by 2 (realtime_api_key, bearer_auth_for_provider); 1 external calls (var).


##### `ModelProviderInfo::request_max_retries`  (lines 297–301)

```
fn request_max_retries(&self) -> u64
```

**Purpose**: This decides how many times Codex may retry a failed normal HTTP request for this provider. It gives every provider a safe default while limiting overly large user settings.

**Data flow**: It reads the optional configured retry count. If none is set, it uses the built-in default; if a value is set above the hard maximum, it lowers it to the maximum. The output is the effective retry count.

**Call relations**: This is used by `ModelProviderInfo::to_api_provider` while building the API client's retry policy. The network layer then uses that number when requests fail due to server or transport problems.

*Call graph*: called by 1 (to_api_provider).


##### `ModelProviderInfo::stream_max_retries`  (lines 304–308)

```
fn stream_max_retries(&self) -> u64
```

**Purpose**: This decides how many times Codex may reconnect after a streaming response is dropped. Streaming means the provider sends data gradually instead of all at once.

**Data flow**: It reads the optional configured stream retry count, falls back to a default when missing, and caps the value at a hard maximum. The result is the effective number of reconnection attempts.

**Call relations**: This value is available to streaming request code that needs to decide how persistent it should be when a long-running response connection breaks.


##### `ModelProviderInfo::stream_idle_timeout`  (lines 311–315)

```
fn stream_idle_timeout(&self) -> Duration
```

**Purpose**: This decides how long Codex should wait with no activity on a streaming response before treating the connection as lost.

**Data flow**: It reads the optional timeout in milliseconds. If none is configured, it uses the default timeout. It converts the millisecond number into a duration value that the rest of the program can use.

**Call relations**: This is called by `ModelProviderInfo::to_api_provider`, which includes the timeout in the API provider object. The request layer uses it to avoid waiting forever on a silent stream.

*Call graph*: called by 1 (to_api_provider); 1 external calls (from_millis).


##### `ModelProviderInfo::websocket_connect_timeout`  (lines 318–322)

```
fn websocket_connect_timeout(&self) -> Duration
```

**Purpose**: This decides how long Codex should wait while opening a WebSocket connection before giving up. A WebSocket is a long-lived two-way connection used for some real-time API traffic.

**Data flow**: It reads the optional configured WebSocket connection timeout in milliseconds, or uses the default if none is set. It returns that as a duration value.

**Call relations**: This supports code that opens WebSocket connections for providers that allow them. It gives that code a provider-specific timeout without hard-coding the value elsewhere.

*Call graph*: 1 external calls (from_millis).


##### `ModelProviderInfo::create_openai_provider`  (lines 324–359)

```
fn create_openai_provider(base_url: Option<String>) -> ModelProviderInfo
```

**Purpose**: This creates the built-in OpenAI provider definition. It gives Codex a ready-to-use OpenAI setup without requiring the user to write provider config by hand.

**Data flow**: It takes an optional base URL override and fills in the OpenAI provider fields: display name, protocol, default headers, optional organization and project headers from environment variables, OpenAI login requirement, and WebSocket support. It returns a complete `ModelProviderInfo` value.

**Call relations**: This is called when building the default provider catalog and by many tests that need a realistic OpenAI provider. The resulting provider can later be validated, merged with config, or converted into an API provider.

*Call graph*: called by 17 (model_client_with_counting_attestation, test_model_client_session, installed_extension_contributes_web_run_when_enabled, test_personal_access_token_uses_chatgpt_codex_base_url, test_supports_remote_compaction_for_openai, test_validate_provider_aws_rejects_conflicting_auth, test_validate_provider_aws_rejects_websockets, openai_provider_rejects_bedrock_api_key_auth, provider_info_with_command_auth, provider_without_command_auth_reports_no_command_auth (+7 more)); 1 external calls (env!).


##### `ModelProviderInfo::create_amazon_bedrock_provider`  (lines 361–389)

```
fn create_amazon_bedrock_provider(
        aws: Option<ModelProviderAwsAuthInfo>,
    ) -> ModelProviderInfo
```

**Purpose**: This creates the built-in Amazon Bedrock provider definition. Bedrock uses AWS-style authentication rather than a normal OpenAI API key, so it needs its own defaults.

**Data flow**: It receives optional AWS auth settings, supplies empty profile and region fields when none are provided, and fills in Bedrock's base URL, protocol, AWS auth field, required client-agent header, and disabled WebSocket support. It returns a complete provider definition.

**Call relations**: This is used when building the default provider catalog and throughout tests that exercise Bedrock behavior. Later merge logic can adjust only the AWS profile and region for this built-in provider.

*Call graph*: called by 14 (guardian_review_session_config_keeps_bedrock_provider_for_bedrock_gpt_5_4, use_bedrock_provider, test_amazon_bedrock_provider_adds_mantle_client_agent_header, api_provider_for_bedrock_bearer_token_uses_configured_region_endpoint, approval_review_preferred_model_uses_bedrock_gpt_5_4, capabilities_disable_unsupported_hosted_tools, managed_auth_takes_precedence_over_aws_auth, openai_auth_is_not_exposed_to_bedrock, amazon_bedrock_provider_creates_static_models_manager, amazon_bedrock_provider_returns_bedrock_account_state (+4 more)); 1 external calls (from).


##### `ModelProviderInfo::is_openai`  (lines 391–393)

```
fn is_openai(&self) -> bool
```

**Purpose**: This answers whether a provider is the built-in OpenAI provider. It is a small helper for places where OpenAI needs special treatment.

**Data flow**: It compares the provider's display name with the OpenAI display name. The output is true for OpenAI and false otherwise.

**Call relations**: This is used by `realtime_api_key` and by `supports_remote_compaction`. Those callers use it to decide whether OpenAI-specific features or authentication paths apply.

*Call graph*: called by 2 (realtime_api_key, supports_remote_compaction).


##### `ModelProviderInfo::is_amazon_bedrock`  (lines 395–397)

```
fn is_amazon_bedrock(&self) -> bool
```

**Purpose**: This answers whether a provider is the built-in Amazon Bedrock provider. It helps other code choose Bedrock-specific setup.

**Data flow**: It compares the provider's display name with the Amazon Bedrock display name and returns a true-or-false answer.

**Call relations**: This is called by `create_model_provider`, which can use the answer to create the right kind of runtime provider behavior for Bedrock.

*Call graph*: called by 1 (create_model_provider).


##### `ModelProviderInfo::supports_remote_compaction`  (lines 399–401)

```
fn supports_remote_compaction(&self) -> bool
```

**Purpose**: This tells Codex whether a provider supports remote compaction, a feature where conversation shrinking or summarizing can be delegated to the provider service.

**Data flow**: It checks whether the provider is OpenAI, or whether it matches an Azure Responses-compatible provider according to its name and base URL. It returns true when remote compaction is allowed and false otherwise.

**Call relations**: This is called by `should_use_remote_compact_task` when Codex decides whether to run compaction remotely. It uses `is_openai` for the OpenAI case and an external Azure check for compatible Azure providers.

*Call graph*: calls 1 internal fn (is_openai); called by 1 (should_use_remote_compact_task); 1 external calls (is_azure_responses_provider).


##### `ModelProviderInfo::has_command_auth`  (lines 403–405)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: This reports whether the provider uses command-backed authentication. That means Codex runs a configured command to obtain a bearer token instead of reading a fixed key.

**Data flow**: It checks whether the provider's `auth` field is present. The result is true when command-based auth is configured and false when it is not.

**Call relations**: This is called by higher-level authentication checks named `has_command_auth`. Those checks can then decide whether any provider setup requires running an external token command.

*Call graph*: called by 1 (has_command_auth).


##### `built_in_model_providers`  (lines 415–441)

```
fn built_in_model_providers(
    openai_base_url: Option<String>,
) -> HashMap<String, ModelProviderInfo>
```

**Purpose**: This creates the default provider catalog that ships with Codex. It makes OpenAI, Amazon Bedrock, Ollama, and LM Studio available before the user adds anything to their config.

**Data flow**: It receives an optional OpenAI base URL override, creates provider definitions for OpenAI and Amazon Bedrock, creates local open-source provider definitions for Ollama and LM Studio, and stores them in a map keyed by provider ID. The output is the starting provider catalog.

**Call relations**: This function calls the provider factory functions for each built-in entry. Its result is later combined with user configuration by `merge_configured_model_providers` so startup has one complete provider list.

*Call graph*: calls 1 internal fn (create_oss_provider); 2 external calls (create_amazon_bedrock_provider, create_openai_provider).


##### `merge_configured_model_providers`  (lines 448–479)

```
fn merge_configured_model_providers(
    mut model_providers: HashMap<String, ModelProviderInfo>,
    configured_model_providers: HashMap<String, ModelProviderInfo>,
) -> Result<HashMap<String, ModelP
```

**Purpose**: This combines user-defined providers with the built-in provider catalog. It lets users add new providers while protecting built-in defaults from accidental replacement.

**Data flow**: It starts with the built-in provider map and a second map from config. For most provider IDs, it inserts the configured provider only if that ID is not already built in. For Amazon Bedrock, it allows only `aws.profile` and `aws.region` changes and rejects any other attempted changes. It returns the merged map or an error message.

**Call relations**: This is used after config is read. It sits between raw configuration and runtime provider use, making sure the final catalog includes user additions but keeps important built-in providers consistent.

*Call graph*: 2 external calls (format!, default).


##### `create_oss_provider`  (lines 481–498)

```
fn create_oss_provider(default_provider_port: u16, wire_api: WireApi) -> ModelProviderInfo
```

**Purpose**: This creates a local open-source provider definition, such as Ollama or LM Studio, using default localhost settings. It also allows experimental environment variables to override the local port or full base URL.

**Data flow**: It receives the provider's default port and wire protocol. It reads `CODEX_OSS_PORT` and `CODEX_OSS_BASE_URL` from the environment if present and non-empty, builds a localhost base URL when needed, then passes the final URL to `create_oss_provider_with_base_url`. The output is a provider definition.

**Call relations**: This is called by `built_in_model_providers` for Ollama and LM Studio. It delegates the final struct construction to `create_oss_provider_with_base_url` after deciding what base URL should be used.

*Call graph*: calls 1 internal fn (create_oss_provider_with_base_url); called by 1 (built_in_model_providers); 2 external calls (format!, var).


##### `create_oss_provider_with_base_url`  (lines 500–520)

```
fn create_oss_provider_with_base_url(base_url: &str, wire_api: WireApi) -> ModelProviderInfo
```

**Purpose**: This creates a local open-source provider definition using an exact base URL. It is the final constructor after any default or environment-based URL choice has already been made.

**Data flow**: It receives a base URL string and a wire protocol, then fills in a provider named `gpt-oss` with no API-key requirement, no extra headers, default retry and timeout behavior, and no WebSocket support. It returns the completed `ModelProviderInfo`.

**Call relations**: This is called by `create_oss_provider`. That caller decides the URL, and this function packages it into the common provider shape used by the rest of Codex.

*Call graph*: called by 1 (create_oss_provider).


### `models-manager/src/config.rs`

`config` · `config load and model setup`

This file is small but important because it gives the models manager one clear place to store its model-related settings. A language model system needs to know practical limits, such as how much text a model can read at once, when long conversations should be compacted, and how much tool output can be included. It may also need base instructions, personality behavior, and information about which models are available.

The main piece is `ModelsManagerConfig`, a plain data structure. Most fields are optional, meaning they can be absent if the caller or configuration source does not provide them. That lets the rest of the system distinguish between “use the default behavior” and “the user explicitly set this value.” For example, `model_context_window` can hold the model’s maximum input size, while `model_auto_compact_token_limit` can say when the system should shorten or summarize a conversation. `model_catalog` can carry a catalog response from the OpenAI models protocol, like a menu of available models.

The struct can be cloned, printed for debugging, and created with default empty values. In everyday terms, this file provides the blank form that other parts of the program fill out before deciding how to run a model.


### `models-manager/src/model_presets.rs`

`config` · `config load`

This file is a small compatibility shim. In older versions of the system, there were hardcoded model presets and related migration prompts. Those presets have since been removed, and the available models are now read from the active catalog instead. However, some users may still have saved configuration values that refer to old prompt-hiding options. If the code simply forgot those names, older settings could stop being recognized, and users might see migration prompts again even after choosing to hide them. To avoid that, this file preserves the exact text of two legacy configuration keys as constants. Think of them like old forwarding addresses: the office moved, but mail sent to the old address still needs to be understood. The constants themselves do not list models or perform any migration. They are just stable names that other parts of the system can refer to when reading or writing compatibility settings.


### `models-manager/src/lib.rs`

`orchestration` · `cross-cutting`

This file is like the reception desk for the models manager library. It tells the rest of the program which parts of this crate are available, such as model presets, model information, manager logic, collaboration mode presets, and test support. It also re-exports a couple of important types so callers can import them from one convenient place instead of knowing the crate’s internal layout.

The file includes one important data-loading helper: it reads a bundled `models.json` file that ships inside the program and turns it into a `ModelsResponse`, which is the structured form the rest of the system expects when talking about available OpenAI-style models. Because the JSON is compiled into the program, this works without needing to find a separate file on disk at runtime.

It also includes a small version helper. Package versions can include extra labels like `-alpha.4`, but sometimes the system only wants the three-number version, such as `1.2.3`. This helper builds that clean version from compile-time package information. Without this file, callers would have to know more internal module paths, and there would be no single simple place to load the bundled model catalog or get the normalized client version.

#### Function details

##### `bundled_models_response`  (lines 13–16)

```
fn bundled_models_response() -> std::result::Result<codex_protocol::openai_models::ModelsResponse, serde_json::Error>
```

**Purpose**: Loads the model catalog that is packaged with the application and turns it into structured data the rest of the code can use. Someone would use this when they need the default list of known models without fetching it from a network service or reading a runtime file.

**Data flow**: It starts with the text contents of the bundled `models.json` file, which are embedded in the compiled program. It asks the JSON parser to convert that text into a `ModelsResponse`. The result is either the parsed model list or an error explaining that the bundled JSON could not be read as the expected shape.

**Call relations**: This helper relies on the compile-time file inclusion step to supply the raw JSON text, then hands that text to the JSON parser. Higher-level model manager code can call it when it needs a ready-to-use default model catalog.

*Call graph*: 2 external calls (include_str!, from_str).


##### `client_version_to_whole`  (lines 19–26)

```
fn client_version_to_whole() -> String
```

**Purpose**: Returns the client package version as only three numbers, such as `1.2.3`. This is useful when other parts of the system need a stable version string without pre-release labels like `alpha` or `beta`.

**Data flow**: It reads the package’s major, minor, and patch version numbers that were baked in during compilation. It joins those three pieces with dots and returns the resulting string. It does not read user input or change any stored state.

**Call relations**: This function uses Rust’s formatting machinery to build the string from compile-time package values. Other code can call it whenever it needs the simplified client version for reporting, comparison, or protocol metadata.

*Call graph*: 1 external calls (format!).


### `models-manager/src/model_info.rs`

`domain_logic` · `model selection and configuration`

A model is not just a name like "gpt-5". The rest of the system needs to know practical facts about it: how much text it can read, whether it supports reasoning summaries, what instructions it should receive, and how tool output should be shortened if it is too long. This file is the place where those facts are filled in or adjusted.

Its main job is to take model information from elsewhere and make it usable in the current installation. If the configuration says to override a setting, `with_config_overrides` applies that override carefully. For example, if a user asks for a smaller context window, it will not exceed the model's known maximum. If a tool output limit is given in tokens, it converts that into the kind of truncation rule the model expects.

The file also provides a fallback for unknown model names. If the system sees a model slug it does not recognize, `model_info_from_slug` creates a conservative `ModelInfo` record so the program can keep running instead of failing immediately. This is like giving an unfamiliar appliance a basic instruction card: not perfect, but enough to operate safely.

Finally, it contains local personality message templates for a small set of model slugs. These templates let certain models receive a friendly or pragmatic style setting, while other models simply get the standard base instructions.

#### Function details

##### `with_config_overrides`  (lines 23–63)

```
fn with_config_overrides(mut model: ModelInfo, config: &ModelsManagerConfig) -> ModelInfo
```

**Purpose**: This function takes an existing model description and applies settings from the local models manager configuration. It is used when the system already has candidate model metadata but needs to respect user or deployment-specific choices.

**Data flow**: It receives a `ModelInfo` record and a `ModelsManagerConfig`. It reads optional values from the config, such as whether reasoning summaries are supported, the desired context window, auto-compaction limits, tool output limits, and custom base instructions. It updates the model record in place, making sure a requested context window does not go above the model's maximum. If tool output should be limited, it creates a new truncation rule either in bytes or in tokens. It returns the adjusted `ModelInfo`.

**Call relations**: This function is called by `construct_model_info_from_candidates` after possible model descriptions have been found. In that larger flow, it acts as the final tailoring step: the candidate metadata comes in, local configuration is applied, and the resulting model information is handed back for the rest of the system to use.

*Call graph*: calls 2 internal fn (bytes, tokens); called by 1 (construct_model_info_from_candidates); 2 external calls (approx_bytes_for_tokens, try_from).


##### `model_info_from_slug`  (lines 66–108)

```
fn model_info_from_slug(slug: &str) -> ModelInfo
```

**Purpose**: This function creates a minimal model description when the system only has a model slug, meaning a short model name, and cannot find full metadata for it. It lets the program continue with sensible fallback assumptions instead of stopping because the model is unknown.

**Data flow**: It receives a model slug as text. It logs a warning so operators know fallback metadata is being used. Then it builds a new `ModelInfo` record using the slug as both the internal name and display name, standard base instructions, default input types, conservative capability flags, and a fixed context window. It also asks `local_personality_messages_for_slug` whether this slug should get local personality message templates. The output is a complete `ModelInfo` marked as fallback metadata.

**Call relations**: This function is used in several places that need model metadata even when normal lookup fails, including `construct_model_info_from_candidates`, `remote_model`, and tests around truncation behavior. It hands off to `local_personality_messages_for_slug` to add optional personality instructions for known local slugs, and otherwise returns a plain fallback model description.

*Call graph*: calls 3 internal fn (local_personality_messages_for_slug, bytes, default_input_modalities); called by 5 (model_with_default_service_tier, remote_model, build_stage_one_input_message_truncates_rollout_using_model_context_window, build_stage_one_input_message_uses_default_limit_when_model_context_window_missing, construct_model_info_from_candidates); 2 external calls (new, warn!).


##### `local_personality_messages_for_slug`  (lines 110–124)

```
fn local_personality_messages_for_slug(slug: &str) -> Option<ModelMessages>
```

**Purpose**: This helper decides whether a particular model slug should receive local personality instruction templates. It exists so only selected models get the extra friendly or pragmatic style options.

**Data flow**: It receives a model slug as text. If the slug matches one of the supported personality-enabled model names, it builds a `ModelMessages` value containing an instruction template and named personality text options. The template combines a short identity header, a placeholder where the chosen personality can be inserted, and the main base instructions. If the slug is not recognized for this feature, it returns nothing.

**Call relations**: This helper is called only by `model_info_from_slug`. During fallback model creation, `model_info_from_slug` asks it whether to attach personality-aware messages. The helper supplies those messages for specific slugs and stays out of the way for all others.

*Call graph*: called by 1 (model_info_from_slug); 2 external calls (new, format!).


### `models-manager/src/collaboration_mode_presets.rs`

`config` · `startup and mode listing`

This file is like the menu card for the system’s built-in collaboration styles. A collaboration mode is a named bundle of settings that tells the assistant how to behave: for example, whether it should focus on planning, what reasoning effort to ask for, and what developer instructions to include behind the scenes.

The file creates two presets. The Plan preset uses fixed planning instructions and asks for medium reasoning effort. The Default preset uses a text template. Before that template is given to the assistant, the file fills in the names of the collaboration modes that are visible in the text user interface. This lets the default instructions mention the available modes without hard-coding the list in two places.

A small formatting helper turns mode names into readable text, such as “none”, “Plan”, “Plan and Default”, or a comma-separated list. The default instruction template is parsed only once using a lazy static value, meaning the program waits until it is first needed and then reuses it. If the template cannot be parsed or rendered, the program deliberately stops, because these built-in instructions are expected to be valid at build/runtime and the system cannot safely continue with broken presets.

#### Function details

##### `builtin_collaboration_mode_presets`  (lines 16–18)

```
fn builtin_collaboration_mode_presets() -> Vec<CollaborationModeMask>
```

**Purpose**: Returns the full list of built-in collaboration mode presets. Other parts of the system use this when they need to show or filter the modes that are available by default.

**Data flow**: It takes no input. It creates a fresh list containing the Plan preset and the Default preset, then returns that list to the caller.

**Call relations**: When mode-listing or preset-filtering code needs the built-in choices, it calls this function as the front door for this file. This function gathers the individual preset builders into one list so callers do not need to know how each preset is made.

*Call graph*: called by 4 (builtin_collaboration_mode_presets, list_collaboration_modes, list_collaboration_modes, filtered_presets); 1 external calls (vec!).


##### `plan_preset`  (lines 20–28)

```
fn plan_preset() -> CollaborationModeMask
```

**Purpose**: Builds the built-in “Plan” collaboration mode. This mode gives the assistant planning-focused instructions and asks it to use medium reasoning effort.

**Data flow**: It takes no input. It creates a collaboration mode record with the display name for Plan, marks its kind as Plan, leaves the model unchanged, sets reasoning effort to medium, adds the Plan developer instructions, and returns the completed record.

**Call relations**: This is one of the preset builders used by the top-level preset list. It does not call other local helpers because all of its values are fixed constants or simple enum values.


##### `default_preset`  (lines 30–38)

```
fn default_preset() -> CollaborationModeMask
```

**Purpose**: Builds the normal built-in “Default” collaboration mode. This is the fallback everyday mode, with instructions generated from a template.

**Data flow**: It takes no input. It creates a collaboration mode record with the display name for Default, marks its kind as Default, leaves the model and reasoning effort unchanged, asks `default_mode_instructions` to produce the instruction text, and returns the completed record.

**Call relations**: This function is used when the built-in preset list is assembled. Unlike the Plan preset, it hands off to `default_mode_instructions` because the Default instructions need to include the current list of visible mode names.

*Call graph*: calls 1 internal fn (default_mode_instructions).


##### `default_mode_instructions`  (lines 40–45)

```
fn default_mode_instructions() -> String
```

**Purpose**: Creates the instruction text used by the Default collaboration mode. It fills a template with the names of the modes that users can see in the interface.

**Data flow**: It reads the system’s list of text-interface-visible collaboration modes. It sends that list to `format_mode_names` to turn it into human-readable wording, inserts that wording into the default instruction template, and returns the finished instruction string. If rendering fails, it stops the program because the built-in template is considered invalid.

**Call relations**: This function sits between `default_preset` and the lower-level formatting helper. `default_preset` asks it for ready-to-use instructions, and it relies on `format_mode_names` to prepare the one template value that changes.

*Call graph*: calls 1 internal fn (format_mode_names); called by 1 (default_preset).


##### `format_mode_names`  (lines 47–55)

```
fn format_mode_names(modes: &[ModeKind]) -> String
```

**Purpose**: Turns a list of collaboration mode kinds into readable English text. It exists so template text can say mode names naturally instead of showing a raw list.

**Data flow**: It receives a slice of mode values. It looks up each mode’s display name, then returns a string: “none” for an empty list, the single name for one item, “first and second” for two items, or a comma-separated list for three or more.

**Call relations**: This helper is called by `default_mode_instructions` while preparing the Default mode template. It does not know anything about templates or presets; it only converts mode names into friendly wording.

*Call graph*: called by 1 (default_mode_instructions); 2 external calls (format!, iter).


### `utils/approval-presets/src/lib.rs`

`config` · `config load and permission selection`

This file is a small catalog of permission presets. A preset combines two closely related ideas: what Codex is allowed to do, and when it must ask the user first. For example, one preset lets Codex read files but requires approval before editing anything. Another lets it edit files in the current workspace but still asks before using the internet. A third gives full access and does not ask for approval, which is intentionally marked as risky.

The main data shape is `ApprovalPreset`. It is like a menu item: it has an internal ID, a label for display, a short explanation for users, an approval rule, and the actual permission profile that should be applied. Keeping this here means the text user interface and the MCP server can use the same definitions instead of each inventing its own version.

The file also includes a lookup helper that turns a built-in active permission profile ID back into the concrete permission profile. It only accepts plain built-in profiles, not profiles that extend or customize another one. This keeps the helper predictable: it answers only for the known presets and returns nothing for anything custom or unknown.

#### Function details

##### `builtin_approval_presets`  (lines 28–61)

```
fn builtin_approval_presets() -> Vec<ApprovalPreset>
```

**Purpose**: Returns the standard list of approval and permission presets that users can choose from. This is used wherever the program needs to show or apply the built-in safety modes.

**Data flow**: Nothing is passed in. The function builds a fresh list containing three preset records: read-only, default workspace access, and full access. The result is a vector of `ApprovalPreset` values, ready for a user interface or server code to display or apply.

**Call relations**: When another part of the system needs the preset menu, it calls this function. Inside, the function constructs the list directly and uses the vector-building helper to return all presets together.

*Call graph*: 1 external calls (vec!).


##### `builtin_permission_profile_for_active_permission_profile`  (lines 64–77)

```
fn builtin_permission_profile_for_active_permission_profile(
    active_permission_profile: &ActivePermissionProfile,
) -> Option<PermissionProfile>
```

**Purpose**: Turns a built-in active permission profile identifier into the concrete permission rules it represents. It is useful when the system has stored or received the name of a built-in profile and needs the actual rules behind it.

**Data flow**: It receives an `ActivePermissionProfile`, which contains an ID and may also say it extends another profile. If the profile extends something else, the function refuses to guess and returns `None`. Otherwise, it compares the ID with the known built-in profile IDs and returns the matching permission profile, or `None` if the ID is unknown.

**Call relations**: This function is called when code already has an active profile and needs to resolve it into real permissions. For recognized built-ins, it hands off to the standard constructors for read-only and workspace-write profiles; for the full-access built-in, it returns the disabled permission profile, meaning normal permission restrictions are not applied.

*Call graph*: calls 2 internal fn (read_only, workspace_write).


### `tui/src/model_catalog.rs`

`data_model` · `startup and model selection`

The TUI needs to know which model options are available, for example when showing a model picker or when tests need a predictable set of choices. This file provides that list in the simplest possible form: a ModelCatalog is just a wrapper around a vector, which is a growable list, of ModelPreset values. A ModelPreset comes from the shared protocol code and represents one selectable model configuration.

The catalog is like a printed menu at a restaurant. It does not cook anything or decide what the user should order. It simply stores the menu items and can hand a copy of them to whoever asks.

There are two main actions. First, ModelCatalog::new builds a catalog from a list supplied by some other part of the program. Second, ModelCatalog::try_list_models returns the stored list. The word “try” usually means something might fail, but here the result cannot fail: the error type is Infallible, meaning “there is no possible error.” The method still returns a Result so it can fit the same shape as other catalog sources that might need network access, file access, or other fallible work.

#### Function details

##### `ModelCatalog::new`  (lines 10–12)

```
fn new(models: Vec<ModelPreset>) -> Self
```

**Purpose**: Creates a new catalog from a supplied list of model presets. This is used when the program or a test already knows which models should be available and wants to package them into a reusable catalog object.

**Data flow**: A list of ModelPreset values goes in. The function stores that list inside a new ModelCatalog. The finished ModelCatalog comes out, ready to be kept by the TUI or passed to code that needs to show or inspect model choices.

**Call relations**: This function is called during the main run flow and by several tests that need controlled model lists, such as set_fast_mode_test_catalog, test_model_catalog, model_switch_recomputes_catalog_default_service_tier, and service_tier_commands_lowercase_catalog_names. In each case, it turns a plain list of model presets into the catalog object that later code can ask for model options.

*Call graph*: called by 5 (run, set_fast_mode_test_catalog, test_model_catalog, model_switch_recomputes_catalog_default_service_tier, service_tier_commands_lowercase_catalog_names).


##### `ModelCatalog::try_list_models`  (lines 14–16)

```
fn try_list_models(&self) -> Result<Vec<ModelPreset>, Infallible>
```

**Purpose**: Returns the catalog’s available model presets. It gives callers their own copy of the list so they can read or display it without changing the catalog’s stored version.

**Data flow**: The function reads the ModelCatalog’s internal model list. It clones that list, meaning it makes a separate copy, then wraps it in Ok to say the lookup succeeded. Because the error type is Infallible, this particular catalog cannot report a failure.

**Call relations**: No direct callers are shown in the provided call graph, but this method is the catalog’s read-out point. After ModelCatalog::new has stored the available presets, this function is the piece other code would use when it needs the current list of selectable models.


### `tui/src/update_action.rs`

`domain_logic` · `after TUI exit / update prompt`

Codex can be installed in several different ways, and each one needs a different update command. Someone who installed with npm should not be told to run a Homebrew command, and a standalone Windows install needs a different installer command than a Unix one. This file is the small translation table that keeps those choices straight.

The main type is `UpdateAction`, an enum, which means a fixed list of possible choices. Each choice represents one update route: npm, bun, Homebrew, standalone Unix, or standalone Windows. When Codex can inspect its install context, `from_install_context` converts that context into one of these choices. If the install method is unknown, it returns nothing, so the rest of the program can avoid offering an update command it cannot trust.

Once an action is chosen, `command_args` turns it into the actual program name and argument list to execute. `command_str` formats the same command as readable text for display, quoting it like a shell command when possible. This is like having both the recipe card for the computer to follow and the human-readable version shown to the user.

The file also includes tests that check the install-method mapping and make sure the standalone installer commands stay exactly as expected.

#### Function details

##### `UpdateAction::from_install_context`  (lines 25–36)

```
fn from_install_context(context: &InstallContext) -> Option<Self>
```

**Purpose**: This function looks at how Codex was installed and chooses the matching update action. It is used so the app can suggest or run the right update command instead of guessing.

**Data flow**: It receives an `InstallContext`, which describes the install method. It reads the method field, matches known methods such as npm, bun, Homebrew, or standalone platform, and returns the matching `UpdateAction`. If the method is `Other`, it returns `None`, meaning there is no safe update action to offer.

**Call relations**: When the app wants to know whether an update can be run, `get_update_action` asks the install-context code for the current installation details and then hands them to this function. This function does only the decision step; later code uses the returned action to build or run the command.

*Call graph*: called by 1 (get_update_action).


##### `UpdateAction::command_args`  (lines 39–61)

```
fn command_args(self) -> (&'static str, &'static [&'static str])
```

**Purpose**: This function turns an update action into the exact command and arguments needed to perform that update. It is for code that needs to actually run the update, not just describe it.

**Data flow**: It starts with one `UpdateAction` value. For each possible action, it returns a command name, such as `npm`, `bun`, `brew`, `sh`, or `powershell`, plus a fixed list of arguments. Nothing is changed elsewhere; the output is the command recipe the caller can execute.

**Call relations**: The update runner calls this when it is time to launch the updater. `command_str` also calls it first, then turns the same command pieces into a display string so users can see what will be run.

*Call graph*: called by 2 (run_update_action, command_str).


##### `UpdateAction::command_str`  (lines 64–68)

```
fn command_str(self) -> String
```

**Purpose**: This function makes a human-readable command line from an update action. It is useful for showing the user the update command in prompts or logs.

**Data flow**: It takes an `UpdateAction`, asks `command_args` for the executable and arguments, then joins them into one shell-like string. It tries to quote the pieces safely with `shlex`; if that fails, it falls back to a simpler string made from the command plus the joined arguments.

**Call relations**: Display code such as `render_ref` uses this to show the command, and the update-running flow can also use it when explaining what will happen. It depends on `command_args` so the displayed command and the executed command come from the same source.

*Call graph*: calls 1 internal fn (command_args); called by 2 (run_update_action, render_ref); 2 external calls (try_join, once).


##### `get_update_action`  (lines 72–74)

```
fn get_update_action() -> Option<UpdateAction>
```

**Purpose**: This function asks the system how Codex is currently installed and returns the matching update action, if one is known. It is the simple public doorway for the rest of the release build to ask, “Can we update this install, and how?”

**Data flow**: It calls `InstallContext::current()` to read the current installation information, then passes that information into `UpdateAction::from_install_context`. The result is either a specific update action or `None` if Codex cannot identify a supported update path.

**Call relations**: Higher-level flows such as `run`, `run_update_prompt_if_needed`, and `get_upgrade_version` call this when deciding whether to offer or prepare an update. This function connects the outside install-detection code to this file’s update-action mapping.

*Call graph*: calls 2 internal fn (current, from_install_context); called by 3 (run, run_update_prompt_if_needed, get_upgrade_version).


##### `tests::maps_install_context_to_update_action`  (lines 83–138)

```
fn maps_install_context_to_update_action()
```

**Purpose**: This test verifies that each supported install method maps to the correct update action, and that an unknown install method maps to no action. It protects against accidentally telling users to update with the wrong tool.

**Data flow**: The test builds several sample `InstallContext` values, including npm, bun, Homebrew, standalone Unix, standalone Windows, and an unknown method. For each one, it calls `UpdateAction::from_install_context` and checks that the returned value matches the expected result.

**Call relations**: This test exercises `from_install_context` directly. It does not run during normal app use; it runs in the test suite to make sure the decision table stays correct as install methods evolve.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (assert_eq!, temp_dir).


##### `tests::standalone_update_commands_rerun_latest_installer`  (lines 141–164)

```
fn standalone_update_commands_rerun_latest_installer()
```

**Purpose**: This test checks that the standalone Unix and Windows update actions use the expected installer commands. It matters because standalone updates work by re-running the latest official installer in non-interactive mode.

**Data flow**: The test calls `command_args` on the standalone Unix and Windows actions. It compares the returned command and argument lists with the exact expected shell and PowerShell installer invocations.

**Call relations**: This test exercises `command_args` for the standalone cases. It runs only in the test suite and acts as a guardrail so future edits do not silently break the standalone update path.

*Call graph*: 1 external calls (assert_eq!).


### Built-in pet assets
These files define the built-in pet catalog, acquire and validate cached spritesheets, and load normalized pet manifests from built-in or user-provided sources.

### `tui/src/pets/catalog.rs`

`data_model` · `pet selection and asset loading`

This file is like a small product shelf for the app’s built-in companion pets. Each pet has a short internal ID, a display name, a user-facing description, and the filename of its sprite sheet. A sprite sheet is one image that contains many animation frames laid out in a grid, like a contact sheet of drawings. The constants at the top define the shared size and layout of those sprite sheets, so the rest of the pet system can know how wide, tall, and grid-shaped the animation image should be.

The main data type, `BuiltinPet`, is a simple record for one pet. `BUILTIN_PETS` is the fixed list of pets that ship with the app, such as Codex, Dewey, Fireball, and others. The lookup function `builtin_pet` lets other parts of the program ask, “Do we have a built-in pet with this ID?” and get back the matching record if it exists.

There is also a test-only helper that creates an empty sprite sheet file with the correct dimensions. That lets tests exercise the pet loading code without needing real artwork. Without this catalog, the app would not have a reliable source of truth for which built-in pets exist or which image files should be used for them.

#### Function details

##### `builtin_pet`  (lines 69–71)

```
fn builtin_pet(id: &str) -> Option<BuiltinPet>
```

**Purpose**: Looks up a built-in pet by its internal ID, such as `codex` or `dewey`. Other code uses it to confirm that a requested pet exists and to find the pet’s display text and sprite sheet filename.

**Data flow**: It takes an ID string as input. It scans the fixed `BUILTIN_PETS` list, compares each pet’s `id` to the input, and returns a copy of the matching pet record if one is found. If no pet has that ID, it returns nothing, represented as `None`.

**Call relations**: When code needs to work with a named built-in pet, it calls this function first as the catalog lookup. The public CDN path test uses it to check URL behavior, `ensure_builtin_pack_for_pet` uses it when preparing a built-in pet pack, and `load_with_codex_home` uses it while loading pet-related data from the user’s Codex home setup.

*Call graph*: called by 3 (builtin_pet_url_uses_public_cdn_path, ensure_builtin_pack_for_pet, load_with_codex_home).


##### `write_test_spritesheet`  (lines 74–77)

```
fn write_test_spritesheet(path: &std::path::Path)
```

**Purpose**: Creates a blank sprite sheet image for tests, using the same dimensions expected for real built-in pet artwork. This lets tests create believable pet files without storing or generating actual animations.

**Data flow**: It takes a filesystem path as input. It creates a new transparent RGBA image, meaning an image with red, green, blue, and alpha transparency channels, sized to the full expected sprite sheet width and height. It then saves that image to the given path, changing the test filesystem by writing the file there.

**Call relations**: This helper is only compiled for tests. Test setup functions call it when they need a fake pet asset: `write_test_pack`, `write_pet_manifest`, `write_legacy_avatar`, and `write_pet` use it to put a correctly sized placeholder sprite sheet on disk before exercising the loading and manifest code.

*Call graph*: called by 4 (write_test_pack, write_pet_manifest, write_legacy_avatar, write_pet); 1 external calls (new).


### `tui/src/pets/asset_pack.rs`

`io_transport` · `when a built-in pet asset is needed`

Built-in pets are not shipped as image files inside the TUI package. Instead, this file is the “fetch and verify” layer for those pet images. Its job is narrow but important: by the time it finishes, there should be a valid spritesheet file at a known local path, or a clear error saying the asset is unavailable.

A spritesheet is one image file that contains many animation frames, like a flipbook laid out in a grid. The TUI needs that grid to have exact dimensions. If the file is missing, damaged, too large, downloaded from an unsafe-looking URL, or the wrong size, the pet could fail to load or display incorrectly.

The main flow is: build the cache path, check whether a valid file is already there, and if not, build the CDN URL and download the file with a timeout and size limit. The download is first written to a temporary staging file. Only after the image dimensions are checked is it moved into the final cache location. That staging step is like putting a package on an inspection table before shelving it; it avoids leaving half-written or invalid files where the rest of the app expects safe assets.

The file also includes test-only helpers that create fake valid pet packs so other tests can run without reaching the network.

#### Function details

##### `builtin_spritesheet_path`  (lines 33–35)

```
fn builtin_spritesheet_path(codex_home: &Path, file: &str) -> PathBuf
```

**Purpose**: Builds the local file path where a built-in pet’s spritesheet should live in the cache. Callers use this when they need to read, validate, or test the cached image file.

**Data flow**: It receives the user’s CODEX_HOME directory and a spritesheet filename. It asks `pack_dir` for the versioned pet cache folder, adds the `assets` folder, then adds the filename. The result is a full path to the expected local image file.

**Call relations**: The main download flow in `ensure_builtin_pet` uses this first to decide where the pet image belongs. The test `tests::write_test_pack_installs_all_builtins` also uses it to check that test spritesheets were written in the same place real code would look.

*Call graph*: calls 1 internal fn (pack_dir); called by 2 (ensure_builtin_pet, write_test_pack_installs_all_builtins).


##### `ensure_builtin_pet`  (lines 45–83)

```
fn ensure_builtin_pet(codex_home: &Path, pet: catalog::BuiltinPet) -> Result<()>
```

**Purpose**: Makes sure one built-in pet’s spritesheet is present locally and has the expected image dimensions. If the cached copy is missing or invalid, it downloads a fresh one and installs it safely.

**Data flow**: It starts with CODEX_HOME and a built-in pet record, which includes the spritesheet filename. It turns that into a destination path, checks whether the existing file is valid, and returns immediately if it is. If not, it builds a CDN URL, downloads the bytes with a size limit, creates the cache directory, writes the bytes to a temporary staging file, validates that staging image, and then renames it into the final destination. If the rename has a conflict, it checks whether another valid file appeared in the meantime; otherwise it removes a bad destination and tries the install again. The output is success if a valid local spritesheet exists, or an error if it cannot safely provide one.

**Call relations**: This is the central function called by the higher-level pet-pack flow, `ensure_builtin_pack_for_pet`. It coordinates the helpers in this file: `builtin_spritesheet_path` chooses the target, `builtin_pet_url` prepares the download address, `download_bytes_with_limit` fetches the file, `validate_cached_spritesheet` checks both cached and newly downloaded images, and `install_downloaded_spritesheet` performs the final move into place.

*Call graph*: calls 5 internal fn (builtin_pet_url, builtin_spritesheet_path, download_bytes_with_limit, install_downloaded_spritesheet, validate_cached_spritesheet); called by 1 (ensure_builtin_pack_for_pet); 4 external calls (format!, create_dir_all, remove_file, write).


##### `builtin_pet_url`  (lines 85–89)

```
fn builtin_pet_url(pet: catalog::BuiltinPet) -> Result<String>
```

**Purpose**: Builds the public CDN URL for a built-in pet’s spritesheet. It also checks that the URL uses HTTPS, meaning the download must use an encrypted web connection.

**Data flow**: It receives a built-in pet record and reads its spritesheet filename. It appends that filename to the fixed Codex pet CDN base URL, validates the resulting URL, and returns the URL string if it is acceptable.

**Call relations**: `ensure_builtin_pet` calls this when it needs to download a missing or invalid asset. The test `tests::builtin_pet_url_uses_public_cdn_path` calls it directly to make sure built-in pets point at the intended public CDN path.

*Call graph*: calls 1 internal fn (validate_download_url); called by 2 (ensure_builtin_pet, builtin_pet_url_uses_public_cdn_path); 1 external calls (format!).


##### `pack_dir`  (lines 91–93)

```
fn pack_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the versioned root directory for the built-in pet cache. The version part lets the project change cache layout or assets later without mixing old and new files.

**Data flow**: It receives CODEX_HOME, appends the shared pet cache folder, then appends the current pet pack version. It returns that directory path.

**Call relations**: `builtin_spritesheet_path` uses this as the base for real cached assets. The test helper `write_test_pack` uses the same base so test files mimic the real cache layout.

*Call graph*: called by 2 (builtin_spritesheet_path, write_test_pack); 1 external calls (join).


##### `download_bytes_with_limit`  (lines 95–121)

```
fn download_bytes_with_limit(url: &str, max_bytes: u64) -> Result<Vec<u8>>
```

**Purpose**: Downloads a pet asset from the web while enforcing safety limits. It requires an HTTPS URL, uses a timeout, and refuses files larger than the configured maximum size.

**Data flow**: It receives a URL and a maximum byte count. It validates the URL, creates a blocking HTTP client with a timeout, sends the request, rejects failed HTTP responses, and validates the final response URL too. It checks the server’s declared content length when available, then reads at most one byte more than the allowed size so it can detect oversized downloads even when the server did not declare the size. It returns the downloaded bytes, or an error if the download is unsafe, too large, slow, or unsuccessful.

**Call relations**: `ensure_builtin_pet` calls this only after deciding the local cache cannot be trusted. It hands the returned bytes back to `ensure_builtin_pet`, which writes them to a staging file and validates the image before installing it.

*Call graph*: calls 1 internal fn (validate_download_url); called by 1 (ensure_builtin_pet); 3 external calls (new, builder, bail!).


##### `install_downloaded_spritesheet`  (lines 123–125)

```
fn install_downloaded_spritesheet(staging: &Path, destination: &Path) -> Result<()>
```

**Purpose**: Moves a validated downloaded spritesheet from its temporary staging location into the final cache location. This is the last step that makes the asset visible to the rest of the app.

**Data flow**: It receives two paths: the staging file and the destination file. It renames the staging file to the destination path. On success, the temporary file is gone and the final cached file exists; on failure, it returns an error explaining the failed install.

**Call relations**: `ensure_builtin_pet` calls this after the staging file has passed image validation. If the first install attempt fails, `ensure_builtin_pet` decides whether another valid file already exists or whether it should remove a bad destination and try this install step again.

*Call graph*: called by 1 (ensure_builtin_pet); 1 external calls (rename).


##### `validate_download_url`  (lines 127–133)

```
fn validate_download_url(value: &str) -> Result<()>
```

**Purpose**: Checks that a pet asset download URL is valid and uses HTTPS. This prevents the downloader from accepting unsupported or less safe URL schemes.

**Data flow**: It receives a URL string, parses it as a URL, then inspects its scheme, which is the part like `https` at the front. If the URL cannot be parsed or does not use HTTPS, it returns an error. If it passes, it returns success without changing anything.

**Call relations**: `builtin_pet_url` uses this to check URLs built from the project’s CDN base and pet filename. `download_bytes_with_limit` uses it before making the request and again on the final response URL, so redirects cannot silently move the download to a non-HTTPS address.

*Call graph*: called by 2 (builtin_pet_url, download_bytes_with_limit); 2 external calls (parse, bail!).


##### `validate_cached_spritesheet`  (lines 135–149)

```
fn validate_cached_spritesheet(path: &Path) -> Result<()>
```

**Purpose**: Checks whether a spritesheet file is structurally usable by reading its image dimensions. It makes sure the file is exactly the width and height the pet renderer expects.

**Data flow**: It receives a file path. It asks the image library to read the image dimensions from that file. If the width and height match the catalog’s expected spritesheet size, it returns success. If the file cannot be read or the dimensions are wrong, it returns an error that describes the problem.

**Call relations**: `ensure_builtin_pet` uses this several times: first to trust an existing cache file, then to inspect the staging file after download, and later to see whether a valid destination file already appeared after an install conflict. The test `tests::write_test_pack_installs_all_builtins` uses it to confirm that test-generated spritesheets are valid.

*Call graph*: called by 2 (ensure_builtin_pet, write_test_pack_installs_all_builtins); 2 external calls (bail!, image_dimensions).


##### `write_test_pack`  (lines 152–159)

```
fn write_test_pack(codex_home: &Path)
```

**Purpose**: Creates a complete fake built-in pet asset pack for tests. This lets tests use the normal cache paths without downloading real files from the network.

**Data flow**: It receives a CODEX_HOME-like directory for a test. It builds the versioned assets directory, creates it, then loops over every built-in pet from the catalog and writes a test spritesheet file with the right filename. It changes the filesystem by creating directories and image files, and returns nothing.

**Call relations**: The test `tests::write_test_pack_installs_all_builtins` calls this to verify the helper creates all expected files. Another test elsewhere, `load_builtin_pet_uses_app_catalog_storage`, also calls it so pet-loading code can run against a realistic local cache.

*Call graph*: calls 2 internal fn (pack_dir, write_test_spritesheet); called by 2 (write_test_pack_installs_all_builtins, load_builtin_pet_uses_app_catalog_storage); 1 external calls (create_dir_all).


##### `tests::builtin_pet_url_uses_public_cdn_path`  (lines 167–176)

```
fn builtin_pet_url_uses_public_cdn_path()
```

**Purpose**: Checks that the URL builder points a known built-in pet at the expected public CDN address. This guards against accidental changes to the CDN path format.

**Data flow**: It looks up the built-in pet named `dewey`, passes that pet to `builtin_pet_url`, and compares the returned string with the exact expected URL. The test passes if they match and fails if the URL changes.

**Call relations**: This test exercises `builtin_pet_url` directly. It also uses the catalog lookup for a real built-in pet so the check reflects the actual pet metadata used by the app.

*Call graph*: calls 2 internal fn (builtin_pet_url, builtin_pet); 1 external calls (assert_eq!).


##### `tests::write_test_pack_installs_all_builtins`  (lines 179–189)

```
fn write_test_pack_installs_all_builtins()
```

**Purpose**: Checks that the test pack helper writes every built-in pet spritesheet into the right cache location and that each file looks valid. This keeps the test fixture aligned with the real cache rules.

**Data flow**: It creates a temporary directory, asks `write_test_pack` to fill it with built-in pet assets, then loops over every built-in pet. For each one, it builds the expected path with `builtin_spritesheet_path`, checks that a file exists there, and validates the image dimensions with `validate_cached_spritesheet`.

**Call relations**: This test ties together the test helper and the real path and validation helpers. By using `write_test_pack`, `builtin_spritesheet_path`, and `validate_cached_spritesheet` together, it confirms that test-created assets are placed where production code expects them and meet the same shape requirements.

*Call graph*: calls 3 internal fn (builtin_spritesheet_path, validate_cached_spritesheet, write_test_pack); 2 external calls (assert!, tempdir).


### `tui/src/pets/model.rs`

`domain_logic` · `pet selection and loading, before rendering`

This file is the pet loader and normalizer. A user or test can refer to a pet in several ways: by a built-in catalog id, by `custom:<id>`, by an older avatar folder, or by a direct filesystem path. This module turns all of those into one clear in-memory shape: a `Pet` with a real spritesheet file, frame size, grid layout, and named animations.

The important promise is safety and consistency. By the time loading succeeds, the spritesheet exists, has the exact app-supported image size, and its frame grid covers the image exactly. This is like checking that a strip of film has the right number of frames before putting it in the projector. Without these checks, later drawing code could read the wrong image area, crash on missing files, or cache frames under the wrong identity.

The file supports built-in pets using catalog defaults, custom pets through `pet.json`, and legacy avatars through `avatar.json`. It also limits custom animation speed and frame counts so a bad manifest cannot create unreasonable work. For custom manifests, spritesheet paths must stay inside the pet folder, which prevents one pet definition from pointing at unrelated local files. The tests at the bottom document the expected defaults and many failure cases.

#### Function details

##### `Animation::total_duration`  (lines 46–51)

```
fn total_duration(&self) -> Duration
```

**Purpose**: Adds up how long all frames in one animation last. The renderer can use this to know where a repeating animation cycle begins or ends in time.

**Data flow**: It reads the animation's list of frames, takes each frame's duration, adds those durations together, and returns one total time value. It does not change the animation.

**Call relations**: When `current_animation_frame` needs to pick the right frame for the current moment, it calls this helper to understand the full length of the animation timeline.

*Call graph*: called by 1 (current_animation_frame).


##### `Pet::load_with_codex_home`  (lines 82–96)

```
fn load_with_codex_home(value: &str, codex_home: Option<&Path>) -> Result<Self>
```

**Purpose**: Loads a pet from the user's selector text. It decides whether the text means a path, a custom pet, a built-in catalog pet, or a plain custom id.

**Data flow**: It receives the selector string and an optional `CODEX_HOME` folder. It first checks if the selector looks like a filesystem path, then checks for the `custom:` prefix, then checks the built-in catalog, and finally treats the value as a custom id. It returns a fully validated `Pet` or an error explaining what could not be loaded.

**Call relations**: This is the main doorway into this file. Tests and higher-level loading code call it, and it delegates to `load_pet_path`, `load_custom_pet`, or `load_builtin_pet` depending on what kind of selector it sees.

*Call graph*: calls 5 internal fn (builtin_pet, load_builtin_pet, load_custom_pet, load_pet_path, path_like); called by 9 (load, custom_pet_rejects_spritesheet_path_escape, custom_pet_selector_falls_back_to_legacy_avatar_manifest, custom_pet_selector_loads_codex_home_pet_manifest, load_builtin_pet_uses_app_catalog_storage, load_pet_error_from_dir, load_pet_from_dir, load_pet_json_path_uses_containing_directory, custom_pet_entries).


##### `Pet::frame_count`  (lines 98–100)

```
fn frame_count(&self) -> usize
```

**Purpose**: Returns how many sprite frames this pet has. Drawing code uses this to know the valid range of frame numbers.

**Data flow**: It reads the already computed `frame_count` field from the `Pet` and returns it unchanged.

**Call relations**: Frame preparation code such as `prepare_png_frames` calls this when it needs to split a spritesheet into individual cached frames.

*Call graph*: called by 1 (prepare_png_frames).


##### `Pet::frame_cache_key`  (lines 102–110)

```
fn frame_cache_key(&self) -> Result<String>
```

**Purpose**: Builds a stable cache name for this pet's decoded frames. It changes when the spritesheet image or frame layout changes, so stale cached frames are not reused by mistake.

**Data flow**: It reads the spritesheet bytes from disk, hashes them with SHA-256, then combines that hash with the frame width, frame height, column count, and row count. It returns a string such as a content fingerprint, or an error if the file cannot be read.

**Call relations**: Code that caches rendered frames can call this after a `Pet` has been loaded. The tests check that changing image contents or frame layout changes the resulting key.

*Call graph*: 3 external calls (digest, format!, read).


##### `FrameSpec::default`  (lines 139–146)

```
fn default() -> Self
```

**Purpose**: Provides the app's standard frame layout when a pet manifest does not specify one. This keeps simple custom pets from having to repeat the normal dimensions.

**Data flow**: It reads default frame constants from the catalog and returns a `FrameSpec` containing the standard width, height, column count, and row count.

**Call relations**: Manifest loading uses this default inside `load_pet_manifest` when the JSON file leaves out the `frame` section.


##### `custom_pet_selector`  (lines 149–151)

```
fn custom_pet_selector(id: &str) -> String
```

**Purpose**: Turns a custom pet id into the selector format used by the loader. For example, it makes the explicit form that starts with `custom:`.

**Data flow**: It receives a plain id string, prefixes it with the custom pet marker, and returns the combined selector string.

**Call relations**: Tests and custom pet listing code use this to produce selector text that `Pet::load_with_codex_home` will route to `load_custom_pet`.

*Call graph*: called by 4 (custom_pet_rejects_spritesheet_path_escape, custom_pet_selector_falls_back_to_legacy_avatar_manifest, custom_pet_selector_loads_codex_home_pet_manifest, custom_pet_entries); 1 external calls (format!).


##### `load_builtin_pet`  (lines 164–183)

```
fn load_builtin_pet(pet: catalog::BuiltinPet, codex_home: Option<&Path>) -> Result<Pet>
```

**Purpose**: Creates a `Pet` for one of the built-in catalog pets. It assumes the built-in spritesheet has already been downloaded or installed under `CODEX_HOME`.

**Data flow**: It receives a catalog pet record and the `CODEX_HOME` path. It builds the expected spritesheet location, checks that the file exists, then returns a `Pet` filled with catalog names, descriptions, standard frame settings, and default animations.

**Call relations**: `Pet::load_with_codex_home` calls this after `catalog::builtin_pet` recognizes the selector as built-in. It relies on `default_frame_count` and `default_animations` to match the app's standard spritesheet layout.

*Call graph*: calls 2 internal fn (default_animations, default_frame_count); called by 1 (load_with_codex_home); 2 external calls (bail!, builtin_spritesheet_path).


##### `load_custom_pet`  (lines 185–203)

```
fn load_custom_pet(value: &str, codex_home: Option<&Path>) -> Result<Pet>
```

**Purpose**: Loads a user-created pet from the app's home folder. It also supports the older avatar folder layout for backward compatibility.

**Data flow**: It receives a custom id and `CODEX_HOME`. It looks first in `CODEX_HOME/pets/<id>/pet.json`, then in `CODEX_HOME/avatars/<id>/avatar.json`. If it finds a manifest, it passes the folder to `load_pet_manifest`; otherwise it returns an unknown-pet error.

**Call relations**: `Pet::load_with_codex_home` calls this for `custom:<id>` selectors and for plain ids that are not built-ins. It uses `custom_pet_cache_id` so custom pets get cache ids distinct from built-in or path-loaded pets.

*Call graph*: calls 2 internal fn (custom_pet_cache_id, load_pet_manifest); called by 1 (load_with_codex_home); 1 external calls (bail!).


##### `load_pet_path`  (lines 205–230)

```
fn load_pet_path(value: &str) -> Result<Pet>
```

**Purpose**: Loads a pet from an explicit file or directory path. This is useful for tests and for local pet development outside the normal app home folder.

**Data flow**: It expands `~` if needed, checks whether the path is a directory or a file, uses the containing directory when given a manifest file, canonicalizes the directory, chooses `pet.json` or `avatar.json`, and then calls `load_pet_manifest`. It returns a validated `Pet` or an error if the path is invalid.

**Call relations**: `Pet::load_with_codex_home` calls this whenever the selector looks path-like. It hands the actual parsing and validation work to `load_pet_manifest`.

*Call graph*: calls 2 internal fn (expand_path, load_pet_manifest); called by 1 (load_with_codex_home); 2 external calls (bail!, metadata).


##### `load_pet_manifest`  (lines 232–294)

```
fn load_pet_manifest(
    pet_dir: &Path,
    manifest_file: &str,
    fallback_id: &str,
    cache_id: &str,
) -> Result<Pet>
```

**Purpose**: Reads and validates a pet manifest file. This is where custom pet JSON becomes the normalized `Pet` object used by the rest of the app.

**Data flow**: It receives a pet directory, manifest filename, fallback id, and cache id. It reads the JSON, chooses an id and display name, resolves the spritesheet path safely, checks that the image exists and has the right size, validates the frame grid, loads animations, and returns a complete `Pet`.

**Call relations**: Both `load_custom_pet` and `load_pet_path` call this after they have found a manifest location. It coordinates the detailed helpers for path safety, image size checking, frame checking, and animation checking.

*Call graph*: calls 4 internal fn (load_animations, resolve_spritesheet_path, validate_app_spritesheet_dimensions, validate_frame_spec); called by 2 (load_custom_pet, load_pet_path); 4 external calls (join, bail!, read_to_string, from_str).


##### `resolve_spritesheet_path`  (lines 302–312)

```
fn resolve_spritesheet_path(pet_dir: &Path, spritesheet_path: &str) -> Result<PathBuf>
```

**Purpose**: Turns the manifest's spritesheet path into a real path while keeping it inside the pet folder. This prevents a pet file from reaching outside its own directory.

**Data flow**: It receives the pet directory and the path written in the manifest. If the path is absolute, uses `..`, or has a platform prefix, it returns an error. Otherwise it joins the path onto the pet directory and returns it.

**Call relations**: `load_pet_manifest` calls this before checking the spritesheet file. It is the security gate that stops path escape tricks.

*Call graph*: called by 1 (load_pet_manifest); 3 external calls (join, new, bail!).


##### `validate_app_spritesheet_dimensions`  (lines 314–325)

```
fn validate_app_spritesheet_dimensions(path: &Path) -> Result<(u32, u32)>
```

**Purpose**: Checks that the spritesheet image has the exact pixel size the app supports. This keeps the later frame-splitting code simple and predictable.

**Data flow**: It receives an image path, reads the image dimensions, compares them with the catalog's required spritesheet width and height, and returns those dimensions if they match. If they do not match, it returns an error.

**Call relations**: `load_pet_manifest` calls this before validating the frame grid. The result becomes the real image size used by `validate_frame_spec`.

*Call graph*: called by 1 (load_pet_manifest); 2 external calls (bail!, image_dimensions).


##### `validate_frame_spec`  (lines 327–359)

```
fn validate_frame_spec(
    frame: &FrameSpec,
    spritesheet_width: u32,
    spritesheet_height: u32,
) -> Result<usize>
```

**Purpose**: Checks that the declared frame size and grid are usable. It makes sure the frames cover the whole spritesheet exactly and do not exceed the app's maximum count.

**Data flow**: It receives a frame specification and the spritesheet's width and height. It rejects zero values, arithmetic overflow, mismatched total grid size, and too many frames. On success, it returns the calculated frame count.

**Call relations**: `load_pet_manifest` calls this after reading the image size. Its returned frame count is then used to validate animation frame references.

*Call graph*: called by 1 (load_pet_manifest); 2 external calls (bail!, try_from).


##### `custom_pet_cache_id`  (lines 361–363)

```
fn custom_pet_cache_id(id: &str) -> String
```

**Purpose**: Creates the internal cache id for a custom pet. The prefix keeps custom pets from colliding with other pet ids.

**Data flow**: It receives a custom id string, prefixes it with `custom-`, and returns the new string.

**Call relations**: `load_custom_pet` uses this before calling `load_pet_manifest`, so the loaded `Pet` gets a cache-safe id.

*Call graph*: called by 1 (load_custom_pet); 1 external calls (format!).


##### `path_like`  (lines 365–374)

```
fn path_like(value: &str) -> bool
```

**Purpose**: Decides whether a selector looks like a filesystem path rather than a pet id. This lets users pass local folders or manifest files directly.

**Data flow**: It receives the selector text and checks for path signs such as `.`, `..`, `~/`, slashes, backslashes, or an absolute path. It returns true if the selector should be treated as a path.

**Call relations**: `Pet::load_with_codex_home` calls this first, before trying custom or built-in ids, so explicit paths are not confused with pet names.

*Call graph*: called by 1 (load_with_codex_home); 1 external calls (new).


##### `expand_path`  (lines 376–386)

```
fn expand_path(value: &str) -> Result<PathBuf>
```

**Purpose**: Expands a leading `~` into the user's home directory. This supports familiar shell-style paths such as `~/my-pet`.

**Data flow**: It receives a path string. If it is `~` or starts with `~/`, it reads the `HOME` environment variable and builds the expanded path. Otherwise it returns the path as written.

**Call relations**: `load_pet_path` calls this before checking the path on disk.

*Call graph*: called by 1 (load_pet_path); 2 external calls (from, var_os).


##### `load_animations`  (lines 388–452)

```
fn load_animations(
    specs: HashMap<String, AnimationSpec>,
    frame_count: usize,
) -> Result<HashMap<String, Animation>>
```

**Purpose**: Builds the final animation map for a pet. It starts with the app's defaults, then applies any custom animations from the manifest.

**Data flow**: It receives animation specs from JSON and the pet's total frame count. For each custom animation it checks that frames exist, checks that frames are in range, chooses a safe frames-per-second value, converts speed into per-frame duration, sets looping and fallback behavior, and stores the result. It returns a validated map of named animations.

**Call relations**: `load_pet_manifest` calls this after it knows the frame count. It uses `default_animations` as a baseline and `validate_animation_indices` as the final consistency check.

*Call graph*: calls 2 internal fn (default_animations, validate_animation_indices); called by 2 (load_pet_manifest, custom_animation_specs_keep_manifest_fps_and_loop_shape); 2 external calls (from_secs_f64, bail!).


##### `validate_animation_indices`  (lines 454–478)

```
fn validate_animation_indices(
    animations: &HashMap<String, Animation>,
    frame_count: usize,
) -> Result<()>
```

**Purpose**: Checks that every animation is internally safe. It catches empty animations, frame numbers outside the spritesheet, and fallbacks that point to missing animation names.

**Data flow**: It receives the completed animation map and the pet's frame count. It walks every animation and every frame reference, returning success only if all frame indexes and fallback names are valid.

**Call relations**: `load_animations` calls this both for all-default animations and after custom specs have been merged in.

*Call graph*: called by 1 (load_animations); 1 external calls (bail!).


##### `default_frame_count`  (lines 480–482)

```
fn default_frame_count() -> usize
```

**Purpose**: Returns the number of frames in the app's standard spritesheet layout. Built-in pets use this standard count.

**Data flow**: It multiplies the catalog's default column count by the default row count and returns the result as a number of frames.

**Call relations**: `load_builtin_pet` uses this for built-in pets, and tests use it when checking custom animation loading against the default layout.

*Call graph*: called by 2 (load_builtin_pet, custom_animation_specs_keep_manifest_fps_and_loop_shape).


##### `default_animations`  (lines 484–582)

```
fn default_animations() -> HashMap<String, Animation>
```

**Purpose**: Creates the app's built-in set of named pet animations. These include idle, movement, status, and older alias names.

**Data flow**: It constructs a map from animation names to `Animation` values. It uses `idle_animation` for the calm loop and `app_state_animation` for animations based on particular spritesheet rows.

**Call relations**: Built-in pet loading uses this directly. Custom animation loading starts from this map and then replaces or adds entries from the manifest.

*Call graph*: calls 2 internal fn (app_state_animation, idle_animation); called by 5 (load_animations, load_builtin_pet, app_idle_animation_uses_calm_loop, app_notification_states_use_expected_rows, app_running_animation_repeats_then_settles_into_idle).


##### `idle_animation`  (lines 584–596)

```
fn idle_animation() -> Animation
```

**Purpose**: Defines the default calm idle animation. This is the resting behavior that many other animations fall back to.

**Data flow**: It creates a fixed list of sprite indexes and millisecond durations, marks the animation as looping from the start, and sets its fallback to itself.

**Call relations**: `default_animations` includes it as `idle`, and `app_state_animation` appends its frames so one-shot app-state animations can settle back into idle.

*Call graph*: called by 2 (app_state_animation, default_animations).


##### `app_state_animation`  (lines 598–627)

```
fn app_state_animation(
    row_index: usize,
    frame_count: usize,
    frame_duration_ms: u64,
    final_frame_duration_ms: u64,
) -> Animation
```

**Purpose**: Builds a standard animation from one row of the default spritesheet. It plays the active motion a few times, then transitions into idle.

**Data flow**: It receives a row number, number of frames, normal frame duration, and final-frame duration. It turns that row into sprite indexes, repeats the primary sequence three times, appends idle frames, and returns an animation whose loop begins at the idle part.

**Call relations**: `default_animations` calls this for running, waving, jumping, waiting, review, failed, and legacy alias animations.

*Call graph*: calls 1 internal fn (idle_animation); called by 1 (default_animations).


##### `tests::write_minimal_pet`  (lines 633–642)

```
fn write_minimal_pet() -> tempfile::TempDir
```

**Purpose**: Creates a temporary pet folder with a simple valid manifest. Tests use it when they need a normal custom pet without repeating setup code.

**Data flow**: It supplies a small JSON manifest with id, display name, description, and spritesheet path, then delegates to the test manifest writer. It returns the temporary directory.

**Call relations**: Many tests call this before loading a pet through `load_pet_from_dir` or `Pet::load_with_codex_home`.

*Call graph*: 1 external calls (write_pet_manifest).


##### `tests::write_pet_manifest`  (lines 644–649)

```
fn write_pet_manifest(manifest: &str) -> tempfile::TempDir
```

**Purpose**: Writes a test pet manifest and a matching test spritesheet into a temporary folder. This gives tests realistic files on disk.

**Data flow**: It creates a temporary directory, writes `pet.json` with the provided text, writes a valid test spritesheet image, and returns the directory.

**Call relations**: Test helpers and validation tests use this to create both valid and intentionally invalid manifests.

*Call graph*: calls 1 internal fn (write_test_spritesheet); 2 external calls (write, tempdir).


##### `tests::load_pet_from_dir`  (lines 651–653)

```
fn load_pet_from_dir(dir: &tempfile::TempDir) -> Pet
```

**Purpose**: Loads a pet from a temporary directory and expects success. It keeps successful-load tests short.

**Data flow**: It takes a temporary directory, converts its path to text, calls `Pet::load_with_codex_home` with no app home folder, unwraps the successful result, and returns the `Pet`.

**Call relations**: Tests that verify valid manifests and cache-key behavior call this helper.

*Call graph*: calls 1 internal fn (load_with_codex_home); 1 external calls (path).


##### `tests::load_pet_error_from_dir`  (lines 655–657)

```
fn load_pet_error_from_dir(dir: &tempfile::TempDir) -> anyhow::Error
```

**Purpose**: Attempts to load a pet from a temporary directory and expects failure. It keeps rejection tests focused on the error being checked.

**Data flow**: It takes a temporary directory, passes its path to `Pet::load_with_codex_home`, unwraps the error, and returns that error.

**Call relations**: Validation tests call this after writing bad manifests, then inspect the error message.

*Call graph*: calls 1 internal fn (load_with_codex_home); 1 external calls (path).


##### `tests::load_builtin_pet_uses_app_catalog_storage`  (lines 660–678)

```
fn load_builtin_pet_uses_app_catalog_storage()
```

**Purpose**: Checks that a built-in pet loads from the app's catalog storage and receives the expected metadata and frame layout.

**Data flow**: It creates a temporary app home, writes a test built-in asset pack, loads the built-in pet `dewey`, and compares the resulting id, display name, description, spritesheet path, and frame settings with expected values.

**Call relations**: This test exercises `Pet::load_with_codex_home`, which routes to `load_builtin_pet`.

*Call graph*: calls 2 internal fn (write_test_pack, load_with_codex_home); 2 external calls (assert_eq!, tempdir).


##### `tests::app_idle_animation_uses_calm_loop`  (lines 681–688)

```
fn app_idle_animation_uses_calm_loop()
```

**Purpose**: Checks that the default idle animation uses the expected sprite order, timing, and loop start.

**Data flow**: It builds default animations, selects `idle`, and compares its sprite indexes, durations, and loop setting against fixed expected values.

**Call relations**: This test documents the behavior of `default_animations` and `idle_animation`.

*Call graph*: calls 1 internal fn (default_animations); 1 external calls (assert_eq!).


##### `tests::app_running_animation_repeats_then_settles_into_idle`  (lines 691–708)

```
fn app_running_animation_repeats_then_settles_into_idle()
```

**Purpose**: Checks that the running animation plays its motion several times and then settles into idle. This confirms the intended transition shape.

**Data flow**: It builds default animations, inspects the `running` animation, verifies that its primary frames repeat three times, verifies that idle frames follow, and checks the timing and loop point.

**Call relations**: This test covers `default_animations`, especially the `app_state_animation` pattern.

*Call graph*: calls 1 internal fn (default_animations); 2 external calls (assert_eq!, vec!).


##### `tests::app_notification_states_use_expected_rows`  (lines 711–726)

```
fn app_notification_states_use_expected_rows()
```

**Purpose**: Checks that notification-related animations use the intended rows of the spritesheet. This guards against accidentally moving status animations to the wrong sprites.

**Data flow**: It builds default animations and compares the first frame indexes for `waiting`, `review`, and `failed` with the expected row-based indexes.

**Call relations**: This test verifies the row choices made inside `default_animations` through `app_state_animation`.

*Call graph*: calls 1 internal fn (default_animations); 1 external calls (assert_eq!).


##### `tests::custom_animation_specs_keep_manifest_fps_and_loop_shape`  (lines 729–749)

```
fn custom_animation_specs_keep_manifest_fps_and_loop_shape()
```

**Purpose**: Checks that custom animation settings from a manifest are preserved. In particular, it verifies speed, non-looping behavior, and fallback name.

**Data flow**: It creates one custom animation spec with frames, frames-per-second, no loop, and idle fallback. It loads animations and checks the resulting frame indexes, durations, loop setting, and fallback.

**Call relations**: This test calls `load_animations` directly and uses `default_frame_count` to provide a valid frame range.

*Call graph*: calls 2 internal fn (default_frame_count, load_animations); 3 external calls (from, assert_eq!, vec!).


##### `tests::load_pet_directory_uses_app_pet_manifest_defaults`  (lines 752–765)

```
fn load_pet_directory_uses_app_pet_manifest_defaults()
```

**Purpose**: Checks that a simple custom pet directory loads correctly using default frame and animation settings. This proves minimal manifests are enough.

**Data flow**: It writes a minimal pet folder, loads it, and compares id, display name, frame settings, frame count, and existence of idle animation with expected defaults.

**Call relations**: This test goes through `load_pet_from_dir`, which calls `Pet::load_with_codex_home` and then the path-based manifest loader.

*Call graph*: 4 external calls (assert!, assert_eq!, load_pet_from_dir, write_minimal_pet).


##### `tests::frame_cache_key_changes_with_spritesheet_contents`  (lines 768–783)

```
fn frame_cache_key_changes_with_spritesheet_contents()
```

**Purpose**: Checks that the frame cache key changes when the image file changes. This prevents stale decoded frames from being reused after image edits.

**Data flow**: It writes and loads a minimal pet, records its cache key, overwrites the spritesheet with a different image, reloads the pet, and asserts that the new cache key is different.

**Call relations**: This test exercises `Pet::frame_cache_key` after loading pets through the normal path flow.

*Call graph*: 5 external calls (assert_ne!, Rgba, from_pixel, load_pet_from_dir, write_minimal_pet).


##### `tests::frame_cache_key_changes_with_frame_spec`  (lines 786–802)

```
fn frame_cache_key_changes_with_frame_spec()
```

**Purpose**: Checks that the frame cache key changes when the same spritesheet is interpreted with a different frame grid. This matters because different grids produce different cut-out frames.

**Data flow**: It loads one pet with the default frame layout and another with a custom frame layout, then compares their cache keys and expects them to differ.

**Call relations**: This test uses `write_minimal_pet`, `write_pet_manifest`, `load_pet_from_dir`, and `Pet::frame_cache_key`.

*Call graph*: 4 external calls (assert_ne!, load_pet_from_dir, write_minimal_pet, write_pet_manifest).


##### `tests::load_pet_json_path_uses_containing_directory`  (lines 805–816)

```
fn load_pet_json_path_uses_containing_directory()
```

**Purpose**: Checks that passing a direct `pet.json` path loads assets relative to that file's folder. This supports convenient local testing.

**Data flow**: It writes a minimal pet, passes the path to its `pet.json` into `Pet::load_with_codex_home`, and confirms the resolved spritesheet path is the canonical file beside that manifest.

**Call relations**: This test exercises the path branch of `Pet::load_with_codex_home` and the directory selection inside `load_pet_path`.

*Call graph*: calls 1 internal fn (load_with_codex_home); 2 external calls (assert_eq!, write_minimal_pet).


##### `tests::custom_pet_selector_loads_codex_home_pet_manifest`  (lines 819–839)

```
fn custom_pet_selector_loads_codex_home_pet_manifest()
```

**Purpose**: Checks that a `custom:<id>` selector loads a pet from `CODEX_HOME/pets/<id>`. It also verifies the internal custom cache id.

**Data flow**: It creates a temporary app home, copies a valid manifest and spritesheet into the custom pets folder, loads with `custom_pet_selector`, and checks the pet id and spritesheet path.

**Call relations**: This test covers `custom_pet_selector`, `Pet::load_with_codex_home`, `load_custom_pet`, and `load_pet_manifest` working together.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); 5 external calls (assert_eq!, copy, create_dir_all, tempdir, write_minimal_pet).


##### `tests::custom_pet_selector_falls_back_to_legacy_avatar_manifest`  (lines 842–862)

```
fn custom_pet_selector_falls_back_to_legacy_avatar_manifest()
```

**Purpose**: Checks that old avatar folders still load as custom pets. This protects users who have older local pet data.

**Data flow**: It creates `CODEX_HOME/avatars/<id>/avatar.json` with a valid spritesheet, loads using a `custom:<id>` selector, and verifies the custom id and display name.

**Call relations**: This test exercises the legacy fallback branch in `load_custom_pet`.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); 5 external calls (assert_eq!, copy, create_dir_all, tempdir, write_minimal_pet).


##### `tests::custom_pet_rejects_spritesheet_path_escape`  (lines 865–888)

```
fn custom_pet_rejects_spritesheet_path_escape()
```

**Purpose**: Checks that a custom manifest cannot point its spritesheet outside the pet directory. This is an important local-file safety rule.

**Data flow**: It writes a manifest whose spritesheet path uses `..`, tries to load it as a custom pet, and asserts that the error says the path must stay inside the pet folder.

**Call relations**: This test reaches `resolve_spritesheet_path` through `Pet::load_with_codex_home` and `load_custom_pet`.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `tests::custom_pet_rejects_zero_frame_dimensions`  (lines 891–906)

```
fn custom_pet_rejects_zero_frame_dimensions()
```

**Purpose**: Checks that frame width, height, columns, and rows cannot be zero. Zero values would make the spritesheet impossible to split sensibly.

**Data flow**: It writes a manifest with a zero frame width, loads expecting an error, and confirms the error mentions non-zero frame dimensions and grid counts.

**Call relations**: This test exercises `validate_frame_spec` through the normal manifest loading path.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_frame_grid_that_does_not_cover_spritesheet`  (lines 909–924)

```
fn custom_pet_rejects_frame_grid_that_does_not_cover_spritesheet()
```

**Purpose**: Checks that the declared frame grid must exactly cover the spritesheet. A partial grid would make frame indexes ambiguous or wrong.

**Data flow**: It writes a manifest whose columns do not span the full image width, loads expecting an error, and confirms the error mentions exact coverage.

**Call relations**: This test reaches `validate_frame_spec` after `validate_app_spritesheet_dimensions` succeeds.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_excessive_frame_count`  (lines 927–939)

```
fn custom_pet_rejects_excessive_frame_count()
```

**Purpose**: Checks that a pet cannot declare an unreasonably large number of frames. This protects the app from excessive memory or processing work.

**Data flow**: It writes a manifest with a very dense frame grid, loads expecting an error, and confirms the error mentions the maximum frame count.

**Call relations**: This test covers the frame-count limit enforced by `validate_frame_spec`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_empty_animation_frames`  (lines 942–959)

```
fn custom_pet_rejects_empty_animation_frames()
```

**Purpose**: Checks that every custom animation must contain at least one frame. An animation with no frames could not be displayed.

**Data flow**: It writes a manifest where `idle` has an empty frame list, loads expecting an error, and checks the message.

**Call relations**: This test exercises the empty-frame validation inside `load_animations`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_animation_frame_outside_grid`  (lines 962–979)

```
fn custom_pet_rejects_animation_frame_outside_grid()
```

**Purpose**: Checks that animations cannot refer to frame numbers beyond the pet's frame grid. This prevents drawing from outside the spritesheet.

**Data flow**: It writes a manifest where `idle` refers to frame 72 in a 72-frame zero-based grid, loads expecting an error, and checks the message.

**Call relations**: This test covers frame reference validation in `load_animations` and `validate_animation_indices`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_invalid_animation_fps`  (lines 982–999)

```
fn custom_pet_rejects_invalid_animation_fps()
```

**Purpose**: Checks that custom animation speed must stay within the allowed range. This prevents impossible, infinite, or too-fast animation timing.

**Data flow**: It writes a manifest with `fps` set above the maximum, loads expecting an error, and checks that the message mentions the allowed range.

**Call relations**: This test exercises the frames-per-second validation inside `load_animations`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::custom_pet_rejects_animation_fallback_to_missing_animation`  (lines 1002–1019)

```
fn custom_pet_rejects_animation_fallback_to_missing_animation()
```

**Purpose**: Checks that an animation's fallback must name an existing animation. A missing fallback would leave non-looping animations with nowhere to go.

**Data flow**: It writes a manifest with a `wave` animation whose fallback is `missing`, loads expecting an error, and checks that the missing fallback is reported.

**Call relations**: This test reaches `validate_animation_indices` through `load_animations`.

*Call graph*: 3 external calls (assert!, load_pet_error_from_dir, write_pet_manifest).


##### `tests::sprite_indices`  (lines 1021–1027)

```
fn sprite_indices(animation: &Animation) -> Vec<usize>
```

**Purpose**: Extracts just the sprite numbers from an animation for easy test comparisons. It keeps test assertions readable.

**Data flow**: It receives an animation, walks its frames, collects each frame's `sprite_index`, and returns the list of indexes.

**Call relations**: Several animation tests call this helper after building `default_animations` or custom animations.


##### `tests::durations_ms`  (lines 1029–1035)

```
fn durations_ms(animation: &Animation) -> Vec<u128>
```

**Purpose**: Extracts frame durations in milliseconds from an animation for easy test comparisons. This avoids repeating conversion code in each test.

**Data flow**: It receives an animation, walks its frames, converts each duration to milliseconds, and returns the list of millisecond values.

**Call relations**: Animation timing tests call this helper when checking idle, running, and custom animation durations.
