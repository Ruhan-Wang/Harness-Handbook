# App-server unit tests and shared integration fixtures  `stage-23.1.3`

This stage is shared test support for the app server. It is not part of the running product path; it is the safety net used while building and changing the server. The unit tests check important behaviors inside the app-server crate: importing external agent settings without losing or duplicating data, managing config files safely, accepting command-line overrides, keeping tracing links across JSON-RPC requests, refreshing runtime state after config migration, reporting remote-control errors clearly, preserving conversation thread state, and creating summaries from the right user message.

The integration-test helpers act like a small pretend world around the server. They provide fake analytics, authentication files, config files, model lists, saved sessions, and AI service responses, so tests can run without real accounts, networks, or production services. The mock model server and test app-server client let tests start a real server process, send JSON-RPC commands, read replies, and shut it down cleanly. Finally, the suite index files are the test runner’s table of contents, gathering the right test groups so they compile and run together.

## Files in this stage

### Unit test entry points
These focused crate-level tests validate CLI parsing, configuration services, tracing, and core request-processor behaviors before the broader integration harness comes into play.

### `app-server/src/config/external_agent_config_tests.rs`

`test` · `test run`

These tests act like a safety checklist for the external-agent migration feature. The feature looks at folders and configuration files from another coding assistant, then decides what Codex can import and where it should go. Without this test file, changes to the migration code could silently break important cases, such as overwriting an existing AGENTS.md file, importing a disabled plugin, or losing environment settings.

Each test builds a temporary fake home directory or fake repository. It writes small sample files, such as settings.json, .mcp.json, plugin manifests, command markdown files, or agent definitions. Then it calls the migration service in one of two modes: detect, which only reports what could be migrated, or import, which actually writes Codex files. The tests compare the results against exact expected values.

A recurring theme is careful copying rather than blind copying. The tests check that Codex skips things already present, rewrites old product names to Codex names, ignores invalid optional files when safe, keeps going after one failed item, and records plugin imports that must happen later. In everyday terms, this file makes sure the moving truck labels every box correctly, avoids unpacking over furniture that is already there, and leaves notes for anything that cannot be moved immediately.

#### Function details

##### `fixture_paths`  (lines 14–19)

```
fn fixture_paths() -> (TempDir, PathBuf, PathBuf)
```

**Purpose**: Creates a fresh temporary set of paths for tests. This gives each test its own fake external-agent home and fake Codex home so tests do not affect each other.

**Data flow**: It takes no input. It creates a temporary root directory, then builds two paths inside it: one for the external agent and one for Codex. It returns the temporary directory object plus both paths, so the directory stays alive while the test runs.

**Call relations**: Many tests call this first, like setting up a clean workbench before trying a migration. It relies on the temporary-directory library to create the folder, then hands the paths to service_for_paths or direct file-writing setup.

*Call graph*: called by 23 (detect_home_infers_external_official_marketplace_when_missing_from_settings, detect_home_lists_config_skills_and_agents_md, detect_home_lists_enabled_plugins_from_settings, detect_home_lists_recent_sessions, detect_home_plugins_uses_local_settings_over_project_settings, detect_home_skips_config_when_target_already_has_supported_fields, detect_home_skips_plugins_with_invalid_marketplace_source, detect_home_skips_plugins_without_marketplace_source, detect_home_skips_skills_when_all_skill_directories_exist, detect_home_supports_relative_external_agent_plugin_marketplace_path (+13 more)); 1 external calls (new).


##### `service_for_paths`  (lines 21–26)

```
fn service_for_paths(
    external_agent_home: PathBuf,
    codex_home: PathBuf,
) -> ExternalAgentConfigService
```

**Purpose**: Builds an ExternalAgentConfigService pointed at test-only folders. Tests use it so the migration code reads and writes inside temporary directories instead of real user files.

**Data flow**: It receives two paths: the external-agent home and the Codex home. It passes those paths into the service’s test constructor. It returns a migration service ready to detect or import from those locations.

**Call relations**: Most tests call this after creating fixture paths or repository paths. It hands control to ExternalAgentConfigService::new_for_test, then the test calls methods such as detect, import, import_plugins, or import_skills on the returned service.

*Call graph*: calls 1 internal fn (new_for_test); called by 46 (detect_home_infers_external_official_marketplace_when_missing_from_settings, detect_home_lists_config_skills_and_agents_md, detect_home_lists_enabled_plugins_from_settings, detect_home_lists_recent_sessions, detect_home_plugins_uses_local_settings_over_project_settings, detect_home_skips_config_when_target_already_has_supported_fields, detect_home_skips_plugins_with_invalid_marketplace_source, detect_home_skips_plugins_without_marketplace_source, detect_home_skips_skills_when_all_skill_directories_exist, detect_home_supports_relative_external_agent_plugin_marketplace_path (+15 more)).


##### `github_plugin_details`  (lines 28–36)

```
fn github_plugin_details() -> MigrationDetails
```

**Purpose**: Creates a small reusable plugin-migration request for a GitHub-style marketplace. It saves one plugin-related test from repeating the same setup data.

**Data flow**: It takes no input. It builds MigrationDetails containing one marketplace named acme-tools and one plugin named formatter. It returns that details object.

**Call relations**: The plugin validation test calls this when it wants a ready-made request. The helper uses default values for all unrelated migration detail fields.

*Call graph*: called by 1 (import_plugins_defers_marketplace_source_validation_to_add_marketplace); 2 external calls (default, vec!).


##### `assert_single_plugin_raw_error`  (lines 38–54)

```
fn assert_single_plugin_raw_error(
    raw_errors: &[ExternalAgentConfigImportRawError],
    failure_stage: &str,
    source: &str,
)
```

**Purpose**: Checks that a plugin import produced exactly one detailed raw error with the expected stage and source. This keeps plugin failure tests focused and consistent.

**Data flow**: It receives a list of raw errors, an expected failure stage, and an expected source string. It checks that there is one error, that it is for plugins, that key fields match, and that the message is not empty. It returns nothing, but fails the test if anything is wrong.

**Call relations**: Several plugin error tests call this after import_plugins returns a failure outcome. It uses assertion macros to turn mismatches into clear test failures.

*Call graph*: called by 3 (import_plugins_defers_marketplace_source_validation_to_add_marketplace, import_plugins_infers_external_official_marketplace_when_missing_from_settings, import_plugins_requires_source_marketplace_details); 2 external calls (assert!, assert_eq!).


##### `import_success`  (lines 56–68)

```
fn import_success(
    item_type: ExternalAgentConfigMigrationItemType,
    cwd: Option<PathBuf>,
    source: impl Into<String>,
    target: impl Into<String>,
) -> ExternalAgentConfigImportSuccess
```

**Purpose**: Builds an expected success record for import tests. It keeps repeated expected-result objects shorter and easier to read.

**Data flow**: It receives the migration item type, an optional working directory, a source label, and a target label. It converts the labels into strings and returns an ExternalAgentConfigImportSuccess value.

**Call relations**: Import tests use this helper when comparing the service’s reported successes. It is a small builder that feeds expected values into assertion checks.

*Call graph*: 1 external calls (into).


##### `detect_home_lists_config_skills_and_agents_md`  (lines 71–131)

```
async fn detect_home_lists_config_skills_and_agents_md()
```

**Purpose**: Verifies that home-level detection finds three basic things to migrate: settings, skills, and the external agent’s guidance markdown file.

**Data flow**: The test creates fake external-agent settings, a skill folder, and a guidance file. It asks the service to detect home migrations. It expects three migration items describing the source and target paths.

**Call relations**: The async test runner invokes it. It uses fixture_paths and service_for_paths to prepare a clean service, then checks the detect result with an exact equality assertion.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 5 external calls (assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_home_lists_recent_sessions`  (lines 134–184)

```
async fn detect_home_lists_recent_sessions()
```

**Purpose**: Checks that recent external-agent session history is detected as something Codex can migrate. This matters because users may want conversation history preserved.

**Data flow**: The test creates a fake project folder and a recent JSON-lines session file containing a user message and timestamp. It runs home detection. It expects one Sessions migration item containing the session path, project directory, and title from the first request.

**Call relations**: The async test runner calls it. It uses fixture_paths and service_for_paths, writes session JSON, then exercises the service’s detect flow.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 5 external calls (assert_eq!, now, create_dir_all, write, json!).


##### `detect_repo_lists_agents_md_for_each_cwd`  (lines 187–234)

```
async fn detect_repo_lists_agents_md_for_each_cwd()
```

**Purpose**: Confirms that repository detection reports AGENTS.md migration for each requested current working directory. It also covers the case where one requested directory is nested inside the repository.

**Data flow**: The test creates a fake Git repository, a nested child folder, and an external-agent guidance file at the repo root. It asks detection to inspect both paths. It expects two migration items, both pointing back to the same repository-level source and target.

**Call relations**: The async test runner calls it directly. It sets up paths itself, builds the service with service_for_paths, then compares the returned detection list.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_still_reports_non_plugin_items_when_home_config_is_invalid`  (lines 237–325)

```
async fn detect_repo_still_reports_non_plugin_items_when_home_config_is_invalid()
```

**Purpose**: Makes sure an invalid existing Codex home config does not prevent repository items like config, skills, and AGENTS.md from being detected. This keeps one bad file from hiding unrelated migrations.

**Data flow**: The test writes invalid TOML into the Codex config, then creates repository external-agent settings, skills, and guidance. It runs repository detection. It expects the non-plugin migration items to still appear.

**Call relations**: The test runner invokes it. It constructs its own temporary repository and service, then checks that detection continues despite the malformed Codex config.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_lists_mcp_hooks_commands_and_subagents`  (lines 328–447)

```
async fn detect_repo_lists_mcp_hooks_commands_and_subagents()
```

**Purpose**: Checks that repository detection finds advanced migration items: MCP servers, hooks, custom commands, and subagents. MCP means Model Context Protocol, a way to connect tools or services to the assistant.

**Data flow**: The test writes a .mcp.json file, external-agent hook settings, a command markdown file, and a subagent markdown file. It runs repository detection. It expects four migration items, each with names of the discovered objects.

**Call relations**: The async test runner calls it. The test uses service_for_paths to create the migration service and then verifies that detect summarizes all supported advanced items.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_skips_hooks_when_only_unsupported_hooks_exist`  (lines 450–473)

```
async fn detect_repo_skips_hooks_when_only_unsupported_hooks_exist()
```

**Purpose**: Verifies that detection does not offer a hooks migration when every hook is unsupported. This avoids promising users that Codex can import something it will later ignore.

**Data flow**: The test writes hook settings containing unsupported conditions or event types. It runs repository detection. It expects an empty list.

**Call relations**: The async test runner invokes it. It sets up a minimal repository, calls the service’s detect path through service_for_paths, and asserts there are no migration items.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_repo_migrates_mcp_hooks_commands_and_subagents`  (lines 476–671)

```
async fn import_repo_migrates_mcp_hooks_commands_and_subagents()
```

**Purpose**: Checks the full import path for repository MCP servers, hooks, commands, and subagents. It verifies not just that files are written, but that their content is converted into Codex-supported formats.

**Data flow**: The test creates source MCP, hooks, command, and subagent files. It asks the service to import all four item types. Then it reads Codex config, hooks JSON, generated skill markdown, and subagent TOML, and compares them to expected converted content.

**Call relations**: The async test runner calls it. This is a broad integration-style test that uses service_for_paths, performs an import, and then validates the resulting files with TOML and JSON parsers.

*Call graph*: calls 1 internal fn (service_for_paths); 11 external calls (new, assert!, assert_eq!, format!, create_dir_all, read_to_string, write, from_str, from_value, from_str (+1 more)).


##### `import_repo_mcp_preserves_existing_same_named_server`  (lines 674–734)

```
async fn import_repo_mcp_preserves_existing_same_named_server()
```

**Purpose**: Ensures MCP import does not overwrite an existing Codex MCP server with the same name. This protects user-edited Codex configuration.

**Data flow**: The test writes an external MCP server and an existing Codex config entry with the same server name. Detection should report nothing missing. Import should leave the existing config text unchanged.

**Call relations**: The async test runner invokes it. It uses service_for_paths, first checks detect behavior, then calls import and checks the file was preserved.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_mcp_lists_only_missing_servers`  (lines 737–789)

```
async fn detect_repo_mcp_lists_only_missing_servers()
```

**Purpose**: Confirms MCP detection reports only servers that are not already present in Codex config. This prevents duplicate migration suggestions.

**Data flow**: The test writes two external MCP servers and an existing Codex config for one of them. It runs repository detection. It expects a migration item listing only the missing server.

**Call relations**: The async test runner calls it. It builds the temporary repository, invokes detect through the service, and compares the details list.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_home_migrates_supported_config_fields_skills_and_agents_md`  (lines 792–873)

```
async fn import_home_migrates_supported_config_fields_skills_and_agents_md()
```

**Purpose**: Tests the main home-level import for supported settings, skills, and guidance markdown. It checks that only supported settings are moved and old product names are rewritten to Codex.

**Data flow**: The test writes external-agent settings with environment variables and sandbox settings, a skill file, and a guidance file. It imports config, skills, and AGENTS.md. It then reads Codex files and checks the expected TOML and rewritten markdown.

**Call relations**: The async test runner invokes it. It uses fixture_paths and service_for_paths, then validates the service’s import output by reading the files it created.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 7 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_home_config_uses_local_settings_over_project_settings`  (lines 876–918)

```
async fn import_home_config_uses_local_settings_over_project_settings()
```

**Purpose**: Verifies that local external-agent settings override project settings during home config import. This matches the usual rule that personal local settings take priority.

**Data flow**: The test writes both settings.json and settings.local.json with overlapping environment and sandbox values. It imports config. It expects Codex config to contain merged values, with local values winning where they overlap.

**Call relations**: The async test runner calls it. It uses fixture_paths and service_for_paths, then parses the produced config.toml and compares it to expected TOML.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 6 external calls (assert_eq!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_home_config_ignores_invalid_local_settings`  (lines 921–949)

```
async fn import_home_config_ignores_invalid_local_settings()
```

**Purpose**: Checks that a broken optional local settings file does not stop the main settings import. This is important because local files may be hand-edited and malformed.

**Data flow**: The test writes valid project settings and invalid JSON in settings.local.json. It imports config. It expects Codex config to be created from the valid project settings only.

**Call relations**: The async test runner invokes it. It uses the shared path helpers and then checks the exact text written to config.toml.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 4 external calls (assert_eq!, create_dir_all, write, vec!).


##### `import_home_skips_empty_config_migration`  (lines 952–984)

```
async fn import_home_skips_empty_config_migration()
```

**Purpose**: Ensures importing config does nothing when the external settings contain no supported Codex fields. This avoids creating empty or misleading config files.

**Data flow**: The test writes settings that do not translate into any Codex config entries. It imports a Config item. It expects zero successes, zero errors, and no config.toml file.

**Call relations**: The async test runner calls it. It prepares fixture paths, runs the service import, and checks both the reported result and the filesystem.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 6 external calls (assert!, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_local_plugins_returns_completed_status`  (lines 987–1073)

```
async fn import_local_plugins_returns_completed_status()
```

**Purpose**: Tests that a plugin from a local marketplace can be imported immediately and reported as completed. A local marketplace is a plugin collection already available on disk.

**Data flow**: The test creates a fake marketplace manifest, plugin manifest, and external-agent settings enabling the plugin. It imports Plugins. It expects no pending work, one success, and a Codex config entry enabling the plugin.

**Call relations**: The async test runner invokes it. It uses fixture_paths and service_for_paths, then validates both the import result object and the written config file.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 8 external calls (assert!, assert_eq!, create_dir_all, read_to_string, write, json!, to_string_pretty, vec!).


##### `import_git_plugins_returns_pending_async_status`  (lines 1076–1137)

```
async fn import_git_plugins_returns_pending_async_status()
```

**Purpose**: Checks that plugins from a Git marketplace are not imported immediately by this step. Instead, they are returned as pending work that another async process can finish later.

**Data flow**: The test writes settings for an enabled plugin whose marketplace source is a Git repository. It imports Plugins. It expects a pending plugin import entry, no immediate successes, and no config file.

**Call relations**: The async test runner calls it. It exercises the import path through service_for_paths and checks that the service correctly defers network-style work.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 5 external calls (assert!, assert_eq!, create_dir_all, write, vec!).


##### `detect_home_skips_config_when_target_already_has_supported_fields`  (lines 1140–1172)

```
async fn detect_home_skips_config_when_target_already_has_supported_fields()
```

**Purpose**: Verifies that home detection skips config migration when Codex already has the equivalent supported settings. This avoids suggesting duplicate work.

**Data flow**: The test writes external settings and a Codex config.toml containing matching sandbox and environment settings. It runs home detection. It expects no migration items.

**Call relations**: The async test runner invokes it. It uses fixture_paths and service_for_paths, then compares the detect result to an empty list.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_skips_skills_when_all_skill_directories_exist`  (lines 1175–1193)

```
async fn detect_home_skips_skills_when_all_skill_directories_exist()
```

**Purpose**: Checks that skills are not suggested for migration when every source skill directory already exists in the target skills folder.

**Data flow**: The test creates a source skill directory and a matching target skill directory. It runs home detection. It expects no migration items.

**Call relations**: The async test runner calls it. It uses fixture_paths for isolated folders and calls the service’s detect method through service_for_paths.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 2 external calls (assert_eq!, create_dir_all).


##### `import_repo_agents_md_rewrites_terms_and_skips_non_empty_targets`  (lines 1196–1281)

```
async fn import_repo_agents_md_rewrites_terms_and_skips_non_empty_targets()
```

**Purpose**: Tests two AGENTS.md rules: rewrite old external-agent names to Codex names, and do not overwrite a target file that already has real content.

**Data flow**: The test creates one repository with a source guidance file and another with both a source and an existing non-empty AGENTS.md. It imports both. It expects the first target to be written with rewritten terms and the second target to stay unchanged.

**Call relations**: The async test runner invokes it. It builds a service with service_for_paths, imports two AgentsMd items, and checks the reported successes plus final file contents.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_repo_agents_md_overwrites_empty_targets`  (lines 1284–1332)

```
async fn import_repo_agents_md_overwrites_empty_targets()
```

**Purpose**: Confirms that an existing AGENTS.md containing only whitespace is treated as empty and may be replaced. This lets migration fill placeholder files safely.

**Data flow**: The test writes a source guidance file and a whitespace-only AGENTS.md target. It imports AgentsMd. It expects one success and the target file to contain the rewritten guidance.

**Call relations**: The async test runner calls it. It uses service_for_paths to run import and then reads the target file to confirm replacement.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_prefers_non_empty_external_agent_agents_source`  (lines 1335–1376)

```
async fn detect_repo_prefers_non_empty_external_agent_agents_source()
```

**Purpose**: Checks source selection when a repository has both a root guidance file and an external-agent-folder guidance file. If the root one is empty, detection should prefer the non-empty one.

**Data flow**: The test writes an empty root source and a non-empty source under the external-agent directory. It runs repository detection. It expects the migration item to point at the non-empty source.

**Call relations**: The async test runner invokes it. It uses service_for_paths, creates both possible source files, and validates the chosen source path.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_repo_hooks_preserves_disabled_codex_hooks_feature`  (lines 1379–1447)

```
async fn import_repo_hooks_preserves_disabled_codex_hooks_feature()
```

**Purpose**: Ensures importing hook definitions does not turn on Codex’s hooks feature if the user explicitly disabled it. The hook file can be written, but the feature flag must be respected.

**Data flow**: The test writes external hook settings and a Codex config with codex_hooks set to false. It imports Hooks. It expects hooks.json to be created while config.toml remains unchanged.

**Call relations**: The async test runner calls it. It uses service_for_paths, runs import, then checks both the import result and the two target files.

*Call graph*: calls 1 internal fn (service_for_paths); 7 external calls (new, assert_eq!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_repo_mcp_uses_home_settings_toggles_when_repo_settings_missing`  (lines 1450–1516)

```
async fn import_repo_mcp_uses_home_settings_toggles_when_repo_settings_missing()
```

**Purpose**: Tests MCP server enable/disable rules when a repository has no local external-agent settings. In that case, home-level settings can still block a server.

**Data flow**: The test writes home settings disabling one server and project-level MCP data containing an allowed and blocked server. It imports MCP config. It expects only the allowed server to appear in Codex config.

**Call relations**: The async test runner invokes it. It builds paths manually, calls service_for_paths, imports McpServerConfig, and parses the written TOML.

*Call graph*: calls 1 internal fn (service_for_paths); 8 external calls (new, assert_eq!, create_dir_all, read_to_string, write, json!, from_str, vec!).


##### `import_repo_mcp_uses_local_settings_toggles_over_project_settings`  (lines 1519–1577)

```
async fn import_repo_mcp_uses_local_settings_toggles_over_project_settings()
```

**Purpose**: Verifies that repository local settings override repository project settings when deciding which MCP servers to import.

**Data flow**: The test writes three MCP servers plus project and local enable/disable lists. It imports MCP config. It expects only the server enabled by local settings and not locally disabled to be written.

**Call relations**: The async test runner calls it. It uses service_for_paths, then validates the resulting Codex config.

*Call graph*: calls 1 internal fn (service_for_paths); 7 external calls (new, assert_eq!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_repo_mcp_ignores_invalid_home_settings_when_repo_settings_missing`  (lines 1580–1625)

```
async fn import_repo_mcp_ignores_invalid_home_settings_when_repo_settings_missing()
```

**Purpose**: Checks that invalid home settings do not block MCP import when repository settings are missing. The service should fall back safely instead of failing the whole migration.

**Data flow**: The test writes malformed home settings and project-level MCP data with one server. It imports MCP config. It expects that server to be written to Codex config.

**Call relations**: The async test runner invokes it. It exercises the MCP import path and then compares the parsed TOML result.

*Call graph*: calls 1 internal fn (service_for_paths); 8 external calls (new, assert_eq!, create_dir_all, read_to_string, write, json!, from_str, vec!).


##### `import_repo_uses_non_empty_external_agent_agents_source`  (lines 1628–1659)

```
async fn import_repo_uses_non_empty_external_agent_agents_source()
```

**Purpose**: Confirms that import uses the non-empty external-agent-folder guidance file when the root source file is empty.

**Data flow**: The test writes an empty root guidance file and a non-empty guidance file under the external-agent directory. It imports AgentsMd. It expects AGENTS.md to contain the non-empty source content rewritten for Codex.

**Call relations**: The async test runner calls it. It mirrors the earlier detection source-selection test, but checks the actual import result on disk.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_continues_after_failed_migration_item`  (lines 1662–1693)

```
async fn import_continues_after_failed_migration_item()
```

**Purpose**: Ensures one failed migration item does not stop later items from being imported. This makes the import process more forgiving for users.

**Data flow**: The test requests an invalid plugin migration followed by a valid AGENTS.md migration. It runs import. It expects the valid AGENTS.md file to still be created.

**Call relations**: The async test runner invokes it. It uses service_for_paths and checks that the service continues processing after a bad item.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `migration_metric_tags_for_skills_include_skills_count`  (lines 1696–1704)

```
fn migration_metric_tags_for_skills_include_skills_count()
```

**Purpose**: Checks that metrics for a skills migration include the number of skills. Metrics are labels used for reporting what happened during migration.

**Data flow**: The test calls migration_metric_tags with the Skills item type and a count of 3. It expects two labels: the migration type and the skills count.

**Call relations**: The normal test runner calls it. It directly exercises the metric-tag helper and compares the returned labels.

*Call graph*: 1 external calls (assert_eq!).


##### `detect_home_lists_enabled_plugins_from_settings`  (lines 1707–1753)

```
async fn detect_home_lists_enabled_plugins_from_settings()
```

**Purpose**: Verifies that home detection finds enabled plugins listed in external-agent settings. Disabled plugins should not be included.

**Data flow**: The test writes settings with two enabled plugins and one disabled plugin, plus marketplace information. It runs home detection. It expects one Plugins migration item containing the two enabled plugin names.

**Call relations**: The async test runner invokes it. It uses fixture_paths and service_for_paths, then checks the details returned by detect.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_plugins_uses_local_settings_over_project_settings`  (lines 1756–1811)

```
async fn detect_home_plugins_uses_local_settings_over_project_settings()
```

**Purpose**: Checks that local plugin settings override project plugin settings during detection. This lets a user’s local choices change which plugins are considered enabled.

**Data flow**: The test writes project settings enabling two plugins and local settings disabling one while enabling another. It runs detection. It expects the final plugin list after overrides.

**Call relations**: The async test runner calls it. It uses the shared path helpers, writes both settings files, and verifies the merged detection result.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_repo_skips_plugins_that_are_already_configured_in_codex`  (lines 1814–1875)

```
async fn detect_repo_skips_plugins_that_are_already_configured_in_codex()
```

**Purpose**: Ensures repository plugin detection skips plugins already enabled in the global Codex config. Only plugins still missing should be suggested.

**Data flow**: The test writes repository external-agent plugin settings and a Codex config where one plugin is already enabled. It runs repository detection. It expects only the other plugin to appear.

**Call relations**: The async test runner invokes it. It builds the temporary repository and uses service_for_paths to run detection.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_skips_plugins_that_are_disabled_in_codex`  (lines 1878–1918)

```
async fn detect_repo_skips_plugins_that_are_disabled_in_codex()
```

**Purpose**: Checks that a plugin explicitly disabled in Codex is not suggested for migration. This respects the user’s existing Codex choice.

**Data flow**: The test writes external-agent settings enabling a plugin and Codex config disabling the same plugin. It runs detection. It expects no migration items.

**Call relations**: The async test runner calls it. It uses service_for_paths and validates that detection honors the existing disabled flag.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_skips_plugins_without_explicit_enabled_in_codex`  (lines 1921–1960)

```
async fn detect_repo_skips_plugins_without_explicit_enabled_in_codex()
```

**Purpose**: Verifies that a plugin already present in Codex config, even without an explicit enabled value, is not suggested again. This avoids duplicate configuration.

**Data flow**: The test writes external-agent settings enabling a plugin and a Codex plugin table for the same plugin with no enabled field. It runs detection. It expects an empty result.

**Call relations**: The async test runner invokes it. It uses service_for_paths to run repository detection and checks for no suggestions.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_requires_details`  (lines 1963–1973)

```
async fn import_plugins_requires_details()
```

**Purpose**: Checks that direct plugin import fails clearly when the migration details are missing. Plugin import needs details because it must know which marketplace and plugin names to process.

**Data flow**: The test calls import_plugins with no current directory and no details. It expects an InvalidData error with a specific message.

**Call relations**: The async test runner calls it. It uses fixture_paths and service_for_paths, then checks the error returned by import_plugins.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 1 external calls (assert_eq!).


##### `detect_repo_does_not_skip_plugins_only_configured_in_project_codex`  (lines 1976–2037)

```
async fn detect_repo_does_not_skip_plugins_only_configured_in_project_codex()
```

**Purpose**: Confirms repository plugin detection only uses the global Codex plugin config for skipping, not a project-local Codex config. This distinction matters because plugin configuration is treated as global here.

**Data flow**: The test writes an enabled external plugin and a project-local Codex config containing that plugin. It runs repository detection. It still expects the plugin migration to be suggested.

**Call relations**: The async test runner invokes it. It creates both global and project Codex folders, then checks the service’s detect result.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_home_skips_plugins_without_marketplace_source`  (lines 2040–2062)

```
async fn detect_home_skips_plugins_without_marketplace_source()
```

**Purpose**: Verifies that detection skips enabled plugins when their marketplace source is missing. Without a source, Codex does not know where the plugin comes from.

**Data flow**: The test writes settings with an enabled plugin but no marketplace definition. It runs home detection. It expects no migration items.

**Call relations**: The async test runner calls it. It uses fixture_paths, service_for_paths, and a direct equality check against an empty list.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_skips_plugins_with_invalid_marketplace_source`  (lines 2065–2092)

```
async fn detect_home_skips_plugins_with_invalid_marketplace_source()
```

**Purpose**: Checks that detection skips enabled plugins whose marketplace source is not in a usable form. This prevents offering migrations that cannot be completed.

**Data flow**: The test writes settings with an enabled plugin and an invalid marketplace source value. It runs home detection. It expects no migration items.

**Call relations**: The async test runner invokes it. It follows the same setup pattern as other home detection tests and verifies no plugin migration is reported.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_repo_filters_plugins_against_installed_marketplace`  (lines 2095–2221)

```
async fn detect_repo_filters_plugins_against_installed_marketplace()
```

**Purpose**: Tests that repository plugin detection looks at an installed marketplace manifest and filters out unavailable or missing plugins. Only installable plugins should be suggested.

**Data flow**: The test creates a fake installed marketplace with one unavailable plugin, one available plugin, and no entry for a third requested plugin. It runs repository detection. It expects only the available plugin to be listed.

**Call relations**: The async test runner calls it. It builds a more detailed fake marketplace on disk, then checks the detection details from service_for_paths.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_requires_source_marketplace_details`  (lines 2224–2269)

```
async fn import_plugins_requires_source_marketplace_details()
```

**Purpose**: Checks the failure path when requested plugin details name a marketplace that cannot be found in source settings. The import should report a structured plugin error.

**Data flow**: The test writes settings for one marketplace, then asks to import from a different marketplace. It calls import_plugins. It expects no successes, one failed marketplace, one failed plugin ID, and one raw error.

**Call relations**: The async test runner invokes it. It uses fixture_paths, service_for_paths, and assert_single_plugin_raw_error to verify the detailed failure.

*Call graph*: calls 3 internal fn (assert_single_plugin_raw_error, fixture_paths, service_for_paths); 5 external calls (default, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_defers_marketplace_source_validation_to_add_marketplace`  (lines 2272–2304)

```
async fn import_plugins_defers_marketplace_source_validation_to_add_marketplace()
```

**Purpose**: Verifies that plugin import passes marketplace source validation to the lower-level marketplace-add step. In this case, an invalid local path should fail there and be reported cleanly.

**Data flow**: The test writes settings for a local marketplace path that does not contain a valid marketplace. It imports plugin details from github_plugin_details. It expects failed marketplace and plugin IDs plus one raw error.

**Call relations**: The async test runner calls it. It combines fixture_paths, service_for_paths, github_plugin_details, and assert_single_plugin_raw_error.

*Call graph*: calls 4 internal fn (assert_single_plugin_raw_error, fixture_paths, github_plugin_details, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `import_plugins_supports_external_agent_plugin_marketplace_layout`  (lines 2307–2380)

```
async fn import_plugins_supports_external_agent_plugin_marketplace_layout()
```

**Purpose**: Checks that plugin import understands the external agent’s marketplace folder layout. This lets local plugin collections be migrated even if their manifest directory name differs from Codex’s.

**Data flow**: The test creates an external-agent-style marketplace manifest and plugin manifest, then writes settings enabling the plugin. It calls import_plugins. It expects the marketplace and plugin to succeed and Codex config to enable the plugin.

**Call relations**: The async test runner invokes it. It uses fixture_paths and service_for_paths, then checks the PluginImportOutcome and generated config.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 9 external calls (default, assert!, assert_eq!, create_dir_all, read_to_string, write, json!, to_string_pretty, vec!).


##### `detect_home_supports_relative_external_agent_plugin_marketplace_path`  (lines 2383–2454)

```
async fn detect_home_supports_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Verifies that home detection accepts a marketplace path written relative to the external-agent home. Relative paths are common in portable settings.

**Data flow**: The test creates a marketplace under the external-agent home and settings whose marketplace path is ./my-marketplace. It runs home detection. It expects the enabled plugin to be detected.

**Call relations**: The async test runner calls it. It sets up real folders under the temporary home and checks the service’s detect output.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_infers_external_official_marketplace_when_missing_from_settings`  (lines 2457–2500)

```
async fn detect_home_infers_external_official_marketplace_when_missing_from_settings()
```

**Purpose**: Checks that detection can infer the official external marketplace even when it is not listed in extra marketplace settings. This supports a built-in marketplace convention.

**Data flow**: The test writes settings enabling a plugin from the official marketplace name, but no marketplace source entry. It runs home detection. It expects a Plugins migration item for that official marketplace.

**Call relations**: The async test runner invokes it. It uses fixture_paths and service_for_paths, then validates that inference happened.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 4 external calls (assert_eq!, format!, create_dir_all, write).


##### `import_plugins_supports_relative_external_agent_plugin_marketplace_path`  (lines 2503–2575)

```
async fn import_plugins_supports_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Tests that direct plugin import, not just detection, works with a marketplace path relative to the external-agent home.

**Data flow**: The test creates a relative local marketplace and plugin manifest, writes settings enabling the plugin, and calls import_plugins with matching details. It expects success and a Codex config entry enabling the plugin.

**Call relations**: The async test runner calls it. It is the import-side partner to the relative-path detection test and uses service_for_paths to run the plugin import.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 7 external calls (default, assert!, assert_eq!, create_dir_all, read_to_string, write, vec!).


##### `import_plugins_infers_external_official_marketplace_when_missing_from_settings`  (lines 2578–2624)

```
async fn import_plugins_infers_external_official_marketplace_when_missing_from_settings()
```

**Purpose**: Checks the import behavior for the inferred official marketplace. The marketplace itself can be accepted, while a specific plugin may still fail if it cannot be installed immediately.

**Data flow**: The test writes settings enabling a plugin from the official marketplace without a source entry. It calls import_plugins with details for that plugin. It expects the marketplace to count as succeeded, the plugin ID to fail, and one raw error.

**Call relations**: The async test runner invokes it. It uses fixture_paths, service_for_paths, and assert_single_plugin_raw_error to check the partial outcome.

*Call graph*: calls 3 internal fn (assert_single_plugin_raw_error, fixture_paths, service_for_paths); 6 external calls (default, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_supports_project_relative_external_agent_plugin_marketplace_path`  (lines 2627–2706)

```
async fn detect_repo_supports_project_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Verifies repository detection supports marketplace paths relative to the project root. This matters for repositories that keep plugin marketplaces inside the repo.

**Data flow**: The test creates a fake repository, a marketplace folder inside it, and external-agent settings pointing to ./my-marketplace. It runs repository detection. It expects the enabled plugin to be listed.

**Call relations**: The async test runner calls it. It builds its own repository paths, invokes detect through service_for_paths, and compares the migration item.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_supports_project_relative_external_agent_plugin_marketplace_path`  (lines 2709–2786)

```
async fn import_plugins_supports_project_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Tests direct plugin import when the marketplace path is relative to a repository rather than the external-agent home.

**Data flow**: The test creates a repository-local marketplace and plugin manifest, writes repository external-agent settings, and calls import_plugins with the repository path as the current directory. It expects a successful marketplace and plugin import plus an enabled Codex config entry.

**Call relations**: The async test runner invokes it. It is the import-side partner to the project-relative detection test and uses service_for_paths before calling import_plugins.

*Call graph*: calls 1 internal fn (service_for_paths); 8 external calls (default, new, assert!, assert_eq!, create_dir_all, read_to_string, write, vec!).


##### `import_skills_returns_only_new_skill_directory_names`  (lines 2789–2806)

```
fn import_skills_returns_only_new_skill_directory_names()
```

**Purpose**: Checks that skill import reports only the skills it actually copied. Existing target skill directories should be skipped and not counted as new.

**Data flow**: The test creates two source skill directories and one matching target directory that already exists. It calls import_skills. It expects the returned list to contain only the newly copied skill name.

**Call relations**: The normal test runner calls it. It uses fixture_paths and service_for_paths, then directly exercises the service’s import_skills helper.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 2 external calls (assert_eq!, create_dir_all).


### `app-server/src/config_manager_service_tests.rs`

`test` · `test run`

The configuration manager is the part of the app server that edits the user's `config.toml` file and combines it with other sources of settings, such as managed company policy, command-line flags, and cloud requirements. This test file checks that those pieces work together in predictable ways. In plain terms, it makes sure the app does not accidentally damage a user's configuration file, accept old configuration formats that are no longer supported, or pretend a setting took effect when a higher-priority policy overrode it.

Most tests create a temporary folder, write a small fake config file, build a test-only `ConfigManager`, then ask it to read or edit settings. They then inspect either the file contents, the parsed configuration, or the error that came back. Several tests focus on layering: managed configuration should win over user configuration, and reads should explain where each final value came from. Others focus on write safety: version checks prevent editing an out-of-date file, validation catches invalid values before saving, and special merge rules decide whether nested tables are combined or replaced.

A useful analogy is a stack of transparent sheets: the final config is what you see when all sheets are placed on top of each other. These tests make sure the top sheets win, and that editing one sheet does not smear or erase the others.

#### Function details

##### `toml_value_to_item_handles_nested_config_tables`  (lines 15–61)

```
fn toml_value_to_item_handles_nested_config_tables()
```

**Purpose**: Checks that a parsed TOML configuration can be converted into an editable TOML structure without losing nested tables. This matters because the service edits config files while trying to keep their table structure understandable.

**Data flow**: It starts with a small TOML string containing nested `mcp_servers` tables. The test parses that text, converts it into the editable TOML form, then walks through the resulting tables to confirm they are real explicit tables and still contain the expected values. The output is not a returned value; the test passes if all checks hold.

**Call relations**: The test runner calls this function directly. Inside the test, it exercises the TOML parsing path and the `toml_value_to_item` conversion helper, then uses assertions to prove nested config tables survive the trip.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `write_value_preserves_comments_and_order`  (lines 64–106)

```
async fn write_value_preserves_comments_and_order() -> Result<()>
```

**Purpose**: Verifies that adding a new setting to the config file does not erase comments or reorder existing sections. This is important because users often hand-edit this file and expect it to stay readable.

**Data flow**: It writes a sample `config.toml` with comments and ordered sections into a temporary directory. It creates a test `ConfigManager`, writes `features.personality = true`, then reads the file back and compares the full text against the expected result. The before-and-after story is: one setting is added, while the rest of the file stays exactly as it was.

**Call relations**: The test runner starts this async test. The test uses `ConfigManager::without_managed_config_for_tests` to avoid policy layers, then calls the manager's write path and checks the file system result.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert_eq!, json!, read_to_string, write, tempdir).


##### `clear_missing_nested_config_is_noop`  (lines 109–130)

```
async fn clear_missing_nested_config_is_noop() -> Result<()>
```

**Purpose**: Checks that clearing a nested setting that does not exist leaves the file unchanged. This prevents harmless delete requests from creating empty tables or otherwise modifying the user's file.

**Data flow**: It creates an empty config file and asks the service to write a JSON null value to `features.personality`, which means “remove this setting.” Since that setting is absent, the service should report success but make no file changes. The test reads the file afterward and expects it to still be empty.

**Call relations**: The test runner calls this async test. It builds a test config manager with no managed configuration and exercises the write operation in its delete-style behavior.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (assert_eq!, write, tempdir).


##### `write_value_rejects_legacy_profile_selector`  (lines 133–162)

```
async fn write_value_rejects_legacy_profile_selector() -> Result<()>
```

**Purpose**: Ensures the service rejects writes to the old top-level `profile` setting. This protects users from creating outdated configuration that the newer profile system should no longer use.

**Data flow**: It starts with a simple config containing a model name. The test asks the service to write `profile = "work"`. Instead of changing the file, the service returns a validation error, and the test confirms both the error code and the unchanged file contents.

**Call relations**: The test runner invokes this async test. The test uses the no-managed-config constructor, calls the write path, and checks that validation stops the write before anything reaches disk.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, assert_eq!, json!, write, tempdir).


##### `write_value_rejects_legacy_profile_table`  (lines 165–194)

```
async fn write_value_rejects_legacy_profile_table() -> Result<()>
```

**Purpose**: Ensures the service rejects writes into the old `profiles` table layout. This keeps the configuration format from drifting back toward a legacy system.

**Data flow**: It creates an empty config file, then tries to write `profiles.work.model = "gpt-work"`. The service should return a validation error explaining that legacy profile tables are not allowed, and the file should remain empty.

**Call relations**: The test runner calls this async test. It goes through the same write interface a real client would use, proving that the service rejects this outdated path before saving.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, assert_eq!, json!, write, tempdir).


##### `batch_write_rejects_legacy_profile_selector`  (lines 197–236)

```
async fn batch_write_rejects_legacy_profile_selector() -> Result<()>
```

**Purpose**: Checks that a batch edit is rejected if any edit in the batch tries to write the legacy `profile` selector. This matters because batch writes must be all-or-nothing; one bad edit should not allow earlier edits to sneak through.

**Data flow**: It begins with `model = "gpt-main"`. The test submits two edits together: one valid model change and one invalid legacy profile write. The service returns a validation error, and the original file is left untouched, showing that the batch did not partially apply.

**Call relations**: The test runner starts this async test. It builds a test manager, calls the batch write path, and relies on assertions to confirm that validation protects the whole batch.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, assert_eq!, write, tempdir, vec!).


##### `write_value_supports_nested_app_paths`  (lines 239–298)

```
async fn write_value_supports_nested_app_paths() -> Result<()>
```

**Purpose**: Verifies that the service can write and later read nested app-specific configuration. This lets clients update one app's settings without replacing the entire app configuration by hand.

**Data flow**: It first writes an `apps` object containing `app1`, then writes a deeper value at `apps.app1.default_tools_approval_mode`. Afterward it reads the full configuration and expects `app1` to contain both its original `enabled` value and the newly added approval setting. The output is a parsed config object with the expected nested app data.

**Call relations**: The test runner calls this async test. The test creates a no-managed-config manager, uses the write API twice, then hands off to the read API to verify the written data is understood by the normal config loader.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, json!, write, tempdir).


##### `write_value_supports_custom_mcp_server_default_tool_approval_mode`  (lines 301–341)

```
async fn write_value_supports_custom_mcp_server_default_tool_approval_mode() -> Result<()>
```

**Purpose**: Checks that custom MCP server settings can include a default tool approval mode. MCP here means Model Context Protocol, a way for the app to connect to external tools or servers.

**Data flow**: It starts with a config containing one custom MCP server named `docs`. The test writes `default_tools_approval_mode = "approve"` under that server, reads the raw file to make sure the setting was written, then reads the parsed config to make sure the value appears in the additional configuration data. The setting goes from a JSON input value to TOML text and then back into parsed JSON-like config data.

**Call relations**: The test runner invokes this async test. It uses the test config manager's write and read paths, checking both the file-level result and the higher-level parsed configuration result.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (assert!, assert_eq!, json!, read_to_string, write, tempdir).


##### `read_includes_origins_and_layers`  (lines 344–410)

```
async fn read_includes_origins_and_layers()
```

**Purpose**: Verifies that reading configuration can explain not only the final values, but also where they came from. This is important when a user setting is overridden by a managed policy.

**Data flow**: It writes a user config with one model setting and a managed config with an approval policy. The test reads with `include_layers` enabled, then checks that the final approval policy came from the managed file and that the response includes the expected stack of layers: managed, user, and system. On macOS, it tolerates an extra device-management layer if the local machine provides one.

**Call relations**: The test runner calls this async test. It builds a `ConfigManager` with `new_for_tests`, a managed config path override, and the default cloud loader, then exercises the read path that reports layer and origin metadata.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 6 external calls (assert!, assert_eq!, matches!, write, tempdir, vec!).


##### `write_value_succeeds_when_managed_preferences_expand_home_directory_paths`  (lines 414–458)

```
async fn write_value_succeeds_when_managed_preferences_expand_home_directory_paths() -> Result<()>
```

**Purpose**: On macOS, checks that writes still work when managed preferences contain paths using `~` for the home directory. This guards against a platform-specific parsing issue in company-managed settings.

**Data flow**: It creates a user config and injects a base64-encoded managed preference containing a writable path like `~/code`. The test then writes a new model value to the user config. The expected result is a successful write and a file containing the updated model.

**Call relations**: The macOS test runner calls this async test only on macOS. It sets up `LoaderOverrides` with managed preferences, constructs the test manager with `new_for_tests`, then confirms the write path can load those preferences and still save the user file.

*Call graph*: calls 3 internal fn (new_for_tests, default, with_managed_config_path_for_tests); 5 external calls (assert_eq!, json!, write, tempdir, vec!).


##### `write_value_reports_override`  (lines 461–514)

```
async fn write_value_reports_override()
```

**Purpose**: Checks behavior when a user writes the same value that a managed layer already enforces. The write should succeed, but the final effective value still belongs to the managed layer.

**Data flow**: It writes a user config with `approval_policy = "on-request"` and a managed config with `approval_policy = "never"`. The test writes `never` to the user file, then reads the combined config and checks that the final value and its origin are still the managed file. The write response is expected to be normal success, without override metadata, because the written value matches the enforced effective value.

**Call relations**: The test runner invokes this async test. It creates a manager with a managed config override, calls the write path, then calls the read path to inspect the layered result.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 6 external calls (assert!, assert_eq!, json!, write, tempdir, vec!).


##### `version_conflict_rejected`  (lines 517–538)

```
async fn version_conflict_rejected()
```

**Purpose**: Ensures a write is rejected when the caller provides an out-of-date expected file version. This prevents one client from accidentally overwriting another client's changes.

**Data flow**: It starts with a config file containing `model = "user"`. The test tries to write a new model while claiming the expected version is `sha256:bogus`. The service compares that expected version with the real file version, rejects the write, and returns a version conflict error.

**Call relations**: The test runner calls this async test. It uses the no-managed-config test manager and exercises the write path's optimistic locking check, which is a safety check for concurrent edits.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, json!, write, tempdir).


##### `write_value_defaults_to_user_config_path`  (lines 541–562)

```
async fn write_value_defaults_to_user_config_path()
```

**Purpose**: Checks that if a caller does not provide a file path, the service writes to the normal user config file. This keeps simple clients from needing to know the exact config path.

**Data flow**: It creates an empty default `config.toml`, then calls `write_value` with `file_path` set to none. The service chooses the default user config path and writes the model setting there. The test reads the file and confirms it now contains the new model.

**Call relations**: The test runner invokes this async test. It builds a no-managed-config manager and confirms the write path can choose its default target file on its own.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, json!, read_to_string, write, tempdir).


##### `write_value_defaults_to_selected_user_config_path`  (lines 565–601)

```
async fn write_value_defaults_to_selected_user_config_path()
```

**Purpose**: Checks that when a specific user config file has been selected, omitted write paths go to that selected file instead of the main config file. This matters for profile-like workflows where different config files may be active.

**Data flow**: It creates a main config with `gpt-main` and a separate selected config file. Loader overrides tell the manager that the selected file is active. The test writes a model without passing a file path, then confirms the selected file changed to `gpt-work` while the main config stayed unchanged.

**Call relations**: The test runner calls this async test. It uses `new_for_tests` with loader overrides for the selected config path, then checks that the write path respects the loader's selected user file.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, from_absolute_path); 5 external calls (assert_eq!, json!, write, tempdir, vec!).


##### `load_default_config_preserves_selected_user_config_path_after_load_error`  (lines 604–636)

```
async fn load_default_config_preserves_selected_user_config_path_after_load_error()
```

**Purpose**: Ensures that a failed load of a selected config file does not make the service forget which user config file was selected. This is important for recovery after a broken config file.

**Data flow**: It creates a valid main config and an invalid selected config file. Loading the latest config fails because the selected file is not valid TOML. Then the test loads the default config and checks that the config layer stack still records the selected file as the user config file.

**Call relations**: The test runner invokes this async test. It sets up `new_for_tests` with a selected user config override, intentionally triggers a load error, then verifies the default-loading path preserves the selected path information.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, from_absolute_path); 4 external calls (assert_eq!, write, tempdir, vec!).


##### `invalid_user_value_rejected_even_if_overridden_by_managed`  (lines 639–671)

```
async fn invalid_user_value_rejected_even_if_overridden_by_managed()
```

**Purpose**: Checks that invalid user input is rejected even when a managed setting would override it anyway. This prevents bad values from being saved silently just because they would not currently take effect.

**Data flow**: It creates a user config with a model and a managed config that forces `approval_policy = "never"`. The test tries to write the invalid value `approval_policy = "bogus"` to the user file. The service returns a validation error and leaves the user file unchanged.

**Call relations**: The test runner calls this async test. The manager is built with a managed config layer, but the write path still validates the user file contents before saving them.

*Call graph*: calls 3 internal fn (new_for_tests, default, with_managed_config_path_for_tests); 6 external calls (assert_eq!, json!, read_to_string, write, tempdir, vec!).


##### `reserved_builtin_provider_override_rejected`  (lines 674–699)

```
async fn reserved_builtin_provider_override_rejected()
```

**Purpose**: Ensures users cannot override reserved built-in model provider IDs such as `openai`. This protects built-in provider definitions from being accidentally or maliciously changed through user config.

**Data flow**: It starts with a simple user config. The test tries to write `model_providers.openai.name = "OpenAI Override"`. The service rejects the write with a validation error mentioning reserved built-in provider IDs, and the original file remains unchanged.

**Call relations**: The test runner invokes this async test. It uses the no-managed-config manager and exercises validation in the write path for protected provider names.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (assert!, assert_eq!, json!, read_to_string, write, tempdir).


##### `write_value_rejects_feature_requirement_conflict`  (lines 702–743)

```
async fn write_value_rejects_feature_requirement_conflict()
```

**Purpose**: Checks that a user cannot write a feature setting that conflicts with an enterprise requirement. This keeps organization-level feature requirements from being weakened by local config edits.

**Data flow**: It creates an empty config and a fake cloud configuration bundle that requires `features.personality = true`. The test tries to write `features.personality = false`. The service returns a validation error explaining the conflict, and the file stays empty.

**Call relations**: The test runner calls this async test. It builds the manager with `new_for_tests`, no managed local config, and a cloud fixture that supplies an enterprise requirement, then verifies the write path checks against that requirement.

*Call graph*: calls 3 internal fn (new_for_tests, without_managed_config_for_tests, loader_with_enterprise_requirement); 6 external calls (assert!, assert_eq!, json!, write, tempdir, vec!).


##### `read_reports_managed_overrides_user_and_session_flags`  (lines 746–806)

```
async fn read_reports_managed_overrides_user_and_session_flags()
```

**Purpose**: Verifies the ordering of configuration layers when managed config, command-line session flags, and user config all set the same key. Managed config should win, and the response should show that clearly.

**Data flow**: It writes `model = "user"` in the user file, `model = "system"` in the managed file, and passes a session override of `model = "session"`. The read result should report the final model as `system`, with the origin set to the managed file. The layer list should show managed above session flags above user config, ignoring an extra macOS management layer if present.

**Call relations**: The test runner invokes this async test. It creates the manager with `new_for_tests`, managed-path overrides, and CLI-style override values, then calls the read path that reports both final values and layer metadata.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 5 external calls (assert_eq!, matches!, write, tempdir, vec!).


##### `write_value_reports_managed_override`  (lines 809–842)

```
async fn write_value_reports_managed_override()
```

**Purpose**: Checks that when a user writes a value that is immediately overridden by managed configuration, the write response says so. This helps clients explain why a saved setting is not the setting the app actually uses.

**Data flow**: It creates an empty user config and a managed config forcing `approval_policy = "never"`. The test writes `approval_policy = "on-request"` to the user file. The service saves the user value but returns `OkOverridden`, along with metadata naming the managed layer and showing the effective value is still `never`.

**Call relations**: The test runner calls this async test. It constructs a manager with a managed config path, calls the write API, and inspects the response metadata that describes the higher-priority override.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 5 external calls (assert_eq!, json!, write, tempdir, vec!).


##### `upsert_merges_tables_replace_overwrites`  (lines 845–929)

```
async fn upsert_merges_tables_replace_overwrites() -> Result<()>
```

**Purpose**: Compares two write modes for nested tables: upsert and replace. Upsert should merge new values into an existing table, while replace should remove old nested entries that are not in the new value.

**Data flow**: It starts with an MCP server table that has several fields and two nested header tables. First it writes an overlay using the `Upsert` strategy; the result keeps unrelated existing nested data while updating and adding requested fields. Then it resets the file and writes the same overlay using `Replace`; this time the old `env_http_headers` table disappears because it was not part of the replacement value. The test parses the final TOML each time and compares it to the expected structure.

**Call relations**: The test runner invokes this async test. It uses the no-managed-config manager and exercises the write path's two merge strategies, then uses TOML parsing and assertions to confirm the exact table-level behavior.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (assert_eq!, json!, read_to_string, write, tempdir, from_str).


### `app-server/src/main_tests.rs`

`test` · `test run`

This is a small test file for the app server’s startup arguments. Its job is to make sure the command-line interface understands two ways of giving configuration overrides: the short form `-c` and the longer `--config` form. A configuration override is a setting typed on the command line to temporarily replace or add to the normal configuration file, like telling the program which model to use.

The test pretends to start the app server with a list of command-line words, much like a real shell command. It includes one override for the model, one override for the sandbox mode, and another option, `--listen off`, to show that normal server options can appear alongside configuration overrides.

After parsing those command-line words into `AppServerArgs`, the test asks the override parser to turn the raw text into structured TOML values. TOML is a common configuration format; here it means the text `model="gpt-5-codex"` becomes the key `model` paired with the string value `gpt-5-codex`.

Finally, the test compares the parsed result with the exact list it expects. If someone later changes the command-line parser and accidentally breaks `-c` or `--config`, this test should fail quickly.

#### Function details

##### `app_server_accepts_cli_config_overrides`  (lines 7–37)

```
fn app_server_accepts_cli_config_overrides()
```

**Purpose**: This test proves that the app server accepts configuration overrides from both `-c` and `--config` command-line flags. It matters because users rely on these flags to change settings at startup without editing a configuration file.

**Data flow**: It starts with a fake command-line argument list, including two configuration overrides and one unrelated server option. The arguments are parsed into `AppServerArgs`, then the stored override strings are parsed into TOML values. The test expects to get back two key-value pairs: `model` set to `gpt-5-codex`, and `sandbox_mode` set to `read-only`; if the result differs, the test fails.

**Call relations**: During the test, it calls the command-line parser through `try_parse_from` to mimic real startup parsing. After the overrides are parsed, it uses `assert_eq!` to compare the actual result with the expected one, so this function acts as a safety check around the app server’s command-line configuration path.

*Call graph*: 2 external calls (try_parse_from, assert_eq!).


### `app-server/src/message_processor_tracing_tests.rs`

`test` · `test execution`

This is a test file for observability: the ability to follow one request as it travels through different parts of the system. It checks tracing, which is like putting numbered luggage tags on work so every later step can be tied back to the original request. Without these tests, the server might still answer clients, but monitoring tools could show broken or misleading request timelines.

The file builds a small fake app-server world. It starts a mock responses server, creates a temporary Codex home directory, builds a test configuration, constructs a real MessageProcessor, and captures outgoing messages through an in-memory channel. It also installs an in-memory OpenTelemetry exporter, which records completed spans instead of sending them to an external tracing service.

The tests send initialize, thread/start, and turn/start JSON-RPC requests through the same path a real client would use. Some requests include a W3C trace context, which is the standard HTTP-style format for saying, “this request belongs to this existing trace, and this remote span is its parent.” The assertions then inspect exported spans to confirm that server spans use the remote trace ID, point to the remote parent span, and have internal child spans beneath them. One test also checks that a core “user input” turn span is nested under the app-server request span.

#### Function details

##### `RemoteTrace::new`  (lines 70–83)

```
fn new(trace_id: &str, parent_span_id: &str) -> Self
```

**Purpose**: Creates a small, fake remote tracing context for tests. It turns readable hex strings into real trace and span identifiers, then builds the W3C traceparent header value that a real remote client would send.

**Data flow**: It receives a trace ID string and a parent span ID string. It parses them into OpenTelemetry IDs, formats them into a traceparent string, adds a simple tracestate value, and returns a RemoteTrace containing both the parsed IDs and the context object to attach to a test request.

**Call relations**: The two tracing tests call this when they need to simulate a client that is already partway through a distributed trace. The returned context is passed into the harness request path, and the parsed IDs are later used as the expected values in span assertions.

*Call graph*: called by 2 (thread_start_jsonrpc_span_exports_server_span_and_parents_children, turn_start_jsonrpc_span_parents_core_turn_spans); 3 external calls (from_hex, from_hex, format!).


##### `init_test_tracing`  (lines 86–101)

```
fn init_test_tracing() -> &'static TestTracing
```

**Purpose**: Sets up tracing once for this test process and gives tests access to the in-memory span recorder. It installs the global tracing bridge so Rust tracing events become OpenTelemetry spans.

**Data flow**: It reads or creates a single shared TestTracing value. On first use, it creates an in-memory exporter, builds an OpenTelemetry provider, installs a trace context propagator, connects tracing_subscriber to OpenTelemetry, and returns a static reference to that setup.

**Call relations**: TracingHarness::new calls this during test setup. The harness then resets and reads the exporter so individual tests can wait for and inspect spans.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `request_from_client_request`  (lines 103–106)

```
fn request_from_client_request(request: ClientRequest) -> JSONRPCRequest
```

**Purpose**: Converts a typed app-server client request into the generic JSON-RPC request shape used by the message processor. This lets tests write requests using safe protocol types while still exercising the real JSON-RPC processing path.

**Data flow**: It takes a ClientRequest, serializes it to JSON, then deserializes that JSON into a JSONRPCRequest. The result is the request object that can be given directly to MessageProcessor::process_request.

**Call relations**: TracingHarness::request calls this just before sending a request into the processor. That keeps the tests close to real client behavior instead of bypassing protocol conversion.

*Call graph*: called by 1 (request); 2 external calls (from_value, to_value).


##### `TracingHarness::new`  (lines 118–157)

```
async fn new() -> Result<Self>
```

**Purpose**: Builds a complete test harness around a real MessageProcessor. It prepares the fake server, config, tracing recorder, outgoing message channel, and initialized session needed by the tracing tests.

**Data flow**: It creates a mock responses server and temporary Codex home, writes and loads test configuration, builds the processor, starts tracing, clears old spans, and creates a fresh connection session. It then sends an initialize request and checks that the session is initialized before returning the ready harness.

**Call relations**: Both test cases call this at the start. It relies on build_test_config, build_test_processor, init_test_tracing, and the harness request helper so later test code can focus on the tracing behavior being checked.

*Call graph*: calls 4 internal fn (new, build_test_config, build_test_processor, init_test_tracing); called by 2 (thread_start_jsonrpc_span_exports_server_span_and_parents_children, turn_start_jsonrpc_span_parents_core_turn_spans); 7 external calls (new, default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, rebuild_interest_cache).


##### `TracingHarness::reset_tracing`  (lines 159–161)

```
fn reset_tracing(&self)
```

**Purpose**: Clears previously recorded spans from the in-memory exporter. Tests use it when setup work created spans that should not count toward the specific behavior being checked.

**Data flow**: It reads the harness tracing exporter and resets its stored finished spans. Nothing is returned; the visible change is that later span reads start from a clean slate.

**Call relations**: The turn/start test calls this after creating a thread, so the later assertions only consider spans produced by the turn/start request.


##### `TracingHarness::shutdown`  (lines 163–166)

```
async fn shutdown(self)
```

**Purpose**: Cleanly stops the background work started by the MessageProcessor. This prevents leftover test tasks from affecting later tests.

**Data flow**: It consumes the harness, asks the processor to shut down thread-related work, then waits for background tasks to finish. It returns when cleanup is complete.

**Call relations**: The tests call this near the end after their tracing assertions. It hands cleanup to the MessageProcessor so the test process remains orderly.


##### `TracingHarness::request`  (lines 168–188)

```
async fn request(&mut self, request: ClientRequest, trace: Option<W3cTraceContext>) -> T
```

**Purpose**: Sends one typed client request through the real message processor and waits for its matching response. It is the main shortcut that makes the tests read like client actions.

**Data flow**: It takes a ClientRequest and optional trace context. It extracts the integer request ID, converts the request into JSON-RPC form, attaches the trace context, sends it to MessageProcessor::process_request with the test connection and session, then reads the matching response from the outgoing channel and deserializes it into the requested response type.

**Call relations**: TracingHarness::start_thread uses this helper, and TracingHarness::new uses it for initialization. The test bodies also use it directly for turn/start, so all requests follow the same processing route.

*Call graph*: calls 2 internal fn (read_response, request_from_client_request); called by 1 (start_thread); 3 external calls (clone, id, panic!).


##### `TracingHarness::start_thread`  (lines 190–209)

```
async fn start_thread(
        &mut self,
        request_id: i64,
        trace: Option<W3cTraceContext>,
    ) -> ThreadStartResponse
```

**Purpose**: Starts a temporary thread in the test server and waits until the server announces that the thread was started. It wraps the request plus the extra notification that thread creation produces.

**Data flow**: It receives a request ID and optional trace context. It sends a ThreadStart request through TracingHarness::request, then reads outgoing messages until it sees a thread/started notification, and finally returns the ThreadStartResponse.

**Call relations**: Both tests call this to create a thread. The thread/start tracing test uses it as the action under inspection, while the turn/start test uses it as setup before starting a turn.

*Call graph*: calls 2 internal fn (request, read_thread_started_notification); 2 external calls (Integer, default).


##### `build_test_config`  (lines 212–227)

```
async fn build_test_config(codex_home: &Path, server_uri: &str) -> Result<Config>
```

**Purpose**: Creates a test Codex configuration that points model calls at the mock responses server. This keeps the tests deterministic and independent of real external services.

**Data flow**: It receives the temporary Codex home path and mock server URL. It writes a mock responses config file there, then builds and returns a Config loaded from that temporary home.

**Call relations**: TracingHarness::new calls this before constructing the processor. The resulting Config is passed into build_test_processor so the processor behaves like a real server but talks to the test mock.

*Call graph*: called by 1 (new); 4 external calls (new, to_path_buf, write_mock_responses_config_toml, default).


##### `build_test_processor`  (lines 229–272)

```
async fn build_test_processor(
    config: Arc<Config>,
) -> (
    Arc<MessageProcessor>,
    mpsc::Receiver<crate::outgoing_message::OutgoingEnvelope>,
)
```

**Purpose**: Constructs a MessageProcessor with test-safe dependencies. It wires together outgoing messages, auth, config loading, analytics, environment handling, feedback, and other services needed for realistic request processing.

**Data flow**: It receives an Arc-wrapped Config. It creates an outgoing channel, auth manager, config manager, analytics client, outgoing sender, environment manager, and MessageProcessor arguments, then returns the processor plus the receiver side of the outgoing channel.

**Call relations**: TracingHarness::new calls this during setup. The harness stores the processor for sending requests and stores the receiver so helpers can read responses and notifications.

*Call graph*: calls 8 internal fn (analytics_events_client_from_config, new, new, new, default, default_for_tests, new, shared_from_config); called by 1 (new); 6 external calls (clone, new, new, default, default, channel).


##### `run_current_thread_test_with_stack`  (lines 274–294)

```
fn run_current_thread_test_with_stack(name: &str, future: F) -> Result<()>
```

**Purpose**: Runs an async test body on a single-threaded Tokio runtime with a larger stack. This protects a tracing test from stack-size problems while keeping the runtime style controlled.

**Data flow**: It receives a thread name and future. It spawns a named OS thread with a 4 MB stack, builds a current-thread Tokio runtime inside it, runs the future to completion, and returns either the future result or an error if the thread panicked.

**Call relations**: The thread/start tracing test uses this wrapper instead of a direct tokio test. The wrapper creates the runtime, and the test body inside it builds the harness and performs assertions.

*Call graph*: called by 1 (thread_start_jsonrpc_span_exports_server_span_and_parents_children); 2 external calls (anyhow!, new).


##### `span_attr`  (lines 296–304)

```
fn span_attr(span: &'a SpanData, key: &str) -> Option<&'a str>
```

**Purpose**: Looks up a string-valued attribute on a recorded span. Tests use it to find fields such as rpc.method or codex.op without repeating low-level attribute scanning code.

**Data flow**: It receives a SpanData reference and an attribute key. It searches the span attributes for that key, returns the string value if present and actually a string, or returns nothing if the key is missing or not a string.

**Call relations**: The span-finding and formatting helpers use this whenever they need to identify spans by their OpenTelemetry attributes. It is a small shared reader used throughout the assertions.


##### `find_rpc_span_with_trace`  (lines 306–326)

```
fn find_rpc_span_with_trace(
    spans: &'a [SpanData],
    kind: SpanKind,
    method: &str,
    trace_id: TraceId,
) -> &'a SpanData
```

**Purpose**: Finds the JSON-RPC span for a specific method, span kind, and trace ID. If the expected span is missing, it produces a detailed failure message.

**Data flow**: It receives a list of spans, the desired span kind, JSON-RPC method name, and trace ID. It searches for a span whose kind, rpc.system, rpc.method, and trace ID all match, then returns that span; if none match, it panics with a formatted list of exported spans.

**Call relations**: Both test cases call this after waiting for spans to appear. It depends on span_attr to inspect attributes and on format_spans to make failures understandable.

*Call graph*: called by 2 (thread_start_jsonrpc_span_exports_server_span_and_parents_children, turn_start_jsonrpc_span_parents_core_turn_spans); 1 external calls (iter).


##### `find_span_with_trace`  (lines 328–346)

```
fn find_span_with_trace(
    spans: &'a [SpanData],
    trace_id: TraceId,
    description: &str,
    predicate: F,
) -> &'a SpanData
```

**Purpose**: Finds any span in a particular trace that matches a caller-supplied condition. This is used for spans that are not simply identified as JSON-RPC method spans.

**Data flow**: It receives spans, a trace ID, a human-readable description, and a predicate function. It returns the first span in that trace accepted by the predicate, or panics with a helpful dump if no match exists.

**Call relations**: The turn/start test uses this to find the core user-input span. It complements find_rpc_span_with_trace by allowing more flexible matching.

*Call graph*: called by 1 (turn_start_jsonrpc_span_parents_core_turn_spans); 1 external calls (iter).


##### `format_spans`  (lines 348–365)

```
fn format_spans(spans: &[SpanData]) -> String
```

**Purpose**: Turns a list of exported spans into readable text for assertion failures. This makes test failures explain what spans were actually recorded.

**Data flow**: It receives spans and maps each one to a line containing the span name, span ID, kind, parent ID, trace ID, and rpc.method if present. It joins those lines into one string.

**Call relations**: Several assertion and search helpers call this only when something expected is missing. It is the diagnostic “receipt” printed when tracing behavior does not match the test.

*Call graph*: 1 external calls (iter).


##### `span_depth_from_ancestor`  (lines 367–390)

```
fn span_depth_from_ancestor(
    spans: &[SpanData],
    child: &SpanData,
    ancestor: &SpanData,
) -> Option<usize>
```

**Purpose**: Checks whether one span is below another span in the parent-child tree, and how many levels down it is. This verifies that tracing has the right nesting, not just the right trace ID.

**Data flow**: It receives all spans, a possible child span, and a possible ancestor span. Starting from the child’s parent ID, it walks upward through matching parent spans until it finds the ancestor or reaches the top or a missing parent. It returns the depth if found, otherwise nothing.

**Call relations**: assert_span_descends_from calls this for a direct descendant check. The minimum-depth assertion also uses the same idea to prove that internal spans exist below a request span.

*Call graph*: called by 1 (assert_span_descends_from); 1 external calls (iter).


##### `assert_span_descends_from`  (lines 392–403)

```
fn assert_span_descends_from(spans: &[SpanData], child: &SpanData, ancestor: &SpanData)
```

**Purpose**: Fails the test unless one span is nested somewhere under another span. It is used to prove that work inside the server is attached to the incoming request span.

**Data flow**: It receives all spans, a child candidate, and an ancestor candidate. It asks span_depth_from_ancestor whether the ancestor appears in the child’s parent chain; if yes, it returns normally, and if not, it panics with the exported span list.

**Call relations**: The turn/start test uses this to confirm that the core user-input span descends from the JSON-RPC turn/start server span.

*Call graph*: calls 1 internal fn (span_depth_from_ancestor); called by 1 (turn_start_jsonrpc_span_parents_core_turn_spans); 1 external calls (panic!).


##### `assert_has_internal_descendant_at_min_depth`  (lines 405–424)

```
fn assert_has_internal_descendant_at_min_depth(
    spans: &[SpanData],
    ancestor: &SpanData,
    min_depth: usize,
)
```

**Purpose**: Fails the test unless a request span has an internal child span at least a certain number of levels below it. This checks that tracing context continues through nested server work.

**Data flow**: It receives all spans, an ancestor span, and a minimum depth. It searches for an Internal span in the same trace whose parent chain reaches the ancestor at or below that depth. If it finds one it returns; otherwise it panics with a readable span dump.

**Call relations**: The thread/start tracing test uses this after untraced and remotely traced thread/start requests. It proves that the server span is not isolated and that child work is connected underneath it.

*Call graph*: called by 1 (thread_start_jsonrpc_span_exports_server_span_and_parents_children); 2 external calls (iter, panic!).


##### `read_response`  (lines 426–455)

```
async fn read_response(
    outgoing_rx: &mut mpsc::Receiver<crate::outgoing_message::OutgoingEnvelope>,
    request_id: i64,
) -> T
```

**Purpose**: Waits for the response to a specific test request on the outgoing message channel. It ignores unrelated messages until the matching connection and request ID appear.

**Data flow**: It receives the outgoing receiver and a request ID. It repeatedly waits up to five seconds for messages, filters for messages sent to the test connection, filters again for Response messages with the requested ID, then deserializes and returns the response result.

**Call relations**: TracingHarness::request calls this after sending a request to the processor. This is how the harness turns asynchronous outgoing server messages back into a typed return value for the test.

*Call graph*: calls 1 internal fn (recv); called by 1 (request); 4 external calls (Integer, from_value, from_secs, timeout).


##### `read_thread_started_notification`  (lines 457–501)

```
async fn read_thread_started_notification(
    outgoing_rx: &mut mpsc::Receiver<crate::outgoing_message::OutgoingEnvelope>,
)
```

**Purpose**: Waits until the server emits a thread-started notification. Thread creation sends both a response and a notification, and tests need to know the notification has happened before checking related spans.

**Data flow**: It receives the outgoing receiver. It waits for messages with a five-second timeout, accepts either a direct-to-connection message for the test connection or a broadcast, filters for app-server notifications, and returns when the notification is ThreadStarted.

**Call relations**: TracingHarness::start_thread calls this after reading the thread/start response. It ensures the thread-start flow has reached the notification step before the test continues.

*Call graph*: calls 1 internal fn (recv); called by 1 (start_thread); 3 external calls (matches!, from_secs, timeout).


##### `wait_for_exported_spans`  (lines 503–526)

```
async fn wait_for_exported_spans(tracing: &TestTracing, predicate: F) -> Vec<SpanData>
```

**Purpose**: Polls the in-memory tracing exporter until the expected spans have been recorded. This avoids flaky tests caused by spans being exported slightly after the request finishes.

**Data flow**: It receives the tracing setup and a predicate that describes success. It repeatedly yields, forces the OpenTelemetry provider to flush, reads finished spans from the exporter, checks the predicate, and sleeps briefly between attempts. It returns the spans once the predicate is true or panics after timing out.

**Call relations**: Both tests use this to wait for their target spans. wait_for_new_exported_spans also builds on it when only spans after a baseline point should be considered.

*Call graph*: called by 3 (thread_start_jsonrpc_span_exports_server_span_and_parents_children, turn_start_jsonrpc_span_parents_core_turn_spans, wait_for_new_exported_spans); 5 external calls (new, panic!, from_millis, yield_now, sleep).


##### `wait_for_new_exported_spans`  (lines 528–541)

```
async fn wait_for_new_exported_spans(
    tracing: &TestTracing,
    baseline_len: usize,
    predicate: F,
) -> Vec<SpanData>
```

**Purpose**: Waits for spans created after an earlier baseline count. This helps a test separate a second request’s spans from spans produced by a previous request.

**Data flow**: It receives tracing setup, the number of spans already present, and a predicate for the new slice. It calls wait_for_exported_spans with a wrapper predicate that requires more spans than the baseline and applies the caller’s check only to the newly added spans. It returns just those new spans.

**Call relations**: The thread/start tracing test uses this after making one untraced request, then sending a second remotely traced request. It lets the assertions focus on the second request.

*Call graph*: calls 1 internal fn (wait_for_exported_spans); called by 1 (thread_start_jsonrpc_span_exports_server_span_and_parents_children).


##### `thread_start_jsonrpc_span_exports_server_span_and_parents_children`  (lines 545–633)

```
fn thread_start_jsonrpc_span_exports_server_span_and_parents_children() -> Result<()>
```

**Purpose**: Tests that a thread/start JSON-RPC request creates a server span and that tracing parent-child relationships are correct. It checks both a normal request and a request that arrives with remote trace context.

**Data flow**: It runs an async test body inside the custom single-thread runtime. The test creates a harness, sends an untraced thread/start request, waits for a server span, and checks that internal child spans exist. It then records the baseline, sends another thread/start request with a remote trace context, waits for new spans in that remote trace, and asserts the server span has the remote parent and useful descendants.

**Call relations**: This is one of the file’s main tests. It drives the harness, uses RemoteTrace::new to simulate a remote caller, uses waiting helpers to collect spans, uses find_rpc_span_with_trace to locate the request span, and uses descendant assertions to validate the trace tree.

*Call graph*: calls 7 internal fn (new, new, assert_has_internal_descendant_at_min_depth, find_rpc_span_with_trace, run_current_thread_test_with_stack, wait_for_exported_spans, wait_for_new_exported_spans); 3 external calls (assert!, assert_eq!, assert_ne!).


##### `turn_start_jsonrpc_span_parents_core_turn_spans`  (lines 637–711)

```
async fn turn_start_jsonrpc_span_parents_core_turn_spans() -> Result<()>
```

**Purpose**: Tests that a turn/start request span becomes the parent of deeper core work for the turn. In plain terms, it verifies that the app-server request and the actual user-input processing appear as one connected trace.

**Data flow**: It creates a harness, starts a thread, clears setup spans, builds a remote trace context, and sends a turn/start request with text input. It waits until both the JSON-RPC server span and a core user-input span appear in the remote trace, then checks the server span’s remote parent, turn ID attribute, and that the user-input span descends from the server span.

**Call relations**: This is the second main test in the file. It uses TracingHarness::new and start_thread for setup, sends the turn request through the harness, locates spans with find_rpc_span_with_trace and find_span_with_trace, and verifies nesting with assert_span_descends_from.

*Call graph*: calls 6 internal fn (new, new, assert_span_descends_from, find_rpc_span_with_trace, find_span_with_trace, wait_for_exported_spans); 4 external calls (Integer, assert!, assert_eq!, vec!).


### `app-server/src/request_processors/external_agent_config_processor_tests.rs`

`test` · `test run`

This is a small test file for the external agent configuration processor. The main idea is simple: some migrated items change how an agent should run, so the runtime needs to reload its sources afterward. Other migrated items, such as saved sessions, do not affect the live runtime and should not force a refresh.

The file builds tiny fake migration items, each with a chosen item type and empty optional details. It then asks the real decision function, `migration_items_need_runtime_refresh`, whether that item should trigger a runtime refresh. Think of it like checking which home repairs require turning the power off: replacing wiring does, repainting a wall does not.

The test confirms that configuration, skills, MCP server configuration, hooks, commands, and plugins all count as runtime-affecting changes. It also confirms that session migrations do not. This matters because refreshing too little can leave the agent using old behavior, while refreshing too often can waste work or interrupt state unnecessarily.

#### Function details

##### `migration_item`  (lines 3–12)

```
fn migration_item(
    item_type: ExternalAgentConfigMigrationItemType,
) -> ExternalAgentConfigMigrationItem
```

**Purpose**: This helper creates a minimal `ExternalAgentConfigMigrationItem` for a given kind of migration. It lets the test focus on the item type being checked, without repeating unrelated fields each time.

**Data flow**: It receives one migration item type. It builds a migration item using that type, an empty description, and no working directory or extra details. The result is a simple test object ready to pass into the refresh-decision function.

**Call relations**: The test function calls this helper each time it wants to check a different migration type. The helper fills in the boring parts of the item so the test can clearly show which types should or should not cause a runtime refresh.

*Call graph*: 1 external calls (new).


##### `migration_items_that_update_runtime_sources_trigger_refresh`  (lines 15–37)

```
fn migration_items_that_update_runtime_sources_trigger_refresh()
```

**Purpose**: This test verifies the rule for deciding whether migrated external agent configuration should cause the runtime to reload. It makes sure runtime-related changes trigger a refresh, while session-only changes do not.

**Data flow**: It creates one-item lists for several migration types and passes each list into `migration_items_need_runtime_refresh`. For config, skills, MCP server config, hooks, commands, and plugins, it expects `true`. For sessions, it expects `false`. If any result differs, the test fails.

**Call relations**: During the test run, this function exercises the production refresh-decision logic through `migration_items_need_runtime_refresh`. It uses `migration_item` to create the sample inputs, then uses assertions to lock in the expected behavior so future code changes do not accidentally alter it.

*Call graph*: 1 external calls (assert!).


### `app-server/src/request_processors/remote_control_processor/remote_control_processor_tests.rs`

`test` · `test run`

This is a test file for the remote control request processor. The processor is the part of the app-server that answers remote-control related JSON-RPC requests, such as starting device pairing or checking pairing status. JSON-RPC is a common request-and-response format where failures are returned as structured error objects with a code and message.

The tests focus on error behavior, which matters because clients need to know whether they made a bad request or whether the server itself could not complete the work. For example, if remote control is not available in this app-server, pairing should fail with an internal server error. If a caller asks for pairing status without any pairing code, that is a bad request and should be reported differently.

The file also checks small helper functions that translate lower-level input/output errors into JSON-RPC errors. In plain terms, it verifies the “translator” between system-level failures and client-facing messages. Some errors are user-actionable, like invalid input or missing permissions, so they become invalid-request errors. Other unexpected backend failures become internal errors. These tests protect the contract between the server and its callers: the same situation should always produce the same error shape and message.

#### Function details

##### `pairing_start_returns_internal_error_when_remote_control_is_unavailable`  (lines 7–24)

```
async fn pairing_start_returns_internal_error_when_remote_control_is_unavailable()
```

**Purpose**: This test checks that starting remote-control pairing fails cleanly when the app-server was created without a remote-control handle. A handle is the connection point to the real remote-control feature; without it, the server cannot do the work.

**Data flow**: The test starts with a request processor built with no remote-control handle and default pairing-start parameters. It asks the processor to start pairing, waits for the result, and expects an error. It then compares that error to the exact JSON-RPC internal-error object that callers should receive.

**Call relations**: During the test run, the async test runner calls this function. The test creates the processor through `new`, uses the default pairing parameters, then checks the final error with `assert_eq!` so a mismatch in code or message fails the test.

*Call graph*: calls 1 internal fn (new); 2 external calls (default, assert_eq!).


##### `pairing_status_returns_internal_error_when_remote_control_is_unavailable`  (lines 27–44)

```
async fn pairing_status_returns_internal_error_when_remote_control_is_unavailable()
```

**Purpose**: This test checks that asking for pairing status also fails with an internal error when remote control is not available. It confirms that the server does not pretend it can check pairing progress without the needed backend connection.

**Data flow**: The test builds a request processor with no remote-control handle. It sends pairing-status parameters containing a normal pairing code, waits for the call to fail, and compares the returned error with the expected JSON-RPC internal-error object.

**Call relations**: The test runner invokes this function as part of the suite. Inside, the processor is constructed with `new`, the pairing-status request is made, and `assert_eq!` verifies that the outward-facing error matches the intended contract.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `pairing_status_rejects_missing_pairing_codes`  (lines 47–60)

```
fn pairing_status_rejects_missing_pairing_codes()
```

**Purpose**: This test makes sure a pairing-status request is rejected when it contains neither kind of pairing code. Without a code, the server has no way to know which pairing attempt the caller means.

**Data flow**: The input is a pairing-status parameter object with both `pairing_code` and `manual_pairing_code` set to missing. The validation function is expected to return an invalid-request JSON-RPC error with a clear message explaining that one of the codes is required.

**Call relations**: The normal test runner calls this test. The test directly exercises the parameter validation helper and uses `assert_eq!` to lock down the exact error that should be returned before any backend work is attempted.

*Call graph*: 1 external calls (assert_eq!).


##### `pairing_status_rejects_conflicting_pairing_codes`  (lines 63–77)

```
fn pairing_status_rejects_conflicting_pairing_codes()
```

**Purpose**: This test checks that a pairing-status request is rejected when it supplies both a regular pairing code and a manual pairing code. The request must choose one path so the server does not have to guess which value to trust.

**Data flow**: The test provides parameters containing both code fields. The validation step should return an invalid-request error that says the request accepts either `pairingCode` or `manualPairingCode`, but not both.

**Call relations**: The test runner calls this function during the suite. It focuses only on the validation helper, and `assert_eq!` confirms that conflicting input is stopped early with the expected client-facing error.

*Call graph*: 1 external calls (assert_eq!).


##### `pairing_start_maps_invalid_input_to_invalid_request`  (lines 80–92)

```
fn pairing_start_maps_invalid_input_to_invalid_request()
```

**Purpose**: This test verifies that an invalid-input failure while starting pairing is reported to the client as an invalid request. That means the problem is treated as something the caller can fix, rather than a hidden server crash.

**Data flow**: The input is a simulated input/output error whose kind is `InvalidInput` and whose message says pairing is unavailable. The mapping helper turns that lower-level error into a JSON-RPC error with the invalid-request code and the same readable message.

**Call relations**: The test runner invokes this plain unit test. The test calls the pairing-start error mapper directly and uses `assert_eq!` to ensure this specific system error kind is translated into the correct JSON-RPC category.

*Call graph*: 1 external calls (assert_eq!).


##### `pairing_start_maps_backend_failures_to_internal_error`  (lines 95–104)

```
fn pairing_start_maps_backend_failures_to_internal_error()
```

**Purpose**: This test checks that unexpected pairing-start backend failures become internal server errors. This tells the client that the request may have been reasonable, but the server side failed to complete it.

**Data flow**: The test creates a generic input/output error with the message `remote control pairing failed`. The pairing-start error mapper converts it into a JSON-RPC internal-error object while preserving the message.

**Call relations**: The test runner calls this test with the rest of the unit tests. It exercises the same pairing-start mapping helper as the invalid-input test, but covers the fallback path for backend failures, with `assert_eq!` checking the exact result.

*Call graph*: 1 external calls (assert_eq!).


##### `client_management_maps_user_actionable_errors_to_invalid_request`  (lines 107–123)

```
fn client_management_maps_user_actionable_errors_to_invalid_request()
```

**Purpose**: This test verifies that several client-management failures are reported as invalid requests when the user or caller may be able to fix them. Examples include bad input, missing resources, lack of permission, or a temporary would-block condition.

**Data flow**: The test loops through several input/output error kinds. For each one, it creates an error with the same message, passes it to the client-management error mapper, and expects a JSON-RPC invalid-request error with that message.

**Call relations**: The test runner calls this unit test. Inside the loop, the mapping helper is exercised repeatedly, and `assert_eq!` ensures each user-actionable error kind follows the same client-facing rule.

*Call graph*: 1 external calls (assert_eq!).


##### `client_management_maps_backend_failures_to_internal_error`  (lines 126–135)

```
fn client_management_maps_backend_failures_to_internal_error()
```

**Purpose**: This test checks that unexpected client-management failures are reported as internal server errors. It covers the case where the caller’s request is not the main issue; something behind the scenes failed.

**Data flow**: The test starts with a generic input/output error saying client management failed. The client-management mapper converts it into a JSON-RPC internal-error object with the same message.

**Call relations**: The test runner invokes this function during the suite. It calls the client-management error mapper directly and uses `assert_eq!` to confirm the fallback behavior for backend failures.

*Call graph*: 1 external calls (assert_eq!).


### `app-server/src/request_processors/thread_processor_tests.rs`

`test` · `test runs`

This is a test file, not production code. It acts like a safety checklist for the thread processor. The thread processor is responsible for several user-visible jobs: listing threads, resuming conversations, reading saved rollout files, tracking which browser or editor connections are subscribed to a thread, and validating tools that an app wants to expose to the model.

The tests are grouped by topic. One group checks that current-working-directory filters keep absolute paths as they are and turn relative paths into full paths based on the server's current folder. Another checks pagination for background terminals, using a process id as the bookmark for the next page. The largest group checks behavior around dynamic tools, summaries, permissions, configuration loading, resume metadata, pending client requests, and thread subscription state.

A useful way to think about this file is as a set of rehearsal scenes. Each test builds a small fake world, such as a saved conversation file or two connected clients, performs one action, and then checks the exact result. Without these tests, small changes in the thread processor could silently break important promises, such as preserving an agent nickname, avoiding duplicate tool names, or cancelling a pending request when a turn is cleaned up.

#### Function details

##### `thread_list_cwd_filter_tests::normalize_thread_list_cwd_filter_preserves_absolute_paths`  (lines 9–21)

```
fn normalize_thread_list_cwd_filter_preserves_absolute_paths()
```

**Purpose**: Checks that a folder filter that is already an absolute path is not changed. This matters because users may ask for threads from an exact folder, and the server should not reinterpret that path.

**Data flow**: The test starts with one absolute folder path, using the Windows or Unix form depending on the platform. It sends that path into the path-normalizing function and expects to get back the same path wrapped in a list. Nothing else is changed.

**Call relations**: The Rust test runner calls this test. Inside the test, it calls the real normalization function and uses an equality check to prove that absolute paths pass through unchanged.

*Call graph*: 3 external calls (from, assert_eq!, cfg!).


##### `thread_list_cwd_filter_tests::normalize_thread_list_cwd_filter_resolves_relative_paths_against_server_cwd`  (lines 24–36)

```
fn normalize_thread_list_cwd_filter_resolves_relative_paths_against_server_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that a relative folder filter, such as `repo-b`, is converted into a full path using the server's current working directory. This prevents thread filtering from depending on vague or ambiguous path text.

**Data flow**: The test first computes what `repo-b` should mean from the current directory. It then passes a relative filter into the normalizer and expects the result to be the computed full path. It returns success only if both paths match.

**Call relations**: The test runner calls this test. The test uses the absolute-path helper to build the expected answer, then calls the production normalizer to compare actual behavior against that expectation.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 1 external calls (assert_eq!).


##### `background_terminal_pagination_tests::terminal`  (lines 45–57)

```
fn terminal(process_id: &str) -> ThreadBackgroundTerminal
```

**Purpose**: Builds a small fake background terminal record for tests. It lets pagination tests focus on ordering and cursors instead of repeating setup details.

**Data flow**: A process id string goes in. The helper creates a terminal object with matching item id, process id, command text, and a fixed absolute current folder. The completed fake terminal record comes out.

**Call relations**: This helper is called by the background terminal pagination test whenever it needs sample terminal data. It hands those sample records to the real pagination function.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (cfg!, format!).


##### `background_terminal_pagination_tests::paginates_with_process_id_cursor`  (lines 60–95)

```
fn paginates_with_process_id_cursor()
```

**Purpose**: Checks that background terminal pagination uses the process id as a stable cursor, or bookmark. It also checks that a missing cursor is treated as an error.

**Data flow**: The test creates five fake terminals, asks for two at a time, and checks that the returned data and next cursor match the expected process ids. It then tries again after removing the cursor's original terminal to confirm pagination can still continue from the next larger item. Finally, it passes a totally missing cursor and expects an error.

**Call relations**: The test runner calls this test. The test repeatedly calls the production `paginate_background_terminals` function with different terminal lists and cursors, then checks the page data and next bookmark.

*Call graph*: 4 external calls (assert!, assert_eq!, paginate_background_terminals, vec!).


##### `thread_processor_behavior_tests::forked_from_id_from_rollout`  (lines 99–105)

```
async fn forked_from_id_from_rollout(path: &Path) -> Option<String>
```

**Purpose**: Reads a saved rollout file and extracts the id of the thread it was forked from, if one exists. It is a small helper used by a test that verifies fork history is preserved.

**Data flow**: A path to a rollout file goes in. The helper asks core code to read the session metadata line, looks for `forked_from_id`, converts it to text if found, and returns either that text or nothing.

**Call relations**: The rollout preservation test calls this helper after writing a fake rollout file. The helper delegates the actual file parsing to `read_session_meta_line` and returns just the one field the test cares about.

*Call graph*: 1 external calls (read_session_meta_line).


##### `thread_processor_behavior_tests::dynamic_tool`  (lines 152–174)

```
fn dynamic_tool(
        namespace: Option<&str>,
        name: impl Into<String>,
        input_schema: Value,
        defer_loading: bool,
    ) -> DynamicToolSpec
```

**Purpose**: Builds a fake dynamic tool definition for validation tests. A dynamic tool is a tool supplied at runtime, rather than built into the server.

**Data flow**: The caller provides an optional namespace, a tool name, a JSON input schema, and a flag saying whether loading is delayed. The helper builds either a standalone function tool or a namespaced tool containing that function, then returns it.

**Call relations**: Many dynamic-tool validation tests call this helper to create test inputs. It keeps those tests short while still feeding realistic tool definitions into `validate_dynamic_tools`.

*Call graph*: 4 external calls (into, Function, Namespace, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_unsupported_input_schema`  (lines 177–186)

```
fn validate_dynamic_tools_rejects_unsupported_input_schema()
```

**Purpose**: Checks that a dynamic tool with an unsupported input schema is rejected. This protects the model and server from receiving tool definitions they cannot safely understand.

**Data flow**: The test builds one fake tool whose schema says its input is `null`. It passes that tool to validation and expects an error message that names the bad tool.

**Call relations**: The test runner calls this test. It uses the `dynamic_tool` helper to prepare input, then calls the production validation function and checks the failure text.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_sanitizable_input_schema`  (lines 189–198)

```
fn validate_dynamic_tools_accepts_sanitizable_input_schema()
```

**Purpose**: Checks that a common but incomplete schema can still be accepted when the core code can clean it up safely. This avoids rejecting reasonable tool definitions just because they omit a detail such as `type`.

**Data flow**: The test builds one tool with a schema that has properties but no explicit type. It sends the tool to validation and expects success.

**Call relations**: The test runner calls this test. It uses the shared tool builder, then exercises `validate_dynamic_tools` to confirm the production validator allows schemas that can be sanitized.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_nullable_field_schema`  (lines 201–216)

```
fn validate_dynamic_tools_accepts_nullable_field_schema()
```

**Purpose**: Checks that a tool schema may allow a field to be either a string or null. This matters because many real tool inputs have optional or nullable values.

**Data flow**: The test builds a tool whose `query` field accepts both text and null. It validates the tool and expects no error.

**Call relations**: The test runner calls this test. It prepares a realistic JSON schema and hands it to `validate_dynamic_tools` through the helper-built tool object.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_same_name_in_different_namespaces`  (lines 219–243)

```
fn validate_dynamic_tools_accepts_same_name_in_different_namespaces()
```

**Purpose**: Checks that two tools can share the same function name when they live in different namespaces. A namespace is a named group, like two different apps both having a `search` command.

**Data flow**: The test creates two namespaced tools with the same function name but different namespace names. It validates the list and expects success.

**Call relations**: The test runner calls this test. It uses the helper to create both tool groups, then calls the production validator to confirm names only need to be unique inside their own namespace.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_responses_compatible_identifiers`  (lines 246–258)

```
fn validate_dynamic_tools_accepts_responses_compatible_identifiers()
```

**Purpose**: Checks that tool and namespace names using letters, numbers, underscores, and hyphens are accepted. These are the identifier characters supported by the Responses API, the model API used for tool calls.

**Data flow**: The test builds one namespaced tool with names like `Codex-App_2` and `lookup-ticket_2`. It validates the tool list and expects success.

**Call relations**: The test runner calls this test. The test sends a valid identifier example into `validate_dynamic_tools` to prove the naming rule is not too strict.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_duplicate_name_in_same_namespace`  (lines 261–285)

```
fn validate_dynamic_tools_rejects_duplicate_name_in_same_namespace()
```

**Purpose**: Checks that a namespace cannot contain two functions with the same name. This prevents ambiguity when the model or server tries to call a tool.

**Data flow**: The test builds one namespace containing two identical function definitions. It validates the namespace and expects an error that mentions both the namespace and duplicated function name.

**Call relations**: The test runner calls this test. The test constructs the duplicate tool list directly, then calls `validate_dynamic_tools` to verify the production validator catches the conflict.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::thread_turns_list_merges_in_progress_active_turn_before_agent_status_running`  (lines 288–325)

```
fn thread_turns_list_merges_in_progress_active_turn_before_agent_status_running()
```

**Purpose**: Checks that an in-progress live turn appears in the thread's turn list even when the stored history says the thread is idle. This prevents the user interface from hiding a currently active user message.

**Data flow**: The test creates one persisted user message and one live active turn. It asks the reconstruction function to build the visible turns list and expects the live turn to appear as the last item.

**Call relations**: The test runner calls this test. It feeds fake persisted and live turn data into `reconstruct_thread_turns_for_turns_list`, then checks that the reconstructed list includes the active turn.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_empty_namespace`  (lines 328–341)

```
fn validate_dynamic_tools_rejects_empty_namespace()
```

**Purpose**: Checks that a dynamic tool namespace cannot be an empty string. Empty group names would make tool names hard to address and error messages unclear.

**Data flow**: The test creates a tool in an empty namespace, runs validation, and expects an error mentioning the namespace problem.

**Call relations**: The test runner calls this test. It uses the shared helper to build invalid input, then relies on `validate_dynamic_tools` to reject it.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_reserved_namespace`  (lines 344–357)

```
fn validate_dynamic_tools_rejects_reserved_namespace()
```

**Purpose**: Checks that a namespace pattern reserved for MCP-style tool names is rejected. Reserved names are blocked so user-supplied tools do not collide with server-generated tool naming.

**Data flow**: The test creates a namespaced tool using a reserved namespace prefix. It validates the list and expects an error that says the namespace is reserved.

**Call relations**: The test runner calls this test. It builds a deliberately reserved namespace and sends it through the production dynamic-tool validator.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_name_not_supported_by_responses`  (lines 360–377)

```
fn validate_dynamic_tools_rejects_name_not_supported_by_responses()
```

**Purpose**: Checks that a tool function name containing a dot is rejected because the Responses API does not allow that form. This avoids sending invalid tool definitions to the model API.

**Data flow**: The test builds a tool named `lookup.ticket`, validates it, and expects an error that includes the bad name and the allowed name pattern.

**Call relations**: The test runner calls this test. It uses `validate_dynamic_tools` as the gatekeeper and checks that the error explains the Responses API naming rule.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_namespace_not_supported_by_responses`  (lines 380–397)

```
fn validate_dynamic_tools_rejects_namespace_not_supported_by_responses()
```

**Purpose**: Checks that namespace names must also follow the Responses API naming rules. A namespace with a dot is rejected for the same reason as a bad tool name.

**Data flow**: The test builds a tool in namespace `codex.app`, runs validation, and expects an error naming the invalid namespace and showing the allowed pattern.

**Call relations**: The test runner calls this test. It sends invalid namespace input into `validate_dynamic_tools` and checks that the production error is helpful.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_name_longer_than_responses_limit`  (lines 400–415)

```
fn validate_dynamic_tools_rejects_name_longer_than_responses_limit()
```

**Purpose**: Checks that tool names longer than the Responses API limit are rejected. This prevents the server from accepting a tool it could not later send to the model API.

**Data flow**: The test creates a 129-character tool name, validates it, and expects an error saying the limit is 128 characters and including the long name.

**Call relations**: The test runner calls this test. It uses the shared tool builder and the production validator to confirm the length rule is enforced.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_namespace_fields_over_limits`  (lines 418–441)

```
fn validate_dynamic_tools_rejects_namespace_fields_over_limits()
```

**Purpose**: Checks that namespace names and namespace descriptions obey their length limits. These limits keep dynamic tool metadata compatible with downstream APIs.

**Data flow**: The test first creates a namespace name that is too long and expects validation to fail. It then shortens the name but makes the description too long, validates again, and expects a second failure.

**Call relations**: The test runner calls this test. It mutates the same tool definition between validation calls so it can check both namespace-name and namespace-description limits.

*Call graph*: 3 external calls (assert!, unreachable!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_reserved_responses_namespace`  (lines 444–458)

```
fn validate_dynamic_tools_rejects_reserved_responses_namespace()
```

**Purpose**: Checks that `functions`, a namespace reserved by the Responses API, cannot be used for dynamic tools. This avoids conflicts with the API's own tool organization.

**Data flow**: The test creates a tool under the namespace `functions`, validates it, and expects an error that mentions both the namespace and the Responses API.

**Call relations**: The test runner calls this test. It feeds a reserved Responses namespace into `validate_dynamic_tools` and checks that the validator blocks it.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::summary_from_stored_thread_preserves_millisecond_precision`  (lines 461–507)

```
fn summary_from_stored_thread_preserves_millisecond_precision()
```

**Purpose**: Checks that summaries made from stored thread records keep millisecond-level timestamps. This matters when clients sort or display conversations using precise times.

**Data flow**: The test builds a stored thread with creation and update timestamps containing milliseconds. It converts that record into a summary and expects the timestamp strings to still include `.678` and `.789`.

**Call relations**: The test runner calls this test. It constructs a realistic `StoredThread`, passes it to `summary_from_stored_thread`, and checks the resulting summary fields.

*Call graph*: calls 2 internal fn (read_only, from_string); 3 external calls (parse_from_rfc3339, from, assert_eq!).


##### `thread_processor_behavior_tests::requested_permissions_trust_project_uses_permission_profile_intent`  (lines 510–583)

```
fn requested_permissions_trust_project_uses_permission_profile_intent()
```

**Purpose**: Checks how the server decides whether requested permissions mean the user is trusting the project. Write-capable profiles count as trust; read-only profiles do not.

**Data flow**: The test builds several permission override examples: full access, workspace write, split write rules, and read-only. It asks `requested_permissions_trust_project` about each one and expects true for write-capable settings and false for read-only settings.

**Call relations**: The test runner calls this test. It uses permission-profile constructors from protocol code, then calls the production trust-checking function for each case.

*Call graph*: calls 4 internal fn (from_runtime_permissions, read_only, workspace_write, restricted); 3 external calls (assert!, test_path_buf, vec!).


##### `thread_processor_behavior_tests::config_load_error_marks_cloud_config_bundle_failures_for_relogin`  (lines 586–610)

```
fn config_load_error_marks_cloud_config_bundle_failures_for_relogin()
```

**Purpose**: Checks that an authentication failure while loading cloud configuration is reported with enough structured data for the client to ask the user to log in again.

**Data flow**: The test wraps a cloud config authentication error in an I/O error, converts it with `config_load_error`, and expects the result to include reason, error code, relogin action, status code, and detail text.

**Call relations**: The test runner calls this test. It creates a specific cloud-config error and verifies that the production error-formatting function turns it into client-friendly JSON data.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, other).


##### `thread_processor_behavior_tests::config_load_error_leaves_non_cloud_config_bundle_failures_unmarked`  (lines 613–624)

```
fn config_load_error_leaves_non_cloud_config_bundle_failures_unmarked()
```

**Purpose**: Checks that ordinary configuration load failures are not mislabeled as cloud bundle failures. This prevents clients from showing the wrong recovery action.

**Data flow**: The test creates a plain I/O error, sends it to `config_load_error`, and expects no structured data while still expecting a general configuration failure message.

**Call relations**: The test runner calls this test. It exercises the same production error conversion path as cloud failures, but with a non-cloud error.

*Call graph*: 3 external calls (assert!, assert_eq!, other).


##### `thread_processor_behavior_tests::config_load_error_marks_non_auth_cloud_config_bundle_failures_without_relogin`  (lines 627–644)

```
fn config_load_error_marks_non_auth_cloud_config_bundle_failures_without_relogin()
```

**Purpose**: Checks that a non-authentication cloud configuration failure is marked as a cloud bundle problem but does not ask the user to relogin.

**Data flow**: The test creates a cloud config request-failed error with no HTTP status code. After conversion, it expects structured data with reason, error code, and detail, but no relogin action.

**Call relations**: The test runner calls this test. It uses `CloudConfigBundleLoadError::new` to create the input and `config_load_error` to check production formatting.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, other).


##### `thread_processor_behavior_tests::config_load_error_marks_invalid_cloud_config_bundle_failures_without_relogin`  (lines 647–664)

```
fn config_load_error_marks_invalid_cloud_config_bundle_failures_without_relogin()
```

**Purpose**: Checks that an invalid cloud configuration bundle is reported as such, without suggesting login repair. This helps clients distinguish bad policy data from authentication trouble.

**Data flow**: The test creates an invalid-bundle error, converts it, and expects structured data containing the cloud bundle reason, invalid-bundle code, and detail message.

**Call relations**: The test runner calls this test. It feeds an invalid-bundle error through the production error conversion function and checks the client-facing payload.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, other).


##### `thread_processor_behavior_tests::derive_config_from_params_uses_session_thread_config_model_provider`  (lines 667–730)

```
async fn derive_config_from_params_uses_session_thread_config_model_provider() -> Result<()>
```

**Purpose**: Checks that session-level thread configuration wins over request-level overrides for model provider data and feature settings. This protects server-controlled session policy from being accidentally overwritten by a request.

**Data flow**: The test creates a temporary config manager with a session model provider and plugin feature disabled. It then loads config with request overrides that try to change the provider and enable plugins. The final config should still use the session provider and keep plugins disabled, while allowing an unrelated bypass setting.

**Call relations**: The async test runner calls this test. The test builds a real `ConfigManager`, loads configuration through its normal async path, and checks the resulting config object.

*Call graph*: calls 3 internal fn (new, default, new); 11 external calls (new, from, new, new, default, assert!, assert_eq!, default, default, json! (+1 more)).


##### `thread_processor_behavior_tests::collect_resume_override_mismatches_includes_service_tier`  (lines 733–788)

```
fn collect_resume_override_mismatches_includes_service_tier()
```

**Purpose**: Checks that resume diagnostics include service tier mismatches. A service tier is a requested level of model service, such as priority or flex.

**Data flow**: The test builds a resume request asking for one service tier and a saved config snapshot showing another. It asks the mismatch collector for differences and expects one message describing the requested and active tiers.

**Call relations**: The test runner calls this test. It builds both sides of the comparison and sends them to `collect_resume_override_mismatches`, which produces the human-readable mismatch list.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, test_path_buf).


##### `thread_processor_behavior_tests::test_thread_metadata`  (lines 790–806)

```
fn test_thread_metadata(
        model: Option<&str>,
        reasoning_effort: Option<ReasoningEffort>,
    ) -> Result<ThreadMetadata>
```

**Purpose**: Builds a small thread metadata object for resume and summary tests. It avoids repeating the same thread id, rollout path, provider, and timestamp setup.

**Data flow**: Optional model and reasoning-effort values go in. The helper creates metadata with a fixed thread id and mock provider, inserts the optional values, and returns the completed metadata or an error if setup fails.

**Call relations**: Several tests call this helper before exercising summary formatting or resume metadata merging. It delegates basic metadata construction to `ThreadMetadataBuilder`.

*Call graph*: calls 2 internal fn (from_string, new); 3 external calls (from, now, default).


##### `thread_processor_behavior_tests::summary_from_thread_metadata_formats_protocol_timestamps_as_seconds`  (lines 809–822)

```
fn summary_from_thread_metadata_formats_protocol_timestamps_as_seconds() -> Result<()>
```

**Purpose**: Checks that protocol-facing summaries made from thread metadata format timestamps to whole seconds. This confirms this conversion intentionally differs from stored-thread summaries that keep milliseconds.

**Data flow**: The test creates metadata, sets creation and update times with milliseconds, converts it to a summary, and expects timestamp strings without the millisecond part.

**Call relations**: The test runner calls this test. It uses `test_thread_metadata` for setup, then calls `summary_from_thread_metadata` and checks the formatted timestamp fields.

*Call graph*: 3 external calls (parse_from_rfc3339, test_thread_metadata, assert_eq!).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_prefers_persisted_model_and_reasoning_effort`  (lines 825–854)

```
fn merge_persisted_resume_metadata_prefers_persisted_model_and_reasoning_effort() -> Result<()>
```

**Purpose**: Checks that, when resuming a thread with no explicit overrides, the server restores the persisted model, model provider, and reasoning effort. Reasoning effort is the model's requested depth of thinking.

**Data flow**: The test starts with empty override containers and metadata containing a model and high reasoning effort. After merging, the typed overrides should contain the persisted model and provider, and the raw request overrides should contain high reasoning effort.

**Call relations**: The test runner calls this test. It uses `test_thread_metadata` for persisted data, then calls `merge_persisted_resume_metadata` to verify resume defaults are restored.

*Call graph*: 3 external calls (test_thread_metadata, assert_eq!, default).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_preserves_explicit_overrides`  (lines 857–885)

```
fn merge_persisted_resume_metadata_preserves_explicit_overrides() -> Result<()>
```

**Purpose**: Checks that explicit resume overrides from the request are not overwritten by persisted metadata. User or caller choices should win over old saved settings.

**Data flow**: The test starts with an explicit low reasoning effort and explicit newer model, while persisted metadata has a different model and high effort. After merging, the explicit values should remain and the persisted provider should not be injected.

**Call relations**: The test runner calls this test. It prepares both explicit request choices and persisted metadata, then checks that `merge_persisted_resume_metadata` respects the explicit choices.

*Call graph*: 5 external calls (default, from, test_thread_metadata, assert_eq!, String).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_persisted_values_when_model_overridden`  (lines 888–914)

```
fn merge_persisted_resume_metadata_skips_persisted_values_when_model_overridden() -> Result<()>
```

**Purpose**: Checks that if the raw request overrides the model, persisted model-related values are not copied in. This avoids mixing a caller-chosen model with an old provider or reasoning setup.

**Data flow**: The test starts with a raw request model override and no typed overrides. After merging with persisted metadata, the request model remains the only override and no persisted model or provider is added.

**Call relations**: The test runner calls this test. It passes a request override map and persisted metadata to `merge_persisted_resume_metadata`, then checks the map and typed overrides.

*Call graph*: 5 external calls (from, test_thread_metadata, assert_eq!, default, String).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_persisted_values_when_provider_overridden`  (lines 917–937)

```
fn merge_persisted_resume_metadata_skips_persisted_values_when_provider_overridden() -> Result<()>
```

**Purpose**: Checks that if the caller explicitly chooses a model provider, persisted model settings are not copied in. This keeps resumed configuration internally consistent.

**Data flow**: The test starts with a typed provider override of `oss` and persisted metadata from a mock provider. After merging, the explicit provider remains, no model is copied, and no raw request overrides are added.

**Call relations**: The test runner calls this test. It sets up an explicit provider override, calls `merge_persisted_resume_metadata`, and verifies persisted values are skipped.

*Call graph*: 3 external calls (default, test_thread_metadata, assert_eq!).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_persisted_values_when_reasoning_effort_overridden`  (lines 940–966)

```
fn merge_persisted_resume_metadata_skips_persisted_values_when_reasoning_effort_overridden() -> Result<()>
```

**Purpose**: Checks that an explicit reasoning-effort override prevents persisted model-related values from being restored. This avoids combining incompatible old and new model settings.

**Data flow**: The test starts with a raw reasoning-effort override of low and persisted metadata with a model and high effort. After merging, only the explicit low effort remains; no persisted model or provider is added.

**Call relations**: The test runner calls this test. It sends the override map and metadata into `merge_persisted_resume_metadata` and checks that the request's reasoning choice wins.

*Call graph*: 5 external calls (from, test_thread_metadata, assert_eq!, default, String).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_missing_values`  (lines 969–988)

```
fn merge_persisted_resume_metadata_skips_missing_values() -> Result<()>
```

**Purpose**: Checks behavior when persisted metadata has no model or reasoning effort. The provider can still be restored, but missing fields should not create fake overrides.

**Data flow**: The test creates metadata with no model and no reasoning effort, then merges it into empty overrides. The provider is copied, while model and raw reasoning overrides remain absent.

**Call relations**: The test runner calls this test. It relies on `test_thread_metadata` to create sparse metadata, then checks `merge_persisted_resume_metadata` handles missing values cleanly.

*Call graph*: 3 external calls (test_thread_metadata, assert_eq!, default).


##### `thread_processor_behavior_tests::read_summary_from_rollout_returns_empty_preview_when_no_user_message`  (lines 991–1044)

```
async fn read_summary_from_rollout_returns_empty_preview_when_no_user_message() -> Result<()>
```

**Purpose**: Checks that reading a rollout file with only session metadata returns an empty preview instead of failing or inventing text. A rollout file is the saved line-by-line record of a conversation.

**Data flow**: The test writes a temporary rollout file containing one session metadata line and no user message. It sets the file's modified time, reads a summary from the file, and expects an empty preview plus the correct ids, timestamps, path, provider fallback, and defaults.

**Call relations**: The async test runner calls this test. The test writes a real temporary file, then calls `read_summary_from_rollout`, checking that production file-reading code handles a minimal rollout.

*Call graph*: calls 2 internal fn (default, from_string); 10 external calls (new, new, new, new, assert_eq!, parse_from_rfc3339, format!, write, SessionMeta, new).


##### `thread_processor_behavior_tests::read_summary_from_rollout_preserves_agent_nickname`  (lines 1047–1094)

```
async fn read_summary_from_rollout_preserves_agent_nickname() -> Result<()>
```

**Purpose**: Checks that agent nickname and role stored in a rollout file survive summary reading and conversion to a thread object. This matters for subagents that have user-visible identities.

**Data flow**: The test writes session metadata for a subagent with nickname `atlas` and role `explorer`. It reads the rollout summary, converts that summary into a thread, and expects the nickname and role to be present.

**Call relations**: The async test runner calls this test. It exercises `read_summary_from_rollout` and then `summary_to_thread`, proving the identity fields move through both steps.

*Call graph*: calls 3 internal fn (default, from_string, from_absolute_path); 6 external calls (new, SubAgent, assert_eq!, format!, write, SessionMeta).


##### `thread_processor_behavior_tests::read_summary_from_rollout_preserves_forked_from_id`  (lines 1097–1132)

```
async fn read_summary_from_rollout_preserves_forked_from_id() -> Result<()>
```

**Purpose**: Checks that a rollout file keeps track of which thread it was forked from. This is important for showing thread ancestry and resume history.

**Data flow**: The test writes a rollout session metadata line containing a `forked_from_id`. It then reads that field back through the helper and expects the same id as text.

**Call relations**: The async test runner calls this test. It writes a temporary rollout file and uses `forked_from_id_from_rollout`, which delegates parsing to core session metadata reading.

*Call graph*: calls 2 internal fn (default, from_string); 5 external calls (new, assert_eq!, format!, write, SessionMeta).


##### `thread_processor_behavior_tests::aborting_pending_request_clears_pending_state`  (lines 1135–1196)

```
async fn aborting_pending_request_clears_pending_state() -> Result<()>
```

**Purpose**: Checks that aborting pending server-to-client requests resolves the waiting callback with a clear error and removes the request from pending state. This prevents stale requests from hanging after a turn changes.

**Data flow**: The test creates an outgoing message sender, sends a tool user-input request to one connection, then aborts pending requests. It reads the outgoing request, waits for the callback result, expects a turn-transition error, and confirms there are no pending requests left.

**Call relations**: The async test runner calls this test. It uses real outgoing-message sender objects and calls `abort_pending_server_requests` on the thread-scoped sender to verify cleanup behavior.

*Call graph*: calls 4 internal fn (disabled, new, new, from_string); 7 external calls (new, ToolRequestUserInput, assert!, assert_eq!, panic!, channel, vec!).


##### `thread_processor_behavior_tests::summary_from_state_db_metadata_preserves_agent_nickname`  (lines 1199–1235)

```
fn summary_from_state_db_metadata_preserves_agent_nickname() -> Result<()>
```

**Purpose**: Checks that summaries built from database metadata preserve subagent nickname and role. This covers the database path, separate from the rollout-file path.

**Data flow**: The test builds state database metadata values, including serialized subagent source, nickname, and role. It converts them into a summary, then into a thread, and expects the nickname and role to remain.

**Call relations**: The test runner calls this test. It exercises `summary_from_state_db_metadata` followed by `summary_to_thread`, proving agent identity is preserved across both conversions.

*Call graph*: calls 2 internal fn (from_string, from_absolute_path); 4 external calls (from, SubAgent, assert_eq!, to_string).


##### `thread_processor_behavior_tests::removing_thread_state_clears_listener_and_active_turn_history`  (lines 1238–1279)

```
async fn removing_thread_state_clears_listener_and_active_turn_history() -> Result<()>
```

**Purpose**: Checks that removing a thread's state cancels its listener, removes subscribers, and clears active-turn history. This prevents old live state from leaking into a later use of the same thread id.

**Data flow**: The test creates a state manager, registers a connection, subscribes it to a thread, stores a cancel sender, and records a turn-start event. After removing the thread state, it expects the cancel signal to fire, subscriptions to be empty, and active-turn snapshot to be gone.

**Call relations**: The async test runner calls this test. It exercises `ThreadStateManager` methods for connection setup, subscription, event tracking, and full thread-state removal.

*Call graph*: calls 2 internal fn (new, from_string); 6 external calls (default, default, assert!, assert_eq!, channel, TurnStarted).


##### `thread_processor_behavior_tests::removing_auto_attached_connection_preserves_listener_for_other_connections`  (lines 1282–1330)

```
async fn removing_auto_attached_connection_preserves_listener_for_other_connections() -> Result<()>
```

**Purpose**: Checks that removing one subscribed connection does not cancel the thread listener while another connection is still subscribed. A thread should stay alive as long as at least one client is watching it.

**Data flow**: The test creates two connections subscribed to the same thread and attaches a cancel sender to the thread state. It removes one connection, expects no cancel signal, and confirms the other connection remains subscribed.

**Call relations**: The async test runner calls this test. It drives `ThreadStateManager::remove_connection` and subscription lookup to verify partial disconnect behavior.

*Call graph*: calls 2 internal fn (new, from_string); 4 external calls (default, assert!, assert_eq!, channel).


##### `thread_processor_behavior_tests::adding_connection_to_thread_updates_has_connections_watcher`  (lines 1333–1381)

```
async fn adding_connection_to_thread_updates_has_connections_watcher() -> Result<()>
```

**Purpose**: Checks that a watcher tracking whether a thread has any connections updates when connections are removed and added. This lets other tasks react when a thread becomes watched or unwatched.

**Data flow**: The test subscribes one connection, creates a has-connections watcher, and confirms it starts as true. It unsubscribes that connection and waits for the watcher to become false, then adds another connection and waits for it to become true again.

**Call relations**: The async test runner calls this test. It uses `ThreadStateManager` subscription methods and the watch receiver returned by `subscribe_to_has_connections`.

*Call graph*: calls 2 internal fn (new, from_string); 4 external calls (from_secs, default, assert!, timeout).


##### `thread_processor_behavior_tests::closed_connection_cannot_be_reintroduced_by_auto_subscribe`  (lines 1384–1405)

```
async fn closed_connection_cannot_be_reintroduced_by_auto_subscribe() -> Result<()>
```

**Purpose**: Checks that once a connection is removed, auto-subscribe logic cannot silently bring it back. This prevents closed clients from being treated as active subscribers.

**Data flow**: The test initializes one connection, removes it, then tries to auto-subscribe it to a thread. The attempt should return nothing, and the thread should have no subscribers.

**Call relations**: The async test runner calls this test. It exercises `remove_connection`, then calls `try_ensure_connection_subscribed` to make sure the state manager remembers the connection is closed.

*Call graph*: calls 2 internal fn (new, from_string); 3 external calls (default, assert!, assert_eq!).


##### `thread_processor_behavior_tests::first_attestation_capable_connection_for_thread_only_uses_thread_subscribers`  (lines 1408–1480)

```
async fn first_attestation_capable_connection_for_thread_only_uses_thread_subscribers() -> Result<()>
```

**Purpose**: Checks that the server chooses the first attestation-capable connection from the thread's own subscribers, not from unrelated connections. Attestation here means a client can answer a trust or identity challenge.

**Data flow**: The test creates several connections, some able to request attestation and some not, and subscribes them to two different threads. It asks for the first attestation-capable connection for each thread and expects the earliest suitable subscriber for that specific thread.

**Call relations**: The async test runner calls this test. It drives `ThreadStateManager` connection registration, thread subscription, and attestation-capable lookup to confirm the selection is scoped correctly.

*Call graph*: calls 2 internal fn (new, from_string); 3 external calls (default, assert!, assert_eq!).


### `app-server/src/request_processors/thread_summary_tests.rs`

`test` · `test suite`

This test protects a small but important user-facing behavior: when the app builds a short preview of a saved conversation, it should show what the user actually asked for. Some conversation logs can contain earlier instruction blocks, such as AGENTS.md project guidance, stored in the same general shape as user messages. If the summary picked those first, the conversation list could show a confusing preview like project instructions instead of the user’s real request.

The test builds a tiny fake conversation log. The first item is session metadata, like the conversation id, time, working folder, command-line version, and model provider. Then it adds two user messages: one that looks like injected project instructions, and one that contains prior context followed by the real user text, marked by USER_MESSAGE_BEGIN. It turns the metadata JSON into a SessionMeta value, asks extract_conversation_summary to produce a ConversationSummary, and compares the result with the exact expected summary.

The key expectation is the preview field: it must be “Count to 5”. That proves the summary logic knows how to skip boilerplate context and instruction text and prefer the plain user message that matters.

#### Function details

##### `extract_conversation_summary_prefers_plain_user_messages`  (lines 9–68)

```
fn extract_conversation_summary_prefers_plain_user_messages() -> Result<()>
```

**Purpose**: This test proves that conversation summaries choose the real user request as their preview, even when earlier stored messages contain project instructions. It helps prevent misleading conversation titles or previews in the user interface.

**Data flow**: The test starts with hard-coded sample data: a conversation id, timestamp, fake log path, metadata, an instruction-style user message, and a real user prompt hidden after a marker. It converts the metadata into the same kind of session data the app normally reads, sends all of that into extract_conversation_summary, then checks the returned ConversationSummary against the expected one. The important before-to-after change is that a noisy log becomes a clean summary whose preview is “Count to 5”.

**Call relations**: During the test, it uses from_string to turn a text id into the app’s ThreadId type, builds the fake log entries, calls the summary-building code under test, and then uses assert_eq! to compare the actual result with the expected result. In the larger flow, this test stands guard over extract_conversation_summary so future changes do not accidentally make instruction blocks appear as the conversation preview.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (from, assert_eq!, vec!).


### Shared fixture primitives
These reusable helpers create the mock auth state, config files, cached models, canned responses, rollout data, and fake backend services that integration tests build on.

### `app-server/tests/common/analytics_server.rs`

`test` · `test setup`

Some parts of the app-server appear to send analytics events to an HTTP endpoint. In tests, using the real analytics service would be slow, unreliable, and could leak test data. This file solves that by creating a small mock web server: a pretend server that listens like the real one but returns controlled responses.

The helper starts a `wiremock` mock server, which is a testing tool for faking HTTP services. It then teaches that server one rule: when it receives a POST request to `/codex/analytics-events/events`, reply with HTTP status 200, meaning “OK.” This is like putting a cardboard storefront in front of the application during a rehearsal: the app can walk up and make the request, but nothing real happens behind the scenes.

The function returns the running mock server to the test. Tests can then point the application’s analytics URL at this server and verify that analytics sending does not fail. Without this helper, each test that needs analytics would have to rebuild the same fake server setup, or risk depending on a real network service.

#### Function details

##### `start_analytics_events_server`  (lines 8–16)

```
async fn start_analytics_events_server() -> Result<MockServer>
```

**Purpose**: Starts a fake analytics events HTTP server for tests. It accepts POST requests at the analytics events path and always answers with a successful 200 response.

**Data flow**: No input is required. The function creates a new mock server, adds a rule for POST requests to `/codex/analytics-events/events`, and attaches that rule to the server. It returns the running `MockServer`, or an error if setup fails.

**Call relations**: A test calls this before exercising code that sends analytics events. Inside, it relies on `wiremock` helpers to start the server, describe the expected HTTP method and path, create the success response, and mount that behavior onto the server.

*Call graph*: 5 external calls (given, start, new, method, path).


### `app-server/tests/common/auth_fixtures.rs`

`test` · `test setup`

Many app-server tests need to start from the same situation: “the user is logged in with ChatGPT.” In the real product, that login state lives in an auth.json file and includes tokens, account IDs, plan information, and refresh timing. Creating that by hand in every test would be noisy and easy to get wrong, so this file provides small builder objects that assemble the fake login record consistently.

The main helper, ChatGptAuthFixture, is like a test recipe card. A test starts with an access token, then optionally fills in details such as a refresh token, email address, plan type, ChatGPT user ID, account ID, or the last time the login was refreshed. ChatGptIdTokenClaims holds the pieces that normally live inside an ID token, which is a signed-looking package of user information.

The file also creates a simple fake JWT, meaning a “JSON Web Token” made of base64-encoded JSON parts. It does not try to be secure; it only needs to look realistic enough for the project’s parser. Finally, write_chatgpt_auth converts the fixture into the project’s normal AuthDotJson structure and saves it using the same save path production code uses. Without this file, tests would duplicate fragile auth setup or need real login flows, making them slower and less reliable.

#### Function details

##### `ChatGptAuthFixture::new`  (lines 29–37)

```
fn new(access_token: impl Into<String>) -> Self
```

**Purpose**: Creates a new fake ChatGPT authentication fixture with the required access token and sensible defaults for everything else. Tests use this as the starting point before adding only the details they care about.

**Data flow**: It takes an access token value, turns it into a string, and stores it. It also fills in a default refresh token, no account ID, default empty ID-token claims, and no explicit last-refresh setting; the result is a ready-to-customize ChatGptAuthFixture.

**Call relations**: This is the doorway into the fixture builder. Many authentication and account tests call it first, then optionally chain other builder methods, and eventually pass the finished fixture to write_chatgpt_auth so the fake login can be written to disk.

*Call graph*: called by 100 (get_auth_status_omits_token_after_permanent_refresh_failure, get_auth_status_omits_token_after_proactive_refresh_failure, get_auth_status_returns_token_after_proactive_refresh_recovery, get_account_omits_chatgpt_after_permanent_refresh_failure, get_account_with_chatgpt, get_account_with_chatgpt_missing_plan_claim_returns_unknown, mount_analytics_capture, list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_patches_updates_from_cached_snapshots (+15 more)); 2 external calls (into, default).


##### `ChatGptAuthFixture::refresh_token`  (lines 39–42)

```
fn refresh_token(mut self, refresh_token: impl Into<String>) -> Self
```

**Purpose**: Replaces the fixture’s default refresh token with a test-specific one. This is useful when a test needs to check how refresh-token storage or refresh behavior works.

**Data flow**: It receives the existing fixture and a new refresh token, converts the token to a string, stores it in the fixture, and returns the updated fixture so more builder calls can follow.

**Call relations**: Tests call this after ChatGptAuthFixture::new when the default refresh token is not enough. The chosen value later becomes part of TokenData inside write_chatgpt_auth.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::account_id`  (lines 44–47)

```
fn account_id(mut self, account_id: impl Into<String>) -> Self
```

**Purpose**: Adds an account ID to the fake login record. Tests use this when they need the saved auth data to look tied to a specific account.

**Data flow**: It receives the existing fixture and an account ID, converts the ID to a string, wraps it as a present optional value, stores it, and returns the updated fixture.

**Call relations**: This is part of the fixture-building chain. When write_chatgpt_auth is later called, this account ID is copied into the saved token data.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::plan_type`  (lines 49–52)

```
fn plan_type(mut self, plan_type: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT plan type claim, such as a paid or free plan label, in the fake ID token. Tests use it to check behavior that depends on the user’s plan.

**Data flow**: It takes the current fixture and a plan type value, turns the value into a string, stores it inside the fixture’s ID-token claims, and returns the fixture.

**Call relations**: This feeds the claims that encode_id_token later turns into a fake JWT. write_chatgpt_auth then parses that JWT back into the normal token data used by the rest of the auth code.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::chatgpt_user_id`  (lines 54–57)

```
fn chatgpt_user_id(mut self, chatgpt_user_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT user ID claim inside the fake ID token. Tests use this when identity-specific behavior needs a known user value.

**Data flow**: It takes a user ID value, converts it to a string, stores it in the fixture’s claims, and returns the modified fixture for further chaining.

**Call relations**: This method is one of the optional fixture customizers. Its value is later included by encode_id_token and then consumed through write_chatgpt_auth as if it came from a real ChatGPT login token.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::chatgpt_account_id`  (lines 59–62)

```
fn chatgpt_account_id(mut self, chatgpt_account_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT account ID claim inside the fake ID token. This lets tests distinguish account identity from other identifiers stored in auth data.

**Data flow**: It receives the current fixture and an account ID claim value, converts the value to a string, places it in the fixture’s claims, and returns the updated fixture.

**Call relations**: Tests can chain this onto ChatGptAuthFixture::new. Later, encode_id_token packs the value into the fake token that write_chatgpt_auth saves through the normal auth path.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::email`  (lines 64–67)

```
fn email(mut self, email: impl Into<String>) -> Self
```

**Purpose**: Adds an email address to the fake ID token claims. Tests use it when account display or identity behavior depends on an email being present.

**Data flow**: It takes an email-like value, converts it to a string, stores it in the fixture’s claims, and returns the modified fixture.

**Call relations**: This supplies data for encode_id_token. Once write_chatgpt_auth writes the fixture, the rest of the app can read the fake email through the same parsing code it uses for real tokens.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::last_refresh`  (lines 69–72)

```
fn last_refresh(mut self, last_refresh: Option<DateTime<Utc>>) -> Self
```

**Purpose**: Sets the saved “last refreshed” time for the fake login. Tests use this to simulate fresh, stale, missing, or deliberately unset refresh history.

**Data flow**: It receives an optional timestamp. It stores that choice inside another optional wrapper so the fixture can tell the difference between “the test did not say” and “the test explicitly wants no timestamp,” then returns the fixture.

**Call relations**: This value is read by write_chatgpt_auth. If a test did not call this method, write_chatgpt_auth uses the current time; if a test did call it, the explicit choice is saved.


##### `ChatGptAuthFixture::claims`  (lines 74–77)

```
fn claims(mut self, claims: ChatGptIdTokenClaims) -> Self
```

**Purpose**: Replaces all ID-token claims on the fixture at once. This is useful when a test has already built a complete ChatGptIdTokenClaims object and wants to use it directly.

**Data flow**: It takes the current fixture and a full claims object, swaps the fixture’s existing claims for the supplied one, and returns the updated fixture.

**Call relations**: This is a shortcut around setting claims one by one. write_chatgpt_auth later passes these claims to encode_id_token, so the saved auth file reflects exactly the claims the test supplied.


##### `ChatGptIdTokenClaims::new`  (lines 89–91)

```
fn new() -> Self
```

**Purpose**: Creates an empty set of fake ChatGPT ID-token claims. Tests use it as a clean starting point when they want to build claims separately from the full auth fixture.

**Data flow**: It takes no input and returns a ChatGptIdTokenClaims value where email, plan type, ChatGPT user ID, and ChatGPT account ID are all absent.

**Call relations**: Several tests call this directly, then use the claim builder methods to add only the fields needed for that test. The completed claims can be passed into ChatGptAuthFixture::claims or encoded through the fixture-writing path.

*Call graph*: called by 8 (account_read_refresh_token_is_noop_in_external_mode, external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized, login_account_chatgpt_device_code_succeeds_and_notifies, set_auth_token_cancels_active_chatgpt_login, set_auth_token_updates_account_and_notifies); 1 external calls (default).


##### `ChatGptIdTokenClaims::email`  (lines 93–96)

```
fn email(mut self, email: impl Into<String>) -> Self
```

**Purpose**: Sets the email field on a standalone claims object. This lets tests build a fake ID token payload with a known email address.

**Data flow**: It receives a claims object and an email value, converts the value to a string, stores it as the email claim, and returns the updated claims object.

**Call relations**: This is usually chained after ChatGptIdTokenClaims::new. The resulting claims can be placed into a ChatGptAuthFixture, where encode_id_token later includes the email in the fake JWT payload.

*Call graph*: 1 external calls (into).


##### `ChatGptIdTokenClaims::plan_type`  (lines 98–101)

```
fn plan_type(mut self, plan_type: impl Into<String>) -> Self
```

**Purpose**: Sets the plan type on a standalone claims object. Tests use this to simulate different ChatGPT subscription or entitlement states.

**Data flow**: It takes a claims object and a plan type value, converts the value to a string, stores it as the plan-type claim, and returns the updated claims object.

**Call relations**: This belongs to the claims-building chain. When those claims are encoded by encode_id_token, the plan type is placed under the auth-specific part of the fake token.

*Call graph*: 1 external calls (into).


##### `ChatGptIdTokenClaims::chatgpt_user_id`  (lines 103–106)

```
fn chatgpt_user_id(mut self, chatgpt_user_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT user ID on a standalone claims object. Tests use it when they need the fake token to identify a particular ChatGPT user.

**Data flow**: It receives a claims object and a user ID value, converts the value to a string, stores it as the ChatGPT user ID claim, and returns the updated claims object.

**Call relations**: This method is used while preparing claims for a fake login. Those claims can then be attached to a ChatGptAuthFixture and written through write_chatgpt_auth.

*Call graph*: 1 external calls (into).


##### `ChatGptIdTokenClaims::chatgpt_account_id`  (lines 108–111)

```
fn chatgpt_account_id(mut self, chatgpt_account_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT account ID on a standalone claims object. This helps tests create tokens that represent a specific ChatGPT account.

**Data flow**: It takes a claims object and an account ID value, converts the value to a string, stores it as the ChatGPT account ID claim, and returns the updated claims object.

**Call relations**: This is another claim-building step. The value becomes part of the fake JWT when encode_id_token is called during auth fixture writing.

*Call graph*: 1 external calls (into).


##### `encode_id_token`  (lines 114–144)

```
fn encode_id_token(claims: &ChatGptIdTokenClaims) -> Result<String>
```

**Purpose**: Turns the chosen fake claims into a JWT-shaped string that the project’s normal token parser can read. It is not meant for real security; it is a test prop that looks like the real object.

**Data flow**: It reads the optional fields in ChatGptIdTokenClaims, builds a JSON header and JSON payload, adds only the fields that are present, base64-encodes the header, payload, and a dummy signature, and returns a three-part token string. If JSON serialization fails, it returns an error with context about which part failed.

**Call relations**: write_chatgpt_auth calls this before saving auth data. The token it produces is immediately passed to the real parse_chatgpt_jwt_claims function, which proves the fake token has the same shape the production auth code expects.

*Call graph*: called by 1 (write_chatgpt_auth); 5 external calls (format!, json!, new, Object, to_vec).


##### `write_chatgpt_auth`  (lines 146–179)

```
fn write_chatgpt_auth(
    codex_home: &Path,
    fixture: ChatGptAuthFixture,
    cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
) -> Result<()>
```

**Purpose**: Writes a complete fake ChatGPT auth.json for a test. It converts the friendly fixture into the same auth structure the application normally stores after login.

**Data flow**: It takes a Codex home directory path, a finished ChatGptAuthFixture, and a choice of credential storage mode. It encodes and parses the fake ID token, combines it with the access token, refresh token, account ID, and last-refresh time, builds an AuthDotJson record marked as ChatGPT auth, and saves it to the configured auth storage. On failure, it returns an error that says whether parsing or writing failed.

**Call relations**: This is the final step after tests build a ChatGptAuthFixture. It calls encode_id_token to create the fake token, parse_chatgpt_jwt_claims to turn it into normal token data, and save_auth to write it using the same storage path as the real application.

*Call graph*: calls 3 internal fn (encode_id_token, default, parse_chatgpt_jwt_claims); 1 external calls (save_auth).


### `app-server/tests/common/config.rs`

`test` · `test setup`

Tests often need the app to believe it is talking to a real model provider, while actually sending requests to a local mock server. This file is a small test helper that writes that fake setup into `config.toml`, the configuration file the app normally reads at startup. Without it, many tests would have to duplicate long configuration strings, and small differences between tests could cause confusing failures.

The main helper, `write_mock_responses_config_toml`, builds a complete config file in three parts. First it turns a map of feature flags into the `[features]` section, using the project’s known feature list to translate each feature into its config-file name. Then it writes a model provider section that points at the test server’s `/v1` endpoint and disables retries, so failures happen immediately and tests stay predictable. It can also mark the provider as requiring OpenAI-style authentication when a test needs that behavior. Finally it writes the assembled text to `config.toml` under the test’s temporary Codex home directory.

The second helper is a simpler variant for tests that specifically need a `chatgpt_base_url` setting. Both functions are like printing a fake ID badge for the app: the app reads it and behaves as if it were in a real environment, but everything points to controlled test services.

#### Function details

##### `write_mock_responses_config_toml`  (lines 6–80)

```
fn write_mock_responses_config_toml(
    codex_home: &Path,
    server_uri: &str,
    feature_flags: &BTreeMap<Feature, bool>,
    auto_compact_limit: i64,
    requires_openai_auth: Option<bool>,
```

**Purpose**: This function writes a full test `config.toml` file that points the app at a mock Responses API server. Tests use it when they need control over feature flags, provider identity, authentication behavior, compaction settings, and the compact prompt.

**Data flow**: It receives the test Codex home folder, the mock server URL, feature flag values, token compaction settings, optional authentication requirements, the provider ID, and a compact prompt. It turns those inputs into TOML text: feature entries, a model provider block, optional OpenAI-specific lines, and general app settings. The result is a `config.toml` file written to disk; on success it returns `Ok(())`, and on a file-writing problem it returns an I/O error.

**Call relations**: During test setup, a test calls this helper before starting or exercising the app. Inside, it uses standard library tools to build ordered maps, join the `config.toml` path under the temporary home directory, format the TOML text, and write it to disk. The app later reads that file as if it were normal user configuration, so the test can steer the app toward the mock server.

*Call graph*: 6 external calls (new, join, new, format!, matches!, write).


##### `write_mock_responses_config_toml_with_chatgpt_base_url`  (lines 82–108)

```
fn write_mock_responses_config_toml_with_chatgpt_base_url(
    codex_home: &Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: This function writes a simpler test `config.toml` file for cases that need to set `chatgpt_base_url`. It still points the model provider at a mock Responses API server, but focuses on testing ChatGPT base URL configuration.

**Data flow**: It receives the test Codex home folder, the mock server URL, and the ChatGPT base URL to place in the config. It formats those values into a fixed TOML template and writes that text to `config.toml` in the given home directory. It returns success if the file was written, or an I/O error if writing failed.

**Call relations**: A test calls this helper when it needs the app to start with a custom ChatGPT base URL. The function does not call project-specific helpers; it simply builds the path, formats the config text, and writes it. After that, the app’s normal configuration loading code can read the file and follow the fake URLs supplied by the test.

*Call graph*: 3 external calls (join, format!, write).


### `app-server/tests/common/mock_model_server.rs`

`test` · `test setup and request handling`

Tests often need the app to talk to something that looks like the real model service, but using the real service would be slow, costly, unreliable, and hard to control. This file builds a local mock server: a small pretend web server that accepts the same kind of request the app would send to the model API and replies with canned data.

The mock server listens for POST requests whose path ends in `/responses`, which is the endpoint the app expects to call. For tests that need a story with several steps, `SeqResponder` works like a queue at a ticket counter: each incoming request gets the next response from the list. An atomic counter is used so the count stays safe even if requests arrive from more than one task at the same time.

There are two sequence helpers. One checks that the server was called exactly as many times as there are prepared responses, which is useful when a test wants to prove a precise interaction happened. The other skips that call-count check, which is useful when the exact number of requests is not the point of the test. A third helper always returns the same assistant message as a streaming response, which keeps simple tests short and readable.

#### Function details

##### `create_mock_responses_server_sequence`  (lines 14–31)

```
async fn create_mock_responses_server_sequence(responses: Vec<String>) -> MockServer
```

**Purpose**: Starts a fake responses API server that returns a different prepared response for each request, in the order given. It also tells the test framework to expect exactly that many calls, so extra or missing calls can make the test fail.

**Data flow**: It receives a list of response bodies as strings. It starts a mock server, wraps the list in a `SeqResponder` with a fresh call counter, and registers that responder for POST requests ending in `/responses`. It returns the running mock server for the test to point the app at.

**Call relations**: A test calls this during setup when it wants to simulate a known sequence of model replies. It relies on the shared test support code to start the mock server, then uses wiremock's request matching to connect matching requests to `SeqResponder::respond`, which supplies the next response during the test.

*Call graph*: calls 1 internal fn (start_mock_server); 4 external calls (new, given, method, path_regex).


##### `create_mock_responses_server_sequence_unchecked`  (lines 35–50)

```
async fn create_mock_responses_server_sequence_unchecked(responses: Vec<String>) -> MockServer
```

**Purpose**: Starts the same kind of fake responses API server as the checked version, but without enforcing how many times it must be called. This is useful when the test only cares what responses are available, not the exact request count.

**Data flow**: It receives a list of response strings. It starts a mock server, creates a `SeqResponder` with those strings and a zeroed counter, and mounts it for POST requests ending in `/responses`. It returns the mock server to the caller.

**Call relations**: A test uses this during setup when request count is flexible or checked somewhere else. Once mounted, matching requests are passed to `SeqResponder::respond`, which turns each stored string into the streaming response format expected by the app.

*Call graph*: calls 1 internal fn (start_mock_server); 4 external calls (new, given, method, path_regex).


##### `SeqResponder::respond`  (lines 58–65)

```
fn respond(&self, _: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Returns the next prepared mock model response for a request. It is the small piece that makes a mock server behave like a sequence of model replies instead of always returning the same answer.

**Data flow**: It ignores the request contents and uses an atomic counter to find which call number this is. It looks up the matching response string from its stored list, fails the test if no response exists for that call, wraps the string as a server-sent events response, and returns it. Server-sent events are a streaming web format where data is sent as a series of events rather than one plain block.

**Call relations**: Wiremock calls this whenever a request matches the mock rule created by one of the sequence server helpers. It hands the selected response body to the shared response-building helper so the app receives data in the same streaming shape it expects from the real model API.

*Call graph*: calls 1 internal fn (sse_response); 1 external calls (fetch_add).


##### `create_mock_responses_server_repeating_assistant`  (lines 69–82)

```
async fn create_mock_responses_server_repeating_assistant(message: &str) -> MockServer
```

**Purpose**: Starts a fake responses API server that always returns the same assistant message. It is a convenience helper for tests that do not need multiple different replies.

**Data flow**: It receives a message string. It starts a mock server, builds a streaming response body containing a response-created event, an assistant-message event with that text, and a completed event, then registers that same response for every POST request ending in `/responses`. It returns the running mock server.

**Call relations**: A test calls this during setup when it just needs the app to receive a normal-looking assistant reply. It uses the shared test response builders to create realistic streaming events, then wiremock serves that response whenever the app calls the mocked `/responses` endpoint.

*Call graph*: calls 3 internal fn (sse, sse_response, start_mock_server); 4 external calls (given, vec!, method, path_regex).


### `app-server/tests/common/models_cache.rs`

`test` · `test setup`

The app normally needs a `models_cache.json` file that says which AI models are available, how they should be shown, and what features they support. In real use, that file may be refreshed from a remote service. In tests, making network calls would be slow and unreliable, so this file writes a ready-made cache into the test Codex home directory instead. Think of it like placing a printed menu on the table before a restaurant test starts, so the waiter does not need to call headquarters to ask what dishes exist.

The helper starts from bundled model presets, which are stable built-in descriptions used by the test environment. It keeps only the models meant to appear in the model picker, converts each preset into the fuller `ModelInfo` shape expected by the cache, and assigns a priority so the ordering is predictable. It then writes a JSON file named `models_cache.json` with a current timestamp, the current client version, no network tag, and the chosen model list.

A second helper lets tests provide their own exact model list. That is useful when a test needs to prove behavior with a special model setup instead of the default bundled catalog.

#### Function details

##### `preset_to_info`  (lines 16–61)

```
fn preset_to_info(preset: &ModelPreset, priority: i32) -> ModelInfo
```

**Purpose**: This function turns a compact `ModelPreset` into the fuller `ModelInfo` record that the cache file expects. Tests use it so built-in model presets can be written in the same shape as models that would normally come from the model service.

**Data flow**: It receives one model preset and a numeric priority. It copies over user-facing details like the model id, display name, description, service tiers, upgrade information, and availability, fills in test-safe defaults for many feature flags, sets visibility based on whether the preset should appear in the picker, and returns a complete `ModelInfo` object ready to serialize into JSON.

**Call relations**: It is used inside the default cache-writing path when `write_models_cache` builds a list of cache models from bundled presets. While building that record, it asks helper code for a byte-based truncation policy and the default input types, so the resulting model description has the fields the rest of the app expects.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 2 external calls (default, new).


##### `write_models_cache`  (lines 67–86)

```
fn write_models_cache(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: This function writes a normal test model cache using the project’s bundled model presets. A test calls it when it wants the model manager to find a fresh local cache and avoid network refreshes.

**Data flow**: It receives the path to the test Codex home directory. It reads all built-in model presets, filters out any that should not be shown in the model picker, converts the remaining presets into full model records with stable ordering priorities, and then passes that model list to `write_models_cache_with_models`. The final visible result is a `models_cache.json` file in the given directory.

**Call relations**: This is the convenient high-level helper for ordinary tests. It calls `all_model_presets` to get the stable built-in catalog, uses `preset_to_info` during conversion, and then hands the finished list to `write_models_cache_with_models`, which does the actual file writing.

*Call graph*: calls 2 internal fn (write_models_cache_with_models, all_model_presets).


##### `write_models_cache_with_models`  (lines 90–105)

```
fn write_models_cache_with_models(
    codex_home: &Path,
    models: Vec<ModelInfo>,
) -> std::io::Result<()>
```

**Purpose**: This function writes a `models_cache.json` file using an exact list of models supplied by the test. It is the lower-level helper for tests that need custom model availability instead of the default bundled list.

**Data flow**: It receives the test Codex home directory and a list of `ModelInfo` records. It creates the path `models_cache.json`, records the current time as the fetch time, reads the current client version, builds a JSON object with those values plus the supplied models, formats it as readable JSON text, and writes it to disk. It returns success or an input/output error if the file cannot be created or written.

**Call relations**: The default helper `write_models_cache` calls this after preparing a standard model list. Tests can also call it directly when they need special models. Inside, it uses standard path, time, JSON formatting, and file-writing utilities to produce the cache file that the model manager will later read instead of fetching from the network.

*Call graph*: called by 1 (write_models_cache); 6 external calls (join, now, client_version_to_whole, json!, to_string_pretty, write).


### `app-server/tests/common/responses.rs`

`test` · `test setup and simulated response handling`

Tests often need a believable reply from the outside AI service without actually calling that service. This file provides small builders that create those fake replies in the same server-sent events format the app normally receives. Server-sent events, or SSE, are a streaming text format where a server sends a sequence of named events over one connection, like a live ticker tape.

Each helper follows the same pattern. It creates a response-started event, adds one meaningful event in the middle, and then creates a completed event. The middle event might say “call the shell_command tool,” “show this final assistant message,” “apply this patch,” “ask the user a question,” or “request file permissions.” The helpers use shared event-building functions from core_test_support::responses so tests get consistent, realistic event strings.

A key detail is that tool calls carry their arguments as a JSON string. For example, the shell command helper turns a list of command words into a safely quoted command line, then stores it inside JSON. This matters because the app code being tested expects exactly that shape. Without these helpers, many tests would need to hand-write fragile SSE text, making them harder to read and easier to break.

#### Function details

##### `create_shell_command_sse_response`  (lines 5–23)

```
fn create_shell_command_sse_response(
    command: Vec<String>,
    workdir: Option<&Path>,
    timeout_ms: Option<u64>,
    call_id: &str,
) -> anyhow::Result<String>
```

**Purpose**: Builds a fake streaming response that tells the app to run the shell_command tool. Tests use it when they need to check how the app reacts to an AI-requested shell command.

**Data flow**: It receives a command as separate words, an optional working directory, an optional timeout, and a tool-call id. It safely joins the command words into one shell-style command string, places that plus the optional settings into JSON, and wraps the result in a three-event SSE response: response created → shell_command function call → response completed. It returns the finished SSE text, or an error if the command cannot be quoted or the JSON cannot be made.

**Call relations**: This helper is called by tests that need a shell command response. Inside, it relies on external JSON creation and string serialization, uses shlex-style joining so command words are quoted correctly, and hands the final event list to the shared sse builder from core_test_support::responses.

*Call graph*: calls 1 internal fn (sse); 4 external calls (json!, to_string, try_join, vec!).


##### `create_final_assistant_message_sse_response`  (lines 25–31)

```
fn create_final_assistant_message_sse_response(message: &str) -> anyhow::Result<String>
```

**Purpose**: Builds a fake streaming response containing a normal final assistant message. Tests use it when they want the simulated AI to answer with text instead of asking to run a tool.

**Data flow**: It receives the message text. It places that text into an assistant-message event between a response-created event and a response-completed event, then turns the event list into one SSE string. The output is ready for a test to feed into the app as if it came from the AI service.

**Call relations**: Tests call this when the expected flow is a plain assistant reply. The function delegates the event formatting to the shared sse helper and uses response event builders from core_test_support::responses.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `create_apply_patch_sse_response`  (lines 33–42)

```
fn create_apply_patch_sse_response(
    patch_content: &str,
    call_id: &str,
) -> anyhow::Result<String>
```

**Purpose**: Builds a fake streaming response that asks the app to apply a patch. This is useful for tests that check code-editing behavior without needing a real AI model to produce the patch.

**Data flow**: It receives patch text and a tool-call id. It wraps the patch in an apply-patch shell-command event, adds the usual response-created and response-completed events around it, and returns the whole sequence as SSE text.

**Call relations**: Tests call this when they need the app to see an apply-patch request. The helper uses a specialized event builder from core_test_support::responses for the heredoc-style patch command, then passes all events to the shared sse formatter.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `create_exec_command_sse_response`  (lines 44–62)

```
fn create_exec_command_sse_response(call_id: &str) -> anyhow::Result<String>
```

**Purpose**: Builds a fake streaming response that calls the exec_command tool with a simple “echo hi” command. It chooses a Windows or Unix-style command so the test response matches the operating system running the test.

**Data flow**: It receives a tool-call id. It checks the platform: on Windows it uses cmd.exe, and elsewhere it uses /bin/sh. It builds a command string, adds a yield_time_ms value to JSON arguments, and wraps those arguments in a function-call event for exec_command. The final output is a response-created event, the exec_command call, and a response-completed event as one SSE string.

**Call relations**: Tests call this to simulate an exec_command request. The function uses platform detection, JSON building, and shared response helpers, then hands the event sequence to the common sse formatter.

*Call graph*: calls 1 internal fn (sse); 5 external calls (cfg!, json!, to_string, once, vec!).


##### `create_request_user_input_sse_response`  (lines 64–85)

```
fn create_request_user_input_sse_response(call_id: &str) -> anyhow::Result<String>
```

**Purpose**: Builds a fake streaming response that asks the app to request input from the user. It models a confirmation question with Yes and No choices.

**Data flow**: It receives a tool-call id. It creates JSON arguments describing one question, including its id, title, wording, and two selectable options. It then places that JSON string into a request_user_input function-call event and wraps it with response-created and response-completed events. The result is SSE text for a test to consume.

**Call relations**: Tests call this when they need to exercise the user-question path. The helper creates the expected JSON shape and relies on core_test_support::responses to build and serialize the SSE events.

*Call graph*: calls 1 internal fn (sse); 3 external calls (json!, to_string, vec!).


##### `create_request_permissions_sse_response`  (lines 87–105)

```
fn create_request_permissions_sse_response(call_id: &str) -> anyhow::Result<String>
```

**Purpose**: Builds a fake streaming response that asks the app for file-system write permissions. Tests use it to check how permission requests are surfaced and processed.

**Data flow**: It receives a tool-call id. It creates JSON arguments with a reason and a permissions object asking for write access to two paths: the current directory and ../shared. It wraps that JSON in a request_permissions function-call event, surrounded by response-created and response-completed events, and returns the complete SSE string.

**Call relations**: Tests call this when they want to simulate an AI permission request. The function prepares the permission-request JSON, then uses shared response event builders and the common sse formatter to produce the final fake stream.

*Call graph*: calls 1 internal fn (sse); 3 external calls (json!, to_string, vec!).


### `app-server/tests/common/rollout.rs`

`test` · `test setup`

A rollout file is a JSON Lines file: each line is a separate JSON record, like one row in a logbook. The app stores these under CODEX_HOME/sessions/YYYY/MM/DD/, with the date taken from the filename timestamp. This file gives tests a quick way to build those logbooks with just enough realistic data to exercise the real loading code.

Most helpers create a new random thread ID, build a session metadata line, add a user message, and write the result to disk. Some variants let a test choose extra details, such as the session source, Git information, a parent thread ID for fork-like relationships, or richer message text elements. One helper appends a saved token-count event so tests can confirm that token totals are restored from history instead of being recalculated or lost.

The important idea is that these helpers do not mock the reader directly. They create files in the same shape and location the app expects in normal use. That makes tests closer to real life: if the storage layout, JSON shape, or timestamp handling breaks, tests can catch it.

#### Function details

##### `rollout_path`  (lines 18–28)

```
fn rollout_path(codex_home: &Path, filename_ts: &str, thread_id: &str) -> PathBuf
```

**Purpose**: Builds the exact filesystem path where a rollout file should live. Tests use it so they write and read files in the same date-based folder layout as the real app.

**Data flow**: It receives a CODEX_HOME directory, a filename timestamp, and a thread ID. It slices the timestamp into year, month, and day, then combines those pieces into CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl. It returns that path without creating anything on disk.

**Call relations**: The main rollout-writing helper calls this when it needs to decide where to create a fake session file. The token-usage helper calls it later to find the file it just created so it can append one more event.

*Call graph*: called by 2 (create_fake_rollout_with_source_and_parent_thread_id, create_fake_rollout_with_token_usage); 2 external calls (join, format!).


##### `create_fake_rollout`  (lines 38–55)

```
fn create_fake_rollout(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
) -> Result<String>
```

**Purpose**: Creates the simplest useful fake rollout file for tests. It assumes the session came from the command-line interface and leaves more specialized options to lower-level helpers.

**Data flow**: It receives the fake home directory, timestamps, preview text, optional model provider, and optional Git information. It passes all of that along with a default session source of CLI. It returns the newly generated thread ID as a string, or an error if file creation or data conversion fails.

**Call relations**: This is a convenience wrapper. Tests can call it when they do not care about the session source or parent relationship. The token-usage helper also starts here, then adds a token-count event after the basic file exists.

*Call graph*: calls 1 internal fn (create_fake_rollout_with_source); called by 1 (create_fake_rollout_with_token_usage).


##### `create_fake_rollout_with_token_usage`  (lines 63–110)

```
fn create_fake_rollout_with_token_usage(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
) -> Result<String>
```

**Purpose**: Creates a fake rollout file that includes saved token usage. This lets resume and fork tests check that the app replays past token counts correctly when reopening a session.

**Data flow**: It first creates a normal fake rollout and receives its thread ID. Then it builds a token-count event with deliberately different total and last-turn numbers, including cached and reasoning token fields. It finds the rollout file, reads its existing contents, appends one more JSON line for the token event, writes the file back, and returns the same thread ID.

**Call relations**: It builds on create_fake_rollout instead of duplicating the whole session file setup. After that, it uses rollout_path to locate the generated file and adds the extra event that token replay tests need.

*Call graph*: calls 2 internal fn (create_fake_rollout, rollout_path); 5 external calls (format!, write, json!, TokenCount, to_value).


##### `create_fake_rollout_with_source`  (lines 113–132)

```
fn create_fake_rollout_with_source(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
    source
```

**Purpose**: Creates a fake rollout while letting the caller choose where the session claims to have come from. This is useful when tests need to distinguish command-line sessions from other sources.

**Data flow**: It receives the same basic rollout details plus a session source value. It forwards those inputs to the shared internal creator with no parent thread ID. It returns the generated thread ID string, or an error if setup fails.

**Call relations**: This is another convenience wrapper around the central file-writing function. create_fake_rollout calls it with the default CLI source, while tests can call it directly when they need a different source.

*Call graph*: calls 1 internal fn (create_fake_rollout_with_source_and_parent_thread_id); called by 1 (create_fake_rollout).


##### `create_fake_parented_rollout_with_source`  (lines 136–156)

```
fn create_fake_parented_rollout_with_source(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
```

**Purpose**: Creates a fake rollout that records a parent thread ID. Tests use this when they need a session to look like it belongs under, or was derived from, another thread.

**Data flow**: It receives normal rollout details, a chosen source, and a parent thread ID. It passes those values to the shared internal creator, wrapping the parent ID as present. It returns the new child thread ID string, or an error if writing the file fails.

**Call relations**: This function is the parent-aware public wrapper. It hands the real work to create_fake_rollout_with_source_and_parent_thread_id, which knows how to place the parent ID into the session metadata.

*Call graph*: calls 1 internal fn (create_fake_rollout_with_source_and_parent_thread_id).


##### `create_fake_rollout_with_source_and_parent_thread_id`  (lines 159–241)

```
fn create_fake_rollout_with_source_and_parent_thread_id(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option
```

**Purpose**: Does the main work of creating a minimal rollout file. It is the shared helper behind the simpler public helpers, because all of them need the same file format and metadata structure.

**Data flow**: It receives the fake home directory, timestamps, preview text, optional provider and Git details, a session source, and an optional parent thread ID. It generates a new UUID, converts it into a thread ID, computes the rollout path, creates the date directory, builds three JSON lines, and writes them to disk. The lines describe session metadata, a user message as a response item, and the same user message as an event. It also sets the file modification time from the metadata timestamp, then returns the generated UUID string.

**Call relations**: create_fake_rollout_with_source and create_fake_parented_rollout_with_source both delegate to this function. It calls rollout_path so all callers share the same storage layout, then uses protocol types such as SessionMeta and SessionMetaLine so the fake file looks like a real app file.

*Call graph*: calls 2 internal fn (rollout_path, from_string); called by 2 (create_fake_parented_rollout_with_source, create_fake_rollout_with_source); 9 external calls (new, from, new_v4, parse_from_rfc3339, create_dir_all, write, json!, to_value, new).


##### `create_fake_rollout_with_text_elements`  (lines 243–322)

```
fn create_fake_rollout_with_text_elements(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    text_elements: Vec<serde_json::Value>,
    model_provider: Optio
```

**Purpose**: Creates a fake rollout whose user-message event includes structured text elements. Tests use this when plain preview text is not enough and they need to check richer message content.

**Data flow**: It receives the fake home directory, timestamps, preview text, a list of JSON text elements, optional model provider, and optional Git information. It generates a new thread ID, creates the dated sessions directory, builds a rollout file with session metadata, a response item, and a user-message event containing the supplied text elements and an empty image list. It writes the JSON Lines file and returns the generated thread ID string.

**Call relations**: This function is separate from the central helper because it needs a slightly different user-message payload. It follows the same overall pattern as the other rollout creators, so tests still get a realistic file in the expected sessions folder.

*Call graph*: calls 1 internal fn (from_string); 8 external calls (join, from, new_v4, format!, create_dir_all, write, json!, to_value).


### Integration harness facade
This layer assembles the shared fixtures into the exported support surface and the process-level app-server harness used by the integration suites.

### `app-server/tests/common/lib.rs`

`test` · `test setup and test response checking`

App server tests need a lot of repeated setup: fake authentication, mock model servers, canned server responses, temporary paths, rollout files, and a test app server wrapper. This file acts like the front desk for that test support code. Instead of every test knowing which helper lives in which internal module, tests can import from this single common library.

Most of the file is made of `pub use` lines. In plain terms, those re-export helper functions and types from nearby test modules so other tests can use them directly. This keeps test files shorter and makes the support code feel like one organized kit rather than many separate drawers.

The one local function, `to_response`, solves a common testing problem with JSON-RPC responses. JSON-RPC is a standard message shape for calling methods over JSON. A response contains a generic `result` field, but each test usually wants that result as a specific Rust type. `to_response` converts the generic result into normal JSON, then reads it back as the requested type. It is a small bridge between “the server sent a generic JSON answer” and “the test wants a concrete value it can check.”

#### Function details

##### `to_response`  (lines 51–55)

```
fn to_response(response: JSONRPCResponse) -> anyhow::Result<T>
```

**Purpose**: This function converts the `result` part of a JSON-RPC response into the specific Rust type the test expects. It is useful when a test receives a generic server reply but wants to make clear assertions about its contents.

**Data flow**: It takes a `JSONRPCResponse` as input and reads its `result` field. First it turns that result into a plain JSON value, then it asks `serde_json` to decode that JSON into the requested type `T`. If both conversions work, it returns the typed value; if not, it returns an error explaining that the response did not match the expected shape.

**Call relations**: Tests call on this helper after they get a JSON-RPC reply from the test app server. Inside, it hands the conversion work to `serde_json::to_value` and `serde_json::from_value`, which are the standard serialization and deserialization tools used to move between Rust values and JSON.

*Call graph*: 2 external calls (from_value, to_value).


### `app-server/tests/common/test_app_server.rs`

`test` · `integration test setup, request/response handling, and teardown`

This file is test infrastructure. Instead of testing the app server by calling internal Rust functions, tests can launch the actual codex-app-server binary and speak to it the same way a real client would: one JSON message per line through standard input and output. JSON-RPC is a simple request and response format; here it is the contract between the test and the server.

The main type, TestAppServer, is like a remote control for a temporary server. It starts the process in an isolated test home directory, sets environment variables so the test is not affected by the developer machine, and optionally disables slow plugin startup work. It then offers many small send_* methods for protocol features such as login, threads, turns, files, plugins, remote control, and configuration. Most of those methods simply turn typed Rust parameters into JSON and pass them to one shared request sender.

The other half of the file reads the server stream. Because messages can arrive in any order, unmatched messages are saved in a small buffer, like putting letters back in a tray until the test asks for them. The Drop cleanup is important: tests spawn real processes, so this helper closes input, gives the server a chance to exit, and kills it if needed. Without this file, integration tests would repeat fragile process and protocol plumbing everywhere.

#### Function details

##### `TestAppServer::wait_for_exit`  (lines 134–136)

```
async fn wait_for_exit(&mut self) -> std::io::Result<ExitStatus>
```

**Purpose**: Waits until the child app server process exits. Tests use it when they expect the server to stop and need the operating system exit status.

**Data flow**: It reads the stored child process handle, waits asynchronously for that process to finish, and returns the exit status or an input/output error.

**Call relations**: This is a direct process-level helper. It hands off to Tokio's child-process wait operation rather than using the JSON-RPC message flow.

*Call graph*: 1 external calls (wait).


##### `TestAppServer::new`  (lines 138–140)

```
async fn new(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Starts a standard test app server with plugin startup tasks disabled. This is the default constructor for most integration tests.

**Data flow**: It receives a test CODEX_HOME path, adds the default test argument that skips plugin startup work, and returns a ready TestAppServer connected to the new process.

**Call relations**: Many tests call this as their first step. It delegates the real setup to TestAppServer::new_with_env_and_args so all process launching stays in one place.

*Call graph*: called by 417 (get_auth_status_with_api_key, get_auth_status_with_api_key_no_include_token, get_auth_status_with_api_key_refresh_requested, get_auth_status_with_api_key_when_auth_not_required, login_api_key_rejected_when_forced_chatgpt, get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home, get_conversation_summary_by_thread_id_reads_rollout, initialized_mcp, test_fuzzy_file_search_accepts_cancellation_token, test_fuzzy_file_search_sorts_and_includes_indices (+15 more)); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_without_managed_config`  (lines 142–144)

```
async fn new_without_managed_config(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Starts the server while disabling managed configuration. Tests use it when they need configuration to come only from the test setup.

**Data flow**: It receives a test home path, adds an environment variable that turns off managed config, and returns a connected TestAppServer.

**Call relations**: Tests for workspace policy, threads, plugins, and related behavior call this when host or managed config would make results unpredictable. It reuses TestAppServer::new_with_env.

*Call graph*: called by 19 (list_apps_returns_empty_when_workspace_codex_plugins_disabled, experimental_feature_list_marks_apps_and_plugins_disabled_by_workspace_policy, experimental_feature_list_resolves_thread_project_config, skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled, thread_fork_tracks_thread_initialized_analytics, thread_goal_get_rejects_unmaterialized_thread, thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal, thread_goal_set_edits_objective_without_resetting_usage, thread_goal_set_persists_resumable_stopped_statuses, thread_goal_set_preserves_budget_limited_same_objective (+9 more)); 1 external calls (new_with_env).


##### `TestAppServer::new_without_managed_config_with_env`  (lines 146–153)

```
async fn new_without_managed_config_with_env(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with managed config disabled plus extra test-specific environment changes. This lets a test combine isolation with custom conditions.

**Data flow**: It takes a home path and environment overrides, prepends the managed-config-disable variable, and produces a connected server process.

**Call relations**: Plugin tests use this when they need both disabled managed config and extra environment settings. It builds the environment list and hands it to TestAppServer::new_with_env.

*Call graph*: called by 2 (plugin_list_returns_empty_when_workspace_codex_plugins_disabled, plugin_list_reuses_cached_workspace_codex_plugins_setting); 2 external calls (new_with_env, vec!).


##### `TestAppServer::new_with_plugin_startup_tasks`  (lines 155–157)

```
async fn new_with_plugin_startup_tasks(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Starts the server without suppressing plugin startup tasks. Tests use it when startup plugin behavior is exactly what they want to inspect.

**Data flow**: It receives a home path, passes no extra environment values and no skip-startup argument, and returns a connected TestAppServer.

**Call relations**: Startup-cache tests call this to exercise the real startup path. It delegates to TestAppServer::new_with_env_and_args.

*Call graph*: called by 1 (plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_with_env_and_plugin_startup_tasks`  (lines 159–164)

```
async fn new_with_env_and_plugin_startup_tasks(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with custom environment values while leaving plugin startup tasks enabled. This supports tests of startup behavior under special settings.

**Data flow**: It receives a home path and environment overrides, keeps the command-line argument list empty, and returns a connected server process.

**Call relations**: Tests that verify startup synchronization call this. It forwards all process setup to TestAppServer::new_with_env_and_args.

*Call graph*: called by 1 (app_server_startup_sync_downloads_remote_installed_plugin_bundles); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_with_args`  (lines 166–170)

```
async fn new_with_args(codex_home: &Path, args: &[&str]) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with extra command-line arguments, while still disabling plugin startup tasks by default. Tests use it to check command-line modes.

**Data flow**: It receives a home path and argument slice, adds the test skip-startup argument before the supplied arguments, and returns a connected TestAppServer.

**Call relations**: Remote-control and plugin-install tests call this when the command line matters. It delegates to TestAppServer::new_with_env_and_args.

*Call graph*: called by 4 (plugin_install_returns_invalid_request_for_disallowed_product_plugin, listen_off_exits_without_persisted_remote_control_enable, listen_off_honors_persisted_remote_control_enable, listen_off_ignores_persisted_enable_when_disabled_by_requirements); 2 external calls (new_with_env_and_args, vec!).


##### `TestAppServer::new_with_env`  (lines 177–187)

```
async fn new_with_env(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with custom environment variables and the normal test startup shortcut. Tests use it to simulate authentication, network, or feature settings.

**Data flow**: It receives a home path and a list of environment variables to set or remove, adds the default skip-plugin-startup argument, and returns a connected server.

**Call relations**: Authentication and external-mode tests call this heavily. It hands the combined setup to TestAppServer::new_with_env_and_args.

*Call graph*: called by 83 (get_auth_status_no_auth, get_auth_status_omits_token_after_permanent_refresh_failure, get_auth_status_omits_token_after_proactive_refresh_failure, get_auth_status_returns_token_after_proactive_refresh_recovery, get_auth_status_with_personal_access_token_omits_token, account_read_refresh_token_is_noop_in_external_mode, external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized (+15 more)); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_with_program_and_env`  (lines 189–201)

```
async fn new_with_program_and_env(
        codex_home: &Path,
        program: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts a chosen server program path with custom environment variables. This is useful when a test needs a specific executable rather than the default cargo-built one.

**Data flow**: It receives a home path, executable path, and environment overrides, adds the normal test startup shortcut, and returns a connected TestAppServer.

**Call relations**: Special process tests call this, then it delegates to TestAppServer::new_with_program_env_and_args for the actual launch.

*Call graph*: called by 1 (create_zsh_test_mcp_process); 1 external calls (new_with_program_env_and_args).


##### `TestAppServer::new_with_env_and_args`  (lines 203–211)

```
async fn new_with_env_and_args(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
        args: &[&str],
    ) -> anyhow::Result<Self>
```

**Purpose**: Finds the codex-app-server test binary and starts it with the requested environment and arguments.

**Data flow**: It receives a home path, environment overrides, and command-line arguments, locates the binary built by Cargo, and returns the launched TestAppServer.

**Call relations**: Most public constructors funnel through this helper. It then calls TestAppServer::new_with_program_env_and_args, which performs the low-level process setup.

*Call graph*: 2 external calls (new_with_program_env_and_args, cargo_bin).


##### `TestAppServer::new_with_program_env_and_args`  (lines 213–277)

```
async fn new_with_program_env_and_args(
        codex_home: &Path,
        program: &Path,
        env_overrides: &[(&str, Option<&str>)],
        args: &[&str],
    ) -> anyhow::Result<Self>
```

**Purpose**: Performs the real child-process setup for the test server. It creates the process, wires up input and output pipes, and prepares stderr logging.

**Data flow**: It takes a home path, program path, environment overrides, and arguments. It builds a command with isolated CODEX_HOME and config paths, spawns the process, stores stdin and stdout, forwards stderr to the test log, and returns a TestAppServer.

**Call relations**: All constructors ultimately call this. Later send and read methods depend on the stdin and stdout handles created here, and Drop later cleans up the stored process.

*Call graph*: 8 external calls (new, new, join, piped, new, new, eprintln!, spawn).


##### `TestAppServer::initialize`  (lines 280–292)

```
async fn initialize(&mut self) -> anyhow::Result<()>
```

**Purpose**: Runs the normal startup handshake with default test client information. Tests call it before using server features that require initialization.

**Data flow**: It sends an initialize request with the default client name and version, checks that the server replied with a response, and returns success.

**Call relations**: It is the simple public path into the initialization chain. It calls TestAppServer::initialize_with_client_info, which continues through the lower-level initialization helpers.

*Call graph*: calls 1 internal fn (initialize_with_client_info); 1 external calls (unreachable!).


##### `TestAppServer::initialize_with_client_info`  (lines 295–307)

```
async fn initialize_with_client_info(
        &mut self,
        client_info: ClientInfo,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Runs initialization while letting the test choose the client name, title, or version. It still enables the experimental API by default.

**Data flow**: It receives client information, pairs it with default capabilities that include experimental support, and returns the server's initialize response or error message.

**Call relations**: TestAppServer::initialize calls this for the normal case. It delegates to TestAppServer::initialize_with_capabilities.

*Call graph*: calls 1 internal fn (initialize_with_capabilities); called by 1 (initialize); 1 external calls (default).


##### `TestAppServer::initialize_with_capabilities`  (lines 309–319)

```
async fn initialize_with_capabilities(
        &mut self,
        client_info: ClientInfo,
        capabilities: Option<InitializeCapabilities>,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Runs initialization with caller-supplied capability flags. Capabilities tell the server what kinds of features the client understands.

**Data flow**: It receives client information and optional capabilities, wraps them into initialize parameters, and returns the server's response or error.

**Call relations**: It is called by TestAppServer::initialize_with_client_info and passes the completed parameter object to TestAppServer::initialize_with_params.

*Call graph*: calls 1 internal fn (initialize_with_params); called by 1 (initialize_with_client_info).


##### `TestAppServer::initialize_with_params`  (lines 321–361)

```
async fn initialize_with_params(
        &mut self,
        params: InitializeParams,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Sends the actual initialize JSON-RPC request and validates that the matching reply comes back. It also sends the final initialized notification required by the protocol.

**Data flow**: It converts initialize parameters to JSON, sends an initialize request, reads one server message, checks that the response or error id matches the request id, sends the initialized notification on success, and returns the message.

**Call relations**: This is the bottom of the initialization flow. It uses TestAppServer::send_request, TestAppServer::read_jsonrpc_message, and TestAppServer::send_notification.

*Call graph*: calls 3 internal fn (read_jsonrpc_message, send_notification, send_request); called by 1 (initialize_with_capabilities); 5 external calls (bail!, Error, Response, Integer, to_value).


##### `TestAppServer::send_get_auth_status_request`  (lines 364–370)

```
async fn send_get_auth_status_request(
        &mut self,
        params: GetAuthStatusParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a request asking the server for the current authentication status.

**Data flow**: It receives typed auth-status parameters, converts them to JSON, sends getAuthStatus, and returns the numeric request id so the test can wait for the reply.

**Call relations**: Tests call this helper, and it delegates the common message writing to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_get_conversation_summary_request`  (lines 373–379)

```
async fn send_get_conversation_summary_request(
        &mut self,
        params: GetConversationSummaryParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for a conversation summary.

**Data flow**: It receives summary lookup parameters, converts them to JSON, sends getConversationSummary, and returns the request id.

**Call relations**: Conversation-summary tests use this wrapper; it hands the actual JSON-RPC sending to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_get_account_rate_limits_request`  (lines 382–385)

```
async fn send_get_account_rate_limits_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to read account rate-limit information.

**Data flow**: It sends account/rateLimits/read with no parameters and returns the request id.

**Call relations**: Tests use it as a named shortcut. The shared TestAppServer::send_request does the actual write.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_consume_account_rate_limit_reset_credit_request`  (lines 388–397)

```
async fn send_consume_account_rate_limit_reset_credit_request(
        &mut self,
        params: ConsumeAccountRateLimitResetCreditParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to consume a rate-limit reset credit for an account.

**Data flow**: It receives reset-credit parameters, serializes them to JSON, sends account/rateLimitResetCredit/consume, and returns the request id.

**Call relations**: Higher-level test helper send_consume_reset_credit calls this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_consume_reset_credit); 1 external calls (to_value).


##### `TestAppServer::send_add_credits_nudge_email_request`  (lines 400–407)

```
async fn send_add_credits_nudge_email_request(
        &mut self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that the server send an add-credits nudge email.

**Data flow**: It converts the email-request parameters to JSON, sends account/sendAddCreditsNudgeEmail, and returns the request id.

**Call relations**: Tests call this wrapper when checking account-credit behavior. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_get_account_request`  (lines 410–416)

```
async fn send_get_account_request(
        &mut self,
        params: GetAccountParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to read account details.

**Data flow**: It receives account-read parameters, serializes them, sends account/read, and returns the request id.

**Call relations**: Account tests use this named wrapper, which forwards to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_chatgpt_auth_tokens_login_request`  (lines 419–432)

```
async fn send_chatgpt_auth_tokens_login_request(
        &mut self,
        access_token: String,
        chatgpt_account_id: String,
        chatgpt_plan_type: Option<String>,
    ) -> anyhow::Result
```

**Purpose**: Starts login using already available ChatGPT authentication tokens.

**Data flow**: It receives an access token, ChatGPT account id, and optional plan type, builds the login parameter object, sends account/login/start, and returns the request id.

**Call relations**: Login tests use this for token-based ChatGPT login. The final write goes through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_feedback_upload_request`  (lines 435–441)

```
async fn send_feedback_upload_request(
        &mut self,
        params: FeedbackUploadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a feedback upload request to the server.

**Data flow**: It serializes feedback parameters, sends feedback/upload, and returns the request id.

**Call relations**: Feedback tests call this wrapper; TestAppServer::send_request performs the shared JSON-RPC send.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_start_request`  (lines 444–450)

```
async fn send_thread_start_request(
        &mut self,
        params: ThreadStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests creation of a new conversation thread.

**Data flow**: It converts thread-start parameters to JSON, sends thread/start, and returns the request id.

**Call relations**: Many higher-level test helpers for starting threads and turns call this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 9 (start_thread, start_thread, start_turn, start_plan_mode_turn, start_default_thread, start_thread, start_thread, start_thread, run_environment_selection_case); 1 external calls (to_value).


##### `TestAppServer::send_thread_resume_request`  (lines 453–459)

```
async fn send_thread_resume_request(
        &mut self,
        params: ThreadResumeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that the server resume an existing thread.

**Data flow**: It serializes resume parameters, sends thread/resume, and returns the request id.

**Call relations**: Thread-resume tests use this wrapper, and the common send path is TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_fork_request`  (lines 462–468)

```
async fn send_thread_fork_request(
        &mut self,
        params: ThreadForkParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a new thread fork from an existing thread.

**Data flow**: It converts fork parameters to JSON, sends thread/fork, and returns the request id.

**Call relations**: The fork_fake_rollout_thread helper calls this. It hands the message to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (fork_fake_rollout_thread); 1 external calls (to_value).


##### `TestAppServer::send_thread_archive_request`  (lines 471–477)

```
async fn send_thread_archive_request(
        &mut self,
        params: ThreadArchiveParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that a thread be archived.

**Data flow**: It serializes archive parameters, sends thread/archive, and returns the request id.

**Call relations**: Thread archive tests call this named helper; it delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_delete_request`  (lines 480–486)

```
async fn send_thread_delete_request(
        &mut self,
        params: ThreadDeleteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests deletion of a thread.

**Data flow**: It converts delete parameters to JSON, sends thread/delete, and returns the request id.

**Call relations**: Thread deletion tests use this wrapper, which uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_set_name_request`  (lines 489–495)

```
async fn send_thread_set_name_request(
        &mut self,
        params: ThreadSetNameParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a name change for a thread.

**Data flow**: It serializes name-setting parameters, sends thread/name/set, and returns the request id.

**Call relations**: Thread metadata tests call this, and it forwards to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_metadata_update_request`  (lines 498–504)

```
async fn send_thread_metadata_update_request(
        &mut self,
        params: ThreadMetadataUpdateParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests an update to a thread's metadata, meaning extra descriptive information stored with the thread.

**Data flow**: It converts metadata update parameters to JSON, sends thread/metadata/update, and returns the request id.

**Call relations**: Tests use this wrapper when checking thread metadata behavior. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_settings_update_request`  (lines 507–513)

```
async fn send_thread_settings_update_request(
        &mut self,
        params: ThreadSettingsUpdateParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a change to settings for a thread.

**Data flow**: It serializes settings parameters, sends thread/settings/update, and returns the request id.

**Call relations**: The send_thread_settings_update helper calls this. It delegates the wire work to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_thread_settings_update); 1 external calls (to_value).


##### `TestAppServer::send_thread_unsubscribe_request`  (lines 516–522)

```
async fn send_thread_unsubscribe_request(
        &mut self,
        params: ThreadUnsubscribeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that the client stop receiving updates for a thread.

**Data flow**: It converts unsubscribe parameters to JSON, sends thread/unsubscribe, and returns the request id.

**Call relations**: Thread subscription tests call this wrapper. The actual JSON-RPC write is shared through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_unarchive_request`  (lines 525–531)

```
async fn send_thread_unarchive_request(
        &mut self,
        params: ThreadUnarchiveParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that an archived thread be restored.

**Data flow**: It serializes unarchive parameters, sends thread/unarchive, and returns the request id.

**Call relations**: Thread archive-state tests use this wrapper; it hands off to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_compact_start_request`  (lines 534–540)

```
async fn send_thread_compact_start_request(
        &mut self,
        params: ThreadCompactStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts a thread compaction operation, which reduces stored context for a thread.

**Data flow**: It converts compaction parameters to JSON, sends thread/compact/start, and returns the request id.

**Call relations**: Compaction tests use this and then wait for response or notifications through the read helpers. Sending goes through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_shell_command_request`  (lines 543–549)

```
async fn send_thread_shell_command_request(
        &mut self,
        params: ThreadShellCommandParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a shell command associated with a thread.

**Data flow**: It serializes shell-command parameters, sends thread/shellCommand, and returns the request id.

**Call relations**: Tests for thread shell behavior call this wrapper, which delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_rollback_request`  (lines 552–558)

```
async fn send_thread_rollback_request(
        &mut self,
        params: ThreadRollbackParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that a thread roll back to an earlier point.

**Data flow**: It converts rollback parameters to JSON, sends thread/rollback, and returns the request id.

**Call relations**: Rollback tests call this named helper. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_list_request`  (lines 561–567)

```
async fn send_thread_list_request(
        &mut self,
        params: ThreadListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for a list of threads.

**Data flow**: It serializes listing parameters, sends thread/list, and returns the request id.

**Call relations**: Helpers such as list_threads, list_threads_for_parent, and list_threads_with_sort call this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 3 (list_threads, list_threads_for_parent, list_threads_with_sort); 1 external calls (to_value).


##### `TestAppServer::send_thread_search_request`  (lines 570–576)

```
async fn send_thread_search_request(
        &mut self,
        params: ThreadSearchParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to search threads.

**Data flow**: It converts search parameters to JSON, sends thread/search, and returns the request id.

**Call relations**: Search tests use this wrapper, and the message is written by TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_loaded_list_request`  (lines 579–585)

```
async fn send_thread_loaded_list_request(
        &mut self,
        params: ThreadLoadedListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks which threads are currently loaded by the server.

**Data flow**: It serializes loaded-list parameters, sends thread/loaded/list, and returns the request id.

**Call relations**: Tests call this when checking in-memory thread state. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_read_request`  (lines 588–594)

```
async fn send_thread_read_request(
        &mut self,
        params: ThreadReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to read one thread's data.

**Data flow**: It converts read parameters to JSON, sends thread/read, and returns the request id.

**Call relations**: The read_thread_with_turns helper calls this. It forwards to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (read_thread_with_turns); 1 external calls (to_value).


##### `TestAppServer::send_thread_turns_list_request`  (lines 597–603)

```
async fn send_thread_turns_list_request(
        &mut self,
        params: ThreadTurnsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for the list of turns in a thread. A turn is one exchange or unit of work in a conversation.

**Data flow**: It serializes turn-list parameters, sends thread/turns/list, and returns the request id.

**Call relations**: The read_single_turn_items_view helper calls this. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (read_single_turn_items_view); 1 external calls (to_value).


##### `TestAppServer::send_thread_turns_items_list_request`  (lines 606–612)

```
async fn send_thread_turns_items_list_request(
        &mut self,
        params: ThreadTurnsItemsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for the items inside thread turns.

**Data flow**: It converts item-list parameters to JSON, sends thread/turns/items/list, and returns the request id.

**Call relations**: Tests use this wrapper when they need detailed turn contents. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_list_models_request`  (lines 615–621)

```
async fn send_list_models_request(
        &mut self,
        params: ModelListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server which models are available.

**Data flow**: It serializes model-list parameters, sends model/list, and returns the request id.

**Call relations**: Model-list tests call this wrapper; TestAppServer::send_request handles the common send mechanics.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_model_provider_capabilities_read_request`  (lines 624–631)

```
async fn send_model_provider_capabilities_read_request(
        &mut self,
        params: ModelProviderCapabilitiesReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks what a model provider can do, such as supported features or limits.

**Data flow**: It converts provider-capability parameters to JSON, sends modelProvider/capabilities/read, and returns the request id.

**Call relations**: Capability tests use this named helper, which forwards to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_experimental_feature_list_request`  (lines 634–640)

```
async fn send_experimental_feature_list_request(
        &mut self,
        params: ExperimentalFeatureListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to list experimental features.

**Data flow**: It serializes feature-list parameters, sends experimentalFeature/list, and returns the request id.

**Call relations**: Experimental-feature tests call this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_permission_profile_list_request`  (lines 643–649)

```
async fn send_permission_profile_list_request(
        &mut self,
        params: PermissionProfileListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for available permission profiles, which describe what actions are allowed.

**Data flow**: It converts permission-profile parameters to JSON, sends permissionProfile/list, and returns the request id.

**Call relations**: Permission tests use this wrapper. The actual write goes through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_experimental_feature_enablement_set_request`  (lines 652–659)

```
async fn send_experimental_feature_enablement_set_request(
        &mut self,
        params: codex_app_server_protocol::ExperimentalFeatureEnablementSetParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that an experimental feature be enabled or disabled.

**Data flow**: It serializes enablement parameters, sends experimentalFeature/enablement/set, and returns the request id.

**Call relations**: The set_experimental_feature_enablement helper calls this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (set_experimental_feature_enablement); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_enable_request`  (lines 662–665)

```
async fn send_remote_control_enable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Requests persistent remote-control enablement.

**Data flow**: It sends remoteControl/enable with no parameters and returns the request id.

**Call relations**: Remote-control tests use this shortcut, which relies on TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_remote_control_ephemeral_enable_request`  (lines 668–674)

```
async fn send_remote_control_ephemeral_enable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Requests remote-control enablement for only the current runtime session.

**Data flow**: It builds JSON with ephemeral set to true, sends remoteControl/enable, and returns the request id.

**Call relations**: Remote-control tests call this when they do not want the setting persisted. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_remote_control_disable_request`  (lines 677–680)

```
async fn send_remote_control_disable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Requests persistent remote-control disablement.

**Data flow**: It sends remoteControl/disable with no parameters and returns the request id.

**Call relations**: Remote-control tests use this shortcut. The message is sent by TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_remote_control_ephemeral_disable_request`  (lines 683–689)

```
async fn send_remote_control_ephemeral_disable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Requests remote-control disablement for only the current runtime session.

**Data flow**: It builds JSON with ephemeral set to true, sends remoteControl/disable, and returns the request id.

**Call relations**: Remote-control tests call this for temporary disable behavior. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_remote_control_status_read_request`  (lines 692–695)

```
async fn send_remote_control_status_read_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for the current remote-control status.

**Data flow**: It sends remoteControl/status/read with no parameters and returns the request id.

**Call relations**: Status tests call this wrapper, which delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_remote_control_pairing_start_request`  (lines 698–705)

```
async fn send_remote_control_pairing_start_request(
        &mut self,
        params: RemoteControlPairingStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts remote-control pairing, the process of linking another client.

**Data flow**: It serializes pairing-start parameters, sends remoteControl/pairing/start, and returns the request id.

**Call relations**: Pairing tests use this helper and then wait for responses through the stream-reading helpers.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_pairing_status_request`  (lines 708–715)

```
async fn send_remote_control_pairing_status_request(
        &mut self,
        params: RemoteControlPairingStatusParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks for the status of a remote-control pairing attempt.

**Data flow**: It converts pairing-status parameters to JSON, sends remoteControl/pairing/status, and returns the request id.

**Call relations**: Pairing tests call this after starting pairing. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_clients_list_request`  (lines 718–724)

```
async fn send_remote_control_clients_list_request(
        &mut self,
        params: RemoteControlClientsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for paired remote-control clients.

**Data flow**: It serializes client-list parameters, sends remoteControl/client/list, and returns the request id.

**Call relations**: Remote-control client tests use this wrapper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_clients_revoke_request`  (lines 727–734)

```
async fn send_remote_control_clients_revoke_request(
        &mut self,
        params: RemoteControlClientsRevokeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that a remote-control client be revoked.

**Data flow**: It converts revoke parameters to JSON, sends remoteControl/client/revoke, and returns the request id.

**Call relations**: Remote-control revoke tests call this. The actual send goes through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_apps_list_request`  (lines 737–740)

```
async fn send_apps_list_request(&mut self, params: AppsListParams) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for the list of available apps.

**Data flow**: It serializes app-list parameters, sends app/list, and returns the request id.

**Call relations**: The warm_app_directory_cache helper calls this. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (warm_app_directory_cache); 1 external calls (to_value).


##### `TestAppServer::send_mcp_resource_read_request`  (lines 743–749)

```
async fn send_mcp_resource_read_request(
        &mut self,
        params: McpResourceReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a resource from an MCP server. MCP is a tool/resource protocol used by connected services.

**Data flow**: It converts resource-read parameters to JSON, sends mcpServer/resource/read, and returns the request id.

**Call relations**: MCP resource tests use this wrapper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_mcp_server_tool_call_request`  (lines 752–758)

```
async fn send_mcp_server_tool_call_request(
        &mut self,
        params: McpServerToolCallParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a tool call on an MCP server.

**Data flow**: It serializes tool-call parameters, sends mcpServer/tool/call, and returns the request id.

**Call relations**: MCP tool tests call this helper and use the read helpers to inspect the result.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_skills_list_request`  (lines 761–767)

```
async fn send_skills_list_request(
        &mut self,
        params: SkillsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to list available skills.

**Data flow**: It converts skill-list parameters to JSON, sends skills/list, and returns the request id.

**Call relations**: Skill tests use this wrapper, which forwards to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_skills_extra_roots_set_request`  (lines 770–776)

```
async fn send_skills_extra_roots_set_request(
        &mut self,
        params: SkillsExtraRootsSetParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sets extra filesystem roots where the server should look for skills.

**Data flow**: It serializes extra-root parameters, sends skills/extraRoots/set, and returns the request id.

**Call relations**: Skill discovery tests call this. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_hooks_list_request`  (lines 779–785)

```
async fn send_hooks_list_request(
        &mut self,
        params: HooksListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to list configured hooks. Hooks are actions that run at specific moments.

**Data flow**: It converts hook-list parameters to JSON, sends hooks/list, and returns the request id.

**Call relations**: Hook tests call this wrapper. The common send path is TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_marketplace_add_request`  (lines 788–794)

```
async fn send_marketplace_add_request(
        &mut self,
        params: MarketplaceAddParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that a marketplace item be added.

**Data flow**: It serializes marketplace-add parameters, sends marketplace/add, and returns the request id.

**Call relations**: Marketplace tests use this helper; TestAppServer::send_request writes the message.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_marketplace_remove_request`  (lines 797–803)

```
async fn send_marketplace_remove_request(
        &mut self,
        params: MarketplaceRemoveParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that a marketplace item be removed.

**Data flow**: It converts remove parameters to JSON, sends marketplace/remove, and returns the request id.

**Call relations**: Marketplace tests call this named wrapper, which delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_marketplace_upgrade_request`  (lines 806–812)

```
async fn send_marketplace_upgrade_request(
        &mut self,
        params: MarketplaceUpgradeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests an upgrade for a marketplace item.

**Data flow**: It serializes upgrade parameters, sends marketplace/upgrade, and returns the request id.

**Call relations**: The send_marketplace_upgrade helper calls this. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_marketplace_upgrade); 1 external calls (to_value).


##### `TestAppServer::send_plugin_install_request`  (lines 815–821)

```
async fn send_plugin_install_request(
        &mut self,
        params: PluginInstallParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests installation of a plugin.

**Data flow**: It converts plugin-install parameters to JSON, sends plugin/install, and returns the request id.

**Call relations**: The send_remote_plugin_install_request helper calls this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_remote_plugin_install_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_uninstall_request`  (lines 824–830)

```
async fn send_plugin_uninstall_request(
        &mut self,
        params: PluginUninstallParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests removal of a plugin.

**Data flow**: It serializes uninstall parameters, sends plugin/uninstall, and returns the request id.

**Call relations**: Plugin tests use this wrapper, and the shared sender writes the JSON-RPC message.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_list_request`  (lines 833–839)

```
async fn send_plugin_list_request(
        &mut self,
        params: PluginListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to list plugins.

**Data flow**: It converts plugin-list parameters to JSON, sends plugin/list, and returns the request id.

**Call relations**: Plugin listing tests call this helper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_installed_request`  (lines 842–848)

```
async fn send_plugin_installed_request(
        &mut self,
        params: PluginInstalledParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server which plugins are installed.

**Data flow**: It serializes installed-plugin parameters, sends plugin/installed, and returns the request id.

**Call relations**: Plugin state tests use this wrapper. It hands off to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_read_request`  (lines 851–857)

```
async fn send_plugin_read_request(
        &mut self,
        params: PluginReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests detailed information about a plugin.

**Data flow**: It converts plugin-read parameters to JSON, sends plugin/read, and returns the request id.

**Call relations**: Plugin detail tests call this. The common send function writes the message.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_skill_read_request`  (lines 860–866)

```
async fn send_plugin_skill_read_request(
        &mut self,
        params: PluginSkillReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests detailed information about a skill provided by a plugin.

**Data flow**: It serializes plugin-skill parameters, sends plugin/skill/read, and returns the request id.

**Call relations**: Plugin skill tests use this wrapper; it delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_list_mcp_server_status_request`  (lines 869–875)

```
async fn send_list_mcp_server_status_request(
        &mut self,
        params: ListMcpServerStatusParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks for the status of configured MCP servers.

**Data flow**: It converts status-list parameters to JSON, sends mcpServerStatus/list, and returns the request id.

**Call relations**: The mcp_server_names helper calls this. It forwards to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (mcp_server_names); 1 external calls (to_value).


##### `TestAppServer::send_raw_request`  (lines 878–884)

```
async fn send_raw_request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a JSON-RPC request with raw JSON parameters. Tests use it when they intentionally want malformed or unusual input.

**Data flow**: It receives a method name and optional raw JSON parameters, sends them unchanged, and returns the request id.

**Call relations**: Protocol validation tests use this to bypass typed parameter construction. It still relies on TestAppServer::send_request for writing.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_list_collaboration_modes_request`  (lines 886–892)

```
async fn send_list_collaboration_modes_request(
        &mut self,
        params: CollaborationModeListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for available collaboration modes.

**Data flow**: It serializes collaboration-mode parameters, sends collaborationMode/list, and returns the request id.

**Call relations**: Collaboration tests call this wrapper. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_mock_experimental_method_request`  (lines 895–901)

```
async fn send_mock_experimental_method_request(
        &mut self,
        params: MockExperimentalMethodParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a mock experimental request used by tests of experimental API behavior.

**Data flow**: It converts mock parameters to JSON, sends mock/experimentalMethod, and returns the request id.

**Call relations**: Experimental protocol tests use this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_memory_mode_set_request`  (lines 904–910)

```
async fn send_thread_memory_mode_set_request(
        &mut self,
        params: ThreadMemoryModeSetParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a memory-mode change for a thread.

**Data flow**: It serializes memory-mode parameters, sends thread/memoryMode/set, and returns the request id.

**Call relations**: Thread memory tests call this wrapper, and TestAppServer::send_request sends the JSON-RPC request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_turn_start_request`  (lines 913–919)

```
async fn send_turn_start_request(
        &mut self,
        params: TurnStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts a new turn in a thread.

**Data flow**: It converts turn-start parameters to JSON, sends turn/start, and returns the request id.

**Call relations**: Helpers such as send_turn_and_wait, start_turn, and start_plan_mode_turn call this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 6 (send_turn_and_wait, start_turn, start_plan_mode_turn, materialize_thread_rollout, start_text_turn, run_environment_selection_case); 1 external calls (to_value).


##### `TestAppServer::send_thread_inject_items_request`  (lines 922–928)

```
async fn send_thread_inject_items_request(
        &mut self,
        params: ThreadInjectItemsParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Injects items into a thread, usually to set up a test state.

**Data flow**: It serializes injection parameters, sends thread/inject_items, and returns the request id.

**Call relations**: Tests use this to seed thread contents. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_request`  (lines 931–937)

```
async fn send_command_exec_request(
        &mut self,
        params: CommandExecParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests execution of a command through the newer command API.

**Data flow**: It converts command-exec parameters to JSON, sends command/exec, and returns the request id.

**Call relations**: Command execution tests call this wrapper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_spawn_request`  (lines 940–946)

```
async fn send_process_spawn_request(
        &mut self,
        params: ProcessSpawnParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that the server spawn a process.

**Data flow**: It serializes process-spawn parameters, sends process/spawn, and returns the request id.

**Call relations**: Process API tests use this helper, with responses and notifications read later through stream helpers.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_write_stdin_request`  (lines 949–955)

```
async fn send_process_write_stdin_request(
        &mut self,
        params: ProcessWriteStdinParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Writes input to a spawned process through the server.

**Data flow**: It converts stdin-write parameters to JSON, sends process/writeStdin, and returns the request id.

**Call relations**: Process interaction tests call this after spawning a process. It sends through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_resize_pty_request`  (lines 958–964)

```
async fn send_process_resize_pty_request(
        &mut self,
        params: ProcessResizePtyParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a resize of a process pseudo-terminal. A pseudo-terminal is a terminal-like interface for interactive programs.

**Data flow**: It serializes resize parameters, sends process/resizePty, and returns the request id.

**Call relations**: Interactive process tests use this wrapper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_kill_request`  (lines 967–973)

```
async fn send_process_kill_request(
        &mut self,
        params: ProcessKillParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests termination of a spawned process.

**Data flow**: It converts kill parameters to JSON, sends process/kill, and returns the request id.

**Call relations**: Process lifecycle tests call this. The common sender writes the message.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_write_request`  (lines 976–982)

```
async fn send_command_exec_write_request(
        &mut self,
        params: CommandExecWriteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Writes input to a running command execution.

**Data flow**: It serializes command-write parameters, sends command/exec/write, and returns the request id.

**Call relations**: Command execution tests use this after starting a command. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_resize_request`  (lines 985–991)

```
async fn send_command_exec_resize_request(
        &mut self,
        params: CommandExecResizeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests a terminal resize for a running command execution.

**Data flow**: It converts resize parameters to JSON, sends command/exec/resize, and returns the request id.

**Call relations**: Command terminal tests call this wrapper. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_terminate_request`  (lines 994–1000)

```
async fn send_command_exec_terminate_request(
        &mut self,
        params: CommandExecTerminateParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests termination of a running command execution.

**Data flow**: It serializes termination parameters, sends command/exec/terminate, and returns the request id.

**Call relations**: Command lifecycle tests call this. The request goes through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_turn_interrupt_request`  (lines 1003–1009)

```
async fn send_turn_interrupt_request(
        &mut self,
        params: TurnInterruptParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that an in-flight turn be interrupted.

**Data flow**: It converts interrupt parameters to JSON, sends turn/interrupt, and returns the request id.

**Call relations**: TestAppServer::interrupt_turn_and_wait_for_aborted calls this as the first cleanup step for a running turn.

*Call graph*: calls 1 internal fn (send_request); called by 1 (interrupt_turn_and_wait_for_aborted); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_start_request`  (lines 1012–1018)

```
async fn send_thread_realtime_start_request(
        &mut self,
        params: ThreadRealtimeStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts a realtime session for a thread.

**Data flow**: It serializes realtime-start parameters, sends thread/realtime/start, and returns the request id.

**Call relations**: The start_webrtc_realtime_with_codex_responses_as_items helper calls this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_webrtc_realtime_with_codex_responses_as_items); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_append_audio_request`  (lines 1021–1028)

```
async fn send_thread_realtime_append_audio_request(
        &mut self,
        params: ThreadRealtimeAppendAudioParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Adds audio data to a realtime thread session.

**Data flow**: It converts audio parameters to JSON, sends thread/realtime/appendAudio, and returns the request id.

**Call relations**: The append_audio helper calls this during realtime tests. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (append_audio); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_append_text_request`  (lines 1031–1038)

```
async fn send_thread_realtime_append_text_request(
        &mut self,
        params: ThreadRealtimeAppendTextParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Adds text to a realtime thread session.

**Data flow**: It serializes text parameters, sends thread/realtime/appendText, and returns the request id.

**Call relations**: The append_text helper calls this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (append_text); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_append_speech_request`  (lines 1041–1048)

```
async fn send_thread_realtime_append_speech_request(
        &mut self,
        params: ThreadRealtimeAppendSpeechParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Adds speech input metadata or content to a realtime thread session.

**Data flow**: It converts speech parameters to JSON, sends thread/realtime/appendSpeech, and returns the request id.

**Call relations**: The append_speech helper calls this during realtime tests. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (append_speech); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_stop_request`  (lines 1051–1057)

```
async fn send_thread_realtime_stop_request(
        &mut self,
        params: ThreadRealtimeStopParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Stops a realtime thread session.

**Data flow**: It serializes stop parameters, sends thread/realtime/stop, and returns the request id.

**Call relations**: Realtime tests call this when ending a session. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_list_voices_request`  (lines 1059–1066)

```
async fn send_thread_realtime_list_voices_request(
        &mut self,
        params: ThreadRealtimeListVoicesParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the realtime API which voices are available.

**Data flow**: It converts list-voices parameters to JSON, sends thread/realtime/listVoices, and returns the request id.

**Call relations**: Realtime voice tests use this wrapper, which writes through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::interrupt_turn_and_wait_for_aborted`  (lines 1078–1124)

```
async fn interrupt_turn_and_wait_for_aborted(
        &mut self,
        thread_id: String,
        turn_id: String,
        read_timeout: std::time::Duration,
    ) -> anyhow::Result<()>
```

**Purpose**: Cleanly interrupts a running turn and waits until the server confirms that the turn is finished. This prevents flaky tests caused by background work leaking into teardown.

**Data flow**: It receives a thread id, turn id, and timeout. It sends turn/interrupt, waits for the interrupt response, then waits for a turn/completed notification, accepting an already buffered matching completion if a race happened.

**Call relations**: Tests call this during cleanup for intentionally in-flight turns. It uses TestAppServer::send_turn_interrupt_request, TestAppServer::read_stream_until_response_message, TestAppServer::read_stream_until_notification_message, and TestAppServer::pending_turn_completed_notification.

*Call graph*: calls 4 internal fn (pending_turn_completed_notification, read_stream_until_notification_message, read_stream_until_response_message, send_turn_interrupt_request); 2 external calls (Integer, timeout).


##### `TestAppServer::send_turn_steer_request`  (lines 1127–1133)

```
async fn send_turn_steer_request(
        &mut self,
        params: TurnSteerParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends steering input to an active turn, meaning extra guidance while work is running.

**Data flow**: It serializes steering parameters, sends turn/steer, and returns the request id.

**Call relations**: Turn-steering tests use this wrapper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_review_start_request`  (lines 1136–1142)

```
async fn send_review_start_request(
        &mut self,
        params: ReviewStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts a review operation through the server.

**Data flow**: It converts review-start parameters to JSON, sends review/start, and returns the request id.

**Call relations**: Review tests call this helper and then read the server response or notifications.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_windows_sandbox_setup_start_request`  (lines 1144–1150)

```
async fn send_windows_sandbox_setup_start_request(
        &mut self,
        params: WindowsSandboxSetupStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts Windows sandbox setup through the server.

**Data flow**: It serializes sandbox setup parameters, sends windowsSandbox/setupStart, and returns the request id.

**Call relations**: Windows sandbox tests use this wrapper. It sends through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_config_read_request`  (lines 1152–1158)

```
async fn send_config_read_request(
        &mut self,
        params: ConfigReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to read configuration values.

**Data flow**: It converts config-read parameters to JSON, sends config/read, and returns the request id.

**Call relations**: The read_config helper calls this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 1 (read_config); 1 external calls (to_value).


##### `TestAppServer::send_config_requirements_read_request`  (lines 1160–1163)

```
async fn send_config_requirements_read_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to read configuration requirements.

**Data flow**: It sends configRequirements/read with no parameters and returns the request id.

**Call relations**: Configuration requirement tests call this shortcut. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_config_value_write_request`  (lines 1165–1171)

```
async fn send_config_value_write_request(
        &mut self,
        params: ConfigValueWriteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests writing one configuration value.

**Data flow**: It serializes config-write parameters, sends config/value/write, and returns the request id.

**Call relations**: Configuration write tests call this wrapper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_config_batch_write_request`  (lines 1173–1179)

```
async fn send_config_batch_write_request(
        &mut self,
        params: ConfigBatchWriteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests writing several configuration values at once.

**Data flow**: It converts batch-write parameters to JSON, sends config/batchWrite, and returns the request id.

**Call relations**: Batch configuration tests use this helper. The common sender writes the request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_read_file_request`  (lines 1181–1187)

```
async fn send_fs_read_file_request(
        &mut self,
        params: FsReadFileParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to read a file.

**Data flow**: It serializes file-read parameters, sends fs/readFile, and returns the request id.

**Call relations**: Filesystem tests call this wrapper and read the response through the stream helpers.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_write_file_request`  (lines 1189–1195)

```
async fn send_fs_write_file_request(
        &mut self,
        params: FsWriteFileParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to write a file.

**Data flow**: It converts file-write parameters to JSON, sends fs/writeFile, and returns the request id.

**Call relations**: Filesystem write tests use this helper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_create_directory_request`  (lines 1197–1203)

```
async fn send_fs_create_directory_request(
        &mut self,
        params: FsCreateDirectoryParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to create a directory.

**Data flow**: It serializes create-directory parameters, sends fs/createDirectory, and returns the request id.

**Call relations**: Filesystem tests call this wrapper. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_get_metadata_request`  (lines 1205–1211)

```
async fn send_fs_get_metadata_request(
        &mut self,
        params: FsGetMetadataParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server for metadata about a filesystem path, such as whether it is a file or directory.

**Data flow**: It converts metadata parameters to JSON, sends fs/getMetadata, and returns the request id.

**Call relations**: Filesystem metadata tests call this helper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_read_directory_request`  (lines 1213–1219)

```
async fn send_fs_read_directory_request(
        &mut self,
        params: FsReadDirectoryParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to list a directory.

**Data flow**: It serializes directory-read parameters, sends fs/readDirectory, and returns the request id.

**Call relations**: Filesystem listing tests use this wrapper. The common sender writes the request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_remove_request`  (lines 1221–1224)

```
async fn send_fs_remove_request(&mut self, params: FsRemoveParams) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to remove a file or directory.

**Data flow**: It converts remove parameters to JSON, sends fs/remove, and returns the request id.

**Call relations**: Filesystem removal tests call this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_copy_request`  (lines 1226–1229)

```
async fn send_fs_copy_request(&mut self, params: FsCopyParams) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to copy a file or directory.

**Data flow**: It serializes copy parameters, sends fs/copy, and returns the request id.

**Call relations**: Filesystem copy tests use this wrapper. It sends through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_watch_request`  (lines 1231–1234)

```
async fn send_fs_watch_request(&mut self, params: FsWatchParams) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to watch a filesystem path for changes.

**Data flow**: It converts watch parameters to JSON, sends fs/watch, and returns the request id.

**Call relations**: Filesystem watch tests call this and then wait for notifications through the read helpers.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_unwatch_request`  (lines 1236–1242)

```
async fn send_fs_unwatch_request(
        &mut self,
        params: FsUnwatchParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Asks the server to stop watching a filesystem path.

**Data flow**: It serializes unwatch parameters, sends fs/unwatch, and returns the request id.

**Call relations**: Filesystem watch tests use this to clean up watched paths. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_logout_account_request`  (lines 1245–1247)

```
async fn send_logout_account_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Requests account logout.

**Data flow**: It sends account/logout with no parameters and returns the request id.

**Call relations**: Login and account tests use this shortcut. It relies on TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_login_account_api_key_request`  (lines 1250–1259)

```
async fn send_login_account_api_key_request(
        &mut self,
        api_key: &str,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts account login using an API key.

**Data flow**: It receives an API key string, builds the JSON shape expected by account/login/start, sends it, and returns the request id.

**Call relations**: Login helpers such as login_with_api_key_via_request and login_with_api_key call this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 4 (login_with_api_key_via_request, login_with_api_key, login_with_api_key, login_with_api_key); 1 external calls (json!).


##### `TestAppServer::send_login_account_chatgpt_request`  (lines 1262–1267)

```
async fn send_login_account_chatgpt_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Starts the normal ChatGPT login flow.

**Data flow**: It builds JSON that names the chatgpt login type, sends account/login/start, and returns the request id.

**Call relations**: ChatGPT login tests call this wrapper. The actual write goes through TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_login_account_chatgpt_device_code_request`  (lines 1270–1275)

```
async fn send_login_account_chatgpt_device_code_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Starts ChatGPT device-code login, where a user completes login using a code on another device or browser.

**Data flow**: It builds JSON for the chatgptDeviceCode login type, sends account/login/start, and returns the request id.

**Call relations**: Device-code login tests use this helper. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_cancel_login_account_request`  (lines 1278–1284)

```
async fn send_cancel_login_account_request(
        &mut self,
        params: CancelLoginAccountParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests cancellation of an in-progress login.

**Data flow**: It serializes cancel-login parameters, sends account/login/cancel, and returns the request id.

**Call relations**: Login cancellation tests call this wrapper. It uses TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fuzzy_file_search_request`  (lines 1287–1301)

```
async fn send_fuzzy_file_search_request(
        &mut self,
        query: &str,
        roots: Vec<String>,
        cancellation_token: Option<String>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Runs a fuzzy file search, which finds files matching an approximate query rather than an exact path.

**Data flow**: It receives a query, root directories, and an optional cancellation token, builds JSON parameters, sends fuzzyFileSearch, and returns the request id.

**Call relations**: File-search tests call this directly. It delegates the final message write to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_fuzzy_file_search_session_start_request`  (lines 1303–1314)

```
async fn send_fuzzy_file_search_session_start_request(
        &mut self,
        session_id: &str,
        roots: Vec<String>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Starts a stateful fuzzy file search session.

**Data flow**: It receives a session id and roots, builds JSON parameters, sends fuzzyFileSearch/sessionStart, and returns the request id.

**Call relations**: TestAppServer::start_fuzzy_file_search_session calls this before waiting for the matching response.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_fuzzy_file_search_session); 1 external calls (json!).


##### `TestAppServer::start_fuzzy_file_search_session`  (lines 1316–1326)

```
async fn start_fuzzy_file_search_session(
        &mut self,
        session_id: &str,
        roots: Vec<String>,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Starts a fuzzy search session and waits for its response in one step.

**Data flow**: It sends the session-start request, turns the returned numeric id into a JSON-RPC request id, waits until that response arrives, and returns the response.

**Call relations**: Search-session tests use this convenience helper. It combines TestAppServer::send_fuzzy_file_search_session_start_request with TestAppServer::read_stream_until_response_message.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_fuzzy_file_search_session_start_request); 1 external calls (Integer).


##### `TestAppServer::send_fuzzy_file_search_session_update_request`  (lines 1328–1339)

```
async fn send_fuzzy_file_search_session_update_request(
        &mut self,
        session_id: &str,
        query: &str,
    ) -> anyhow::Result<i64>
```

**Purpose**: Updates the query for an existing fuzzy file search session.

**Data flow**: It receives a session id and query, builds JSON, sends fuzzyFileSearch/sessionUpdate, and returns the request id.

**Call relations**: TestAppServer::update_fuzzy_file_search_session and tests for missing sessions call this. It delegates to TestAppServer::send_request.

*Call graph*: calls 1 internal fn (send_request); called by 2 (update_fuzzy_file_search_session, assert_update_request_fails_for_missing_session); 1 external calls (json!).


##### `TestAppServer::update_fuzzy_file_search_session`  (lines 1341–1351)

```
async fn update_fuzzy_file_search_session(
        &mut self,
        session_id: &str,
        query: &str,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Updates a fuzzy search session and waits for the server response.

**Data flow**: It sends the session-update request, waits for the response with the same id, and returns that response.

**Call relations**: Search-session tests use this convenience helper. It combines TestAppServer::send_fuzzy_file_search_session_update_request with TestAppServer::read_stream_until_response_message.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_fuzzy_file_search_session_update_request); 1 external calls (Integer).


##### `TestAppServer::send_fuzzy_file_search_session_stop_request`  (lines 1353–1362)

```
async fn send_fuzzy_file_search_session_stop_request(
        &mut self,
        session_id: &str,
    ) -> anyhow::Result<i64>
```

**Purpose**: Requests that a fuzzy file search session stop.

**Data flow**: It receives a session id, builds JSON parameters, sends fuzzyFileSearch/sessionStop, and returns the request id.

**Call relations**: TestAppServer::stop_fuzzy_file_search_session calls this before waiting for the response.

*Call graph*: calls 1 internal fn (send_request); called by 1 (stop_fuzzy_file_search_session); 1 external calls (json!).


##### `TestAppServer::stop_fuzzy_file_search_session`  (lines 1364–1373)

```
async fn stop_fuzzy_file_search_session(
        &mut self,
        session_id: &str,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Stops a fuzzy search session and waits for confirmation.

**Data flow**: It sends the stop request, waits for the response with the same id, and returns that response.

**Call relations**: Search-session tests use this as a cleanup and assertion helper. It combines TestAppServer::send_fuzzy_file_search_session_stop_request with TestAppServer::read_stream_until_response_message.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_fuzzy_file_search_session_stop_request); 1 external calls (Integer).


##### `TestAppServer::send_request`  (lines 1375–1390)

```
async fn send_request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Builds and sends one JSON-RPC request, assigning it a unique numeric id.

**Data flow**: It receives a method name and optional JSON parameters, increments the next request id, wraps everything into a JSON-RPC request message, writes it to the server, and returns the id.

**Call relations**: Almost every send_* helper funnels into this function. It hands the finished message to TestAppServer::send_jsonrpc_message.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 104 (initialize_with_params, send_add_credits_nudge_email_request, send_apps_list_request, send_cancel_login_account_request, send_chatgpt_auth_tokens_login_request, send_command_exec_request, send_command_exec_resize_request, send_command_exec_terminate_request, send_command_exec_write_request, send_config_batch_write_request (+15 more)); 3 external calls (fetch_add, Request, Integer).


##### `TestAppServer::send_response`  (lines 1392–1399)

```
async fn send_response(
        &mut self,
        id: RequestId,
        result: serde_json::Value,
    ) -> anyhow::Result<()>
```

**Purpose**: Sends a JSON-RPC response back to the server. This is needed when the server asks the test client for something.

**Data flow**: It receives a request id and JSON result, wraps them in a response message, and writes it to stdin.

**Call relations**: Helpers such as respond_to_refresh_request use this after reading a server request. It delegates to TestAppServer::send_jsonrpc_message.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 1 (respond_to_refresh_request); 1 external calls (Response).


##### `TestAppServer::send_error`  (lines 1401–1408)

```
async fn send_error(
        &mut self,
        id: RequestId,
        error: JSONRPCErrorError,
    ) -> anyhow::Result<()>
```

**Purpose**: Sends a JSON-RPC error response back to the server.

**Data flow**: It receives a request id and error object, wraps them into an error message, and writes it to the server.

**Call relations**: Tests can use this when simulating a client-side failure in response to a server request. It delegates to TestAppServer::send_jsonrpc_message.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); 1 external calls (Error).


##### `TestAppServer::send_notification`  (lines 1410–1424)

```
async fn send_notification(
        &mut self,
        notification: ClientNotification,
    ) -> anyhow::Result<()>
```

**Purpose**: Sends a client notification, which is a JSON-RPC message that does not expect a response.

**Data flow**: It receives a typed notification, converts it to JSON, extracts the method and optional parameters, writes the notification message, and returns success or an error if the shape is invalid.

**Call relations**: Initialization uses this to send the initialized notification after the server accepts initialize. The final write goes through TestAppServer::send_jsonrpc_message.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 1 (initialize_with_params); 2 external calls (Notification, to_value).


##### `TestAppServer::send_jsonrpc_message`  (lines 1426–1436)

```
async fn send_jsonrpc_message(&mut self, message: JSONRPCMessage) -> anyhow::Result<()>
```

**Purpose**: Writes one JSON-RPC message to the server process. It is the lowest-level output path in this helper.

**Data flow**: It receives a JSON-RPC message, serializes it as one JSON line, writes it to child stdin, adds a newline, flushes the pipe, and returns success. If stdin is already closed, it reports an error.

**Call relations**: TestAppServer::send_request, TestAppServer::send_response, TestAppServer::send_error, and TestAppServer::send_notification all rely on this function.

*Call graph*: called by 4 (send_error, send_notification, send_request, send_response); 3 external calls (bail!, eprintln!, to_string).


##### `TestAppServer::read_jsonrpc_message`  (lines 1438–1444)

```
async fn read_jsonrpc_message(&mut self) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Reads one JSON-RPC message from the server process.

**Data flow**: It reads one line from child stdout, parses that line as a JSON-RPC message, logs it for test debugging, and returns the parsed message.

**Call relations**: Initialization and the stream-scanning helper use this whenever they need the next raw message from the server.

*Call graph*: called by 2 (initialize_with_params, read_stream_until_message); 3 external calls (read_line, new, eprintln!).


##### `TestAppServer::read_stream_until_request_message`  (lines 1446–1459)

```
async fn read_stream_until_request_message(&mut self) -> anyhow::Result<ServerRequest>
```

**Purpose**: Reads messages until the server sends a request to the client.

**Data flow**: It scans the stream for the next request message, buffers unrelated messages, converts the JSON-RPC request into the typed ServerRequest form, and returns it.

**Call relations**: The respond_to_refresh_request helper uses this when the server asks the client for refreshed authentication. It relies on TestAppServer::read_stream_until_message.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 1 (respond_to_refresh_request); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_stream_until_response_message`  (lines 1461–1477)

```
async fn read_stream_until_response_message(
        &mut self,
        request_id: RequestId,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Reads messages until it finds the response for a specific request id.

**Data flow**: It receives a request id, scans current buffered and incoming messages until one has that id, expects it to be a response, and returns the response.

**Call relations**: Many higher-level helpers call this after sending a request. It relies on TestAppServer::read_stream_until_message, which preserves unrelated messages for later.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 37 (interrupt_turn_and_wait_for_aborted, start_fuzzy_file_search_session, stop_fuzzy_file_search_session, update_fuzzy_file_search_session, login_with_api_key_via_request, fork_fake_rollout_thread, send_turn_and_wait, start_thread, mcp_server_names, start_thread (+15 more)); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_stream_until_error_message`  (lines 1479–1493)

```
async fn read_stream_until_error_message(
        &mut self,
        request_id: RequestId,
    ) -> anyhow::Result<JSONRPCError>
```

**Purpose**: Reads messages until it finds an error for a specific request id.

**Data flow**: It receives a request id, scans buffered and incoming messages for that id, expects the matching message to be an error, and returns it.

**Call relations**: Error assertion helpers call this when a request should fail. It uses TestAppServer::read_stream_until_message.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 4 (assert_update_request_fails_for_missing_session, expect_error_message, read_error_response, assert_remote_control_disabled_by_requirements); 1 external calls (unreachable!).


##### `TestAppServer::read_stream_until_notification_message`  (lines 1495–1514)

```
async fn read_stream_until_notification_message(
        &mut self,
        method: &str,
    ) -> anyhow::Result<JSONRPCNotification>
```

**Purpose**: Reads messages until it finds a notification with a specific method name.

**Data flow**: It receives a notification method string, scans buffered and incoming messages, returns the matching notification, and stores non-matching messages for future reads.

**Call relations**: Many wait helpers use this for events such as turn completion, command output, and app-list updates. It delegates scanning to TestAppServer::read_stream_until_message.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 25 (interrupt_turn_and_wait_for_aborted, assert_no_session_updates_for, read_app_list_updated_notification, read_command_exec_delta, wait_for_context_compaction_completed, wait_for_context_compaction_started, wait_for_turn_completed, wait_for_dynamic_tool_completed, wait_for_dynamic_tool_started, maybe_fs_changed_notification (+15 more)); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_stream_until_matching_notification`  (lines 1516–1539)

```
async fn read_stream_until_matching_notification(
        &mut self,
        description: &str,
        predicate: F,
    ) -> anyhow::Result<JSONRPCNotification>
```

**Purpose**: Reads messages until it finds a notification accepted by a caller-supplied test.

**Data flow**: It receives a human description and a predicate function, scans notifications until the predicate returns true, and returns that notification while buffering others.

**Call relations**: Helpers such as wait_for_session_completed and wait_for_session_updated use this when matching needs more than just a method name.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 2 (wait_for_session_completed, wait_for_session_updated); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_next_message`  (lines 1541–1543)

```
async fn read_next_message(&mut self) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Reads the next available message, considering both buffered messages and new stream input.

**Data flow**: It asks the stream scanner for any message at all and returns the first one it can provide.

**Call relations**: Collection helpers use this when they want to inspect the raw flow of messages. It is a thin wrapper over TestAppServer::read_stream_until_message.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 4 (collect_turn_notifications, collect_cyber_policy_error_and_validate_no_reroute, collect_model_verification_notifications_and_validate_no_warning_item, collect_turn_notifications_and_validate_no_warning_item).


##### `TestAppServer::clear_message_buffer`  (lines 1549–1551)

```
fn clear_message_buffer(&mut self)
```

**Purpose**: Discards messages that were saved for later. Tests use it when old messages are no longer relevant.

**Data flow**: It clears the pending message queue in place and returns nothing.

**Call relations**: The run_environment_selection_case helper calls this before checking a later phase so older buffered messages do not affect the assertion.

*Call graph*: called by 1 (run_environment_selection_case); 1 external calls (clear).


##### `TestAppServer::pending_notification_methods`  (lines 1553–1561)

```
fn pending_notification_methods(&self) -> Vec<String>
```

**Purpose**: Reports the method names of notifications currently buffered.

**Data flow**: It looks through the pending message queue, keeps only notifications, copies their method names, and returns them as a list.

**Call relations**: Tests can use this for debugging or assertions about what arrived out of order. It does not read from the process.

*Call graph*: 1 external calls (iter).


##### `TestAppServer::read_stream_until_message`  (lines 1565–1580)

```
async fn read_stream_until_message(&mut self, predicate: F) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Scans the server message stream until a caller-supplied condition matches. It is the core reader that makes out-of-order messages manageable.

**Data flow**: It first checks buffered messages for a match. If none match, it repeatedly reads new messages; matching messages are returned and non-matching messages are pushed into the pending queue.

**Call relations**: All specialized read helpers call this. It uses TestAppServer::take_pending_message for the buffer and TestAppServer::read_jsonrpc_message for new input.

*Call graph*: calls 2 internal fn (read_jsonrpc_message, take_pending_message); called by 6 (read_next_message, read_stream_until_error_message, read_stream_until_matching_notification, read_stream_until_notification_message, read_stream_until_request_message, read_stream_until_response_message); 1 external calls (push_back).


##### `TestAppServer::take_pending_message`  (lines 1582–1590)

```
fn take_pending_message(&mut self, predicate: &F) -> Option<JSONRPCMessage>
```

**Purpose**: Removes and returns the first buffered message that matches a condition.

**Data flow**: It receives a predicate, searches the pending message queue, removes the matching message if found, and returns it; otherwise it returns nothing.

**Call relations**: TestAppServer::read_stream_until_message calls this before reading from stdout so already-buffered messages are not missed.

*Call graph*: called by 1 (read_stream_until_message); 2 external calls (iter, remove).


##### `TestAppServer::pending_turn_completed_notification`  (lines 1592–1609)

```
fn pending_turn_completed_notification(&self, thread_id: &str, turn_id: &str) -> bool
```

**Purpose**: Checks whether a matching turn/completed notification is already buffered. This helps cleanup tolerate race conditions.

**Data flow**: It receives a thread id and turn id, searches buffered notifications, parses turn/completed payloads, and returns true only if one matches both ids.

**Call relations**: TestAppServer::interrupt_turn_and_wait_for_aborted calls this when a timeout might simply mean the completion notification already arrived while waiting for another message.

*Call graph*: called by 1 (interrupt_turn_and_wait_for_aborted); 1 external calls (iter).


##### `TestAppServer::message_request_id`  (lines 1611–1618)

```
fn message_request_id(message: &JSONRPCMessage) -> Option<&RequestId>
```

**Purpose**: Extracts the request id from any JSON-RPC message type that has one.

**Data flow**: It receives a message, returns the id for requests, responses, or errors, and returns nothing for notifications because notifications do not have ids.

**Call relations**: Response and error readers use this through TestAppServer::read_stream_until_message to find messages belonging to a specific request.


##### `TestAppServer::drop`  (lines 1622–1662)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the child app server process when the test helper goes away. This reduces flaky test failures from leftover processes.

**Data flow**: It closes stdin to request graceful shutdown, polls briefly for exit, asks the operating system to kill the process if needed, then waits up to a short limit for the process to be reported as exited.

**Call relations**: Rust calls this automatically when TestAppServer is dropped. It complements the launch code in TestAppServer::new_with_program_env_and_args and protects the rest of the test suite from leaked child processes.

*Call graph*: 6 external calls (start_kill, try_wait, sleep, from_millis, from_secs, now).


### Integration suite indexes
These top-level test modules collect the shared harness into the compiled integration binary and organize the feature-specific suite tree, including the large v2 branch.

### `app-server/tests/all.rs`

`test` · `test run`

This file is intentionally small, but it plays an important organizing role. In Rust, each file under `tests/` can become a separate integration test program. Here, the project chooses to have one integration test binary instead of many separate ones. Think of it like a table of contents: this file does not contain the test chapters itself, but it tells Rust where to find them.

The line `mod suite;` brings in the `suite` module, whose code lives under `tests/suite/`. That is where the actual test cases are kept. When the test command runs, Rust compiles this file, follows that module link, and includes the suite tests in the resulting test binary.

The `#![allow(clippy::expect_used)]` line relaxes one lint rule for this test binary. Clippy is Rust’s extra code checker, and `expect` is a way to say “this should succeed, and if it does not, stop with this message.” Production code may avoid that style, but tests often use it because a failed setup step should immediately fail the test with a clear reason.

Without this file, the grouped integration test suite would not be pulled into this specific test binary.


### `app-server/tests/suite/mod.rs`

`test` · `test discovery and test compilation`

This file does not contain test logic itself. Instead, it names several test modules: authentication, conversation summaries, fuzzy file search, strict configuration, and version 2 API behavior. In Rust, a `mod` line is like putting a labeled folder into the test suite. Without these lines, the test files may still exist on disk, but the test runner would not know to include them from this suite entry point.

Its job is important because it keeps the test suite organized. Each feature area can have its own file with focused tests, while this file gathers them into one place. A newcomer can read it as a quick map of what parts of the app server are covered by this particular suite. It is active only when tests are being compiled or run; it has no effect on the normal app server at runtime.


### `app-server/tests/suite/v2/mod.rs`

`test` · `test discovery and compilation`

This file does not contain test code itself. Instead, it gathers many separate test modules under one shared test suite, much like the contents page of a handbook points readers to each chapter. Each `mod` line names another Rust file in the same test area, such as tests for accounts, plugins, threads, permissions, web search, rate limits, and websocket behavior.

Its main job is to make sure those test files are compiled and run as part of the version 2 app-server tests. Without this file, many of the test files could exist on disk but never be included in the test build, meaning important behavior might stop being checked.

A few entries are guarded by `cfg` conditions, which are compile-time rules. For example, Unix-only tests are included only on Unix-like systems, non-Windows executor tests are skipped on Windows, and one remote thread store test is included only in debug builds. This prevents tests from being compiled where the required platform feature does not exist.

So this file matters because it defines the shape of the test suite. It does not test features directly, but it decides which feature tests are part of the run.
