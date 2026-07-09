# App-server unit tests and shared integration fixtures  `stage-23.1.3`

This stage is the app server’s safety net. It sits behind the scenes and checks both small internal rules and bigger end-to-end behavior before changes can break real users.

The unit test files each pin down one part of the server. Some focus on configuration: importing outside agent settings, reading and writing config files, and turning command-line override flags into the right settings. Others check request handling: tracing request flows, deciding when imported agent data should refresh caches, mapping remote-control failures into client-facing errors, and managing thread state, summaries, and edge cases.

The shared integration fixtures are the test workshop. They create fake analytics and model servers, fake login data, temporary config files, cached model lists, canned streaming replies, and saved conversation history on disk. The test harness then launches a real app-server process as a child program and talks to it through JSON-RPC, a structured message protocol.

Finally, the suite index files gather everything into one large test binary and organize tests by feature area, including the larger version-2 API suite.

## Files in this stage

### Unit test entry points
These focused crate-level tests validate CLI parsing, configuration services, tracing, and core request-processor behaviors before the broader integration harness comes into play.

### `app-server/src/config/external_agent_config_tests.rs`

`test` · `test`

This test module builds temporary filesystem layouts that mimic external-agent home directories, repositories, plugin marketplaces, and Codex config targets. The helpers `fixture_paths` and `service_for_paths` standardize creation of isolated roots and a deterministic `ExternalAgentConfigService::new_for_test`, while `import_success` and `assert_single_plugin_raw_error` make result assertions concise.

The tests are broad and concrete. Detection tests verify which `ExternalAgentConfigMigrationItem`s appear for home vs repo scope, including config, skills, `AGENTS.md`, recent sessions, MCP servers, hooks, commands, subagents, and plugins. Import tests verify actual on-disk outputs: merged `config.toml`, generated `hooks.json`, converted command skills, migrated subagent TOML, rewritten markdown branding, and plugin enablement in Codex config. Many edge cases are pinned: invalid home config should not suppress non-plugin repo migrations; invalid local settings are ignored; existing non-empty targets are preserved while empty targets are overwritten; MCP migration respects home/local toggle precedence; plugin detection filters against already configured or unavailable marketplace plugins; relative marketplace paths resolve correctly in both home and repo scopes; and remote plugin imports become pending rather than immediate.

Because the production file contains many conditional branches and merge rules, these tests are effectively the behavioral contract for migration semantics, especially around preserving existing user state and distinguishing local vs remote plugin sources.

#### Function details

##### `fixture_paths`  (lines 14–19)

```
fn fixture_paths() -> (TempDir, PathBuf, PathBuf)
```

**Purpose**: Creates a temporary root plus conventional external-agent and Codex home paths beneath it. It is the base filesystem fixture for many tests.

**Data flow**: Allocates a `TempDir`, derives `<root>/.claude` and `<root>/.codex`, and returns `(TempDir, external_agent_home, codex_home)`.

**Call relations**: Used by many tests that need isolated home-scope migration fixtures.

*Call graph*: called by 23 (detect_home_infers_external_official_marketplace_when_missing_from_settings, detect_home_lists_config_skills_and_agents_md, detect_home_lists_enabled_plugins_from_settings, detect_home_lists_recent_sessions, detect_home_plugins_uses_local_settings_over_project_settings, detect_home_skips_config_when_target_already_has_supported_fields, detect_home_skips_plugins_with_invalid_marketplace_source, detect_home_skips_plugins_without_marketplace_source, detect_home_skips_skills_when_all_skill_directories_exist, detect_home_supports_relative_external_agent_plugin_marketplace_path (+13 more)); 1 external calls (new).


##### `service_for_paths`  (lines 21–26)

```
fn service_for_paths(
    external_agent_home: PathBuf,
    codex_home: PathBuf,
) -> ExternalAgentConfigService
```

**Purpose**: Builds a test-configured `ExternalAgentConfigService` for explicit external-agent and Codex home paths. It hides the `new_for_test` constructor.

**Data flow**: Takes `external_agent_home` and `codex_home` paths → returns `ExternalAgentConfigService::new_for_test(codex_home, external_agent_home)`.

**Call relations**: Used by nearly every test in this module.

*Call graph*: calls 1 internal fn (new_for_test); called by 46 (detect_home_infers_external_official_marketplace_when_missing_from_settings, detect_home_lists_config_skills_and_agents_md, detect_home_lists_enabled_plugins_from_settings, detect_home_lists_recent_sessions, detect_home_plugins_uses_local_settings_over_project_settings, detect_home_skips_config_when_target_already_has_supported_fields, detect_home_skips_plugins_with_invalid_marketplace_source, detect_home_skips_plugins_without_marketplace_source, detect_home_skips_skills_when_all_skill_directories_exist, detect_home_supports_relative_external_agent_plugin_marketplace_path (+15 more)).


##### `github_plugin_details`  (lines 28–36)

```
fn github_plugin_details() -> MigrationDetails
```

**Purpose**: Provides a reusable `MigrationDetails` fixture containing one plugin in one marketplace. It simplifies plugin-import tests.

**Data flow**: Constructs `MigrationDetails { plugins: vec![PluginsMigration { marketplace_name: "acme-tools", plugin_names: ["formatter"] }], ..Default::default() }` and returns it.

**Call relations**: Used by plugin-import tests that need a simple details payload.

*Call graph*: called by 1 (import_plugins_defers_marketplace_source_validation_to_add_marketplace); 2 external calls (default, vec!).


##### `assert_single_plugin_raw_error`  (lines 38–54)

```
fn assert_single_plugin_raw_error(
    raw_errors: &[ExternalAgentConfigImportRawError],
    failure_stage: &str,
    source: &str,
)
```

**Purpose**: Asserts that a plugin import outcome contains exactly one raw error with the expected failure stage and source plugin ID. It centralizes repetitive plugin-error checks.

**Data flow**: Takes a slice of raw errors, expected failure stage, and expected source → asserts length 1 and checks item type, failure stage, absent error type/cwd, matching source, and non-empty message.

**Call relations**: Used by several plugin-import failure tests.

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

**Purpose**: Builds an `ExternalAgentConfigImportSuccess` value for concise expected-result assertions. It fills in source and target strings from generic inputs.

**Data flow**: Takes item type, optional cwd, source, and target → converts source/target with `Into<String>` and returns the success struct.

**Call relations**: Used in expected `item_results` assertions across import tests.

*Call graph*: 1 external calls (into).


##### `detect_home_lists_config_skills_and_agents_md`  (lines 71–131)

```
async fn detect_home_lists_config_skills_and_agents_md()
```

**Purpose**: Verifies that home-scope detection reports config, skills, and `AgentsMd` migrations when corresponding source artifacts exist and targets are absent.

**Data flow**: Creates home settings, one skill directory, and `CLAUDE.md`, runs `detect(include_home: true)`, and asserts the exact ordered migration items.

**Call relations**: Exercises `ExternalAgentConfigService::detect` for basic home-scope discovery.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 5 external calls (assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_home_lists_recent_sessions`  (lines 134–184)

```
async fn detect_home_lists_recent_sessions()
```

**Purpose**: Verifies that home-scope detection reports recent external-agent sessions under the projects directory. It checks session metadata extraction.

**Data flow**: Creates a repo directory and a recent session JSONL file under `.claude/projects`, runs detection, and asserts a single `Sessions` migration item with the expected `ExternalAgentSessionMigration`.

**Call relations**: Exercises the sessions branch of home-scope detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 5 external calls (assert_eq!, now, create_dir_all, write, json!).


##### `detect_repo_lists_agents_md_for_each_cwd`  (lines 187–234)

```
async fn detect_repo_lists_agents_md_for_each_cwd()
```

**Purpose**: Verifies that repo-scoped detection resolves nested cwd values to the same repo root and emits an `AgentsMd` migration item for each supplied cwd. It confirms there is no deduplication across input cwd entries.

**Data flow**: Creates a git repo with nested child directory and root `CLAUDE.md`, runs detection with both nested and root cwd values, and asserts two identical `AgentsMd` items differing only by cloned cwd ownership.

**Call relations**: Exercises repo-root resolution and per-cwd iteration in `detect`.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_still_reports_non_plugin_items_when_home_config_is_invalid`  (lines 237–325)

```
async fn detect_repo_still_reports_non_plugin_items_when_home_config_is_invalid()
```

**Purpose**: Verifies that invalid Codex home config does not suppress non-plugin repo migration detection. Plugin detection may be skipped, but config/skills/agents markdown should still be reported.

**Data flow**: Creates a repo with settings, skills, and `CLAUDE.md`, writes invalid TOML to Codex home config, runs repo detection, and asserts config, skills, and `AgentsMd` items are still returned.

**Call relations**: Covers the warning-and-continue behavior around plugin detection in `detect_migrations`.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_lists_mcp_hooks_commands_and_subagents`  (lines 328–447)

```
async fn detect_repo_lists_mcp_hooks_commands_and_subagents()
```

**Purpose**: Verifies repo detection of MCP servers, hooks, commands, and subagents from representative source files. It checks that `MigrationDetails` include the expected named items.

**Data flow**: Creates a git repo with `.mcp.json`, hook settings, command markdown, and agent markdown, runs detection, and asserts the four expected migration items and names.

**Call relations**: Exercises multiple repo-scoped detection branches together.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_skips_hooks_when_only_unsupported_hooks_exist`  (lines 450–473)

```
async fn detect_repo_skips_hooks_when_only_unsupported_hooks_exist()
```

**Purpose**: Verifies that hook detection returns nothing when the source settings contain only unsupported hook forms/events. This prevents offering unusable migrations.

**Data flow**: Creates repo settings with unsupported hook definitions, runs detection, and asserts an empty migration-item list.

**Call relations**: Exercises hook filtering behavior in detection.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_repo_migrates_mcp_hooks_commands_and_subagents`  (lines 476–671)

```
async fn import_repo_migrates_mcp_hooks_commands_and_subagents()
```

**Purpose**: End-to-end test that repo import writes supported MCP config, hooks, command skill, and subagent TOML with expected transformations. It validates actual file contents and downstream parseability.

**Data flow**: Creates repo source files for MCP, hooks, commands, and agents, runs `import` with four migration items, then reads generated `.codex/config.toml`, `.codex/hooks.json`, `.agents/skills/.../SKILL.md`, and `.codex/agents/researcher.toml` and asserts exact contents and successful parsing into supported config types.

**Call relations**: Exercises several import helpers together and validates their on-disk outputs.

*Call graph*: calls 1 internal fn (service_for_paths); 11 external calls (new, assert!, assert_eq!, format!, create_dir_all, read_to_string, write, from_str, from_value, from_str (+1 more)).


##### `import_repo_mcp_preserves_existing_same_named_server`  (lines 674–734)

```
async fn import_repo_mcp_preserves_existing_same_named_server()
```

**Purpose**: Verifies that importing MCP config does not overwrite an existing same-named server in Codex config. Detection should also skip such already-present servers.

**Data flow**: Creates repo `.mcp.json` and existing `.codex/config.toml` with the same server name, runs detection and import, and asserts detection returns no items and the existing config file remains unchanged.

**Call relations**: Tests `merge_missing_mcp_servers` behavior through both detection and import.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_mcp_lists_only_missing_servers`  (lines 737–789)

```
async fn detect_repo_mcp_lists_only_missing_servers()
```

**Purpose**: Verifies that MCP detection reports only server names absent from existing Codex config. Existing same-named servers are filtered out.

**Data flow**: Creates repo `.mcp.json` with two servers and existing config containing one of them, runs detection, and asserts only the missing server appears in `MigrationDetails`.

**Call relations**: Exercises MCP detection’s merge-preview logic.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_home_migrates_supported_config_fields_skills_and_agents_md`  (lines 792–873)

```
async fn import_home_migrates_supported_config_fields_skills_and_agents_md()
```

**Purpose**: Verifies home import of supported config fields, skill copying with markdown rewriting, and `AGENTS.md` rewriting. It checks the main happy path for home-scope migration.

**Data flow**: Creates home settings with env and sandbox fields, one skill `SKILL.md`, and `CLAUDE.md`, runs import for `AgentsMd`, `Config`, and `Skills`, then reads generated files and asserts exact rewritten contents and TOML structure.

**Call relations**: Exercises `import_agents_md`, `import_config`, and `import_skills` together.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 7 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_home_config_uses_local_settings_over_project_settings`  (lines 876–918)

```
async fn import_home_config_uses_local_settings_over_project_settings()
```

**Purpose**: Verifies that `settings.local.json` overrides and augments `settings.json` during config import. It checks recursive merge semantics for env and sandbox fields.

**Data flow**: Creates base and local settings files, runs config import, reads generated `config.toml`, parses it, and asserts local values override base ones while base-only keys remain.

**Call relations**: Exercises `effective_external_settings` through `import_config`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 6 external calls (assert_eq!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_home_config_ignores_invalid_local_settings`  (lines 921–949)

```
async fn import_home_config_ignores_invalid_local_settings()
```

**Purpose**: Verifies that invalid local settings JSON is ignored rather than failing config import. The base settings should still migrate successfully.

**Data flow**: Creates valid `settings.json` and invalid `settings.local.json`, runs config import, and asserts the resulting `config.toml` reflects only the base settings.

**Call relations**: Tests the invalid-local-settings branch in `effective_external_settings`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 4 external calls (assert_eq!, create_dir_all, write, vec!).


##### `import_home_skips_empty_config_migration`  (lines 952–984)

```
async fn import_home_skips_empty_config_migration()
```

**Purpose**: Verifies that config import records no successes and writes no file when the migrated config would be empty. Unsupported or irrelevant settings should not create a no-op `config.toml`.

**Data flow**: Creates settings that produce no supported migrated fields, runs config import, asserts the returned `item_results` show zero successes/errors, and checks that `config.toml` does not exist.

**Call relations**: Exercises the empty-migration branch of `import_config` through `import`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 6 external calls (assert!, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_local_plugins_returns_completed_status`  (lines 987–1073)

```
async fn import_local_plugins_returns_completed_status()
```

**Purpose**: Verifies that plugins from a local marketplace source are imported immediately and reported as completed, with Codex config updated to enable the plugin.

**Data flow**: Creates a local marketplace layout and settings enabling one plugin, runs `import` with a `Plugins` migration item, asserts no pending plugin imports, checks the item result contains one success, and verifies `config.toml` contains the enabled plugin stanza.

**Call relations**: Exercises local plugin partitioning and `import_plugins` through the public `import` API.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 8 external calls (assert!, assert_eq!, create_dir_all, read_to_string, write, json!, to_string_pretty, vec!).


##### `import_git_plugins_returns_pending_async_status`  (lines 1076–1137)

```
async fn import_git_plugins_returns_pending_async_status()
```

**Purpose**: Verifies that plugins from a remote/git marketplace source are not imported immediately but instead returned as `pending_plugin_imports`. The item result should remain empty rather than failed.

**Data flow**: Creates settings with a remote marketplace source, runs `import` with a `Plugins` migration item, and asserts one pending plugin import, zero item successes/errors, and no config file written.

**Call relations**: Exercises `partition_plugin_migration_details` and the deferred-plugin behavior in `import`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 5 external calls (assert!, assert_eq!, create_dir_all, write, vec!).


##### `detect_home_skips_config_when_target_already_has_supported_fields`  (lines 1140–1172)

```
async fn detect_home_skips_config_when_target_already_has_supported_fields()
```

**Purpose**: Verifies that config detection returns nothing when existing Codex config already contains all migratable fields from external settings. Detection should only report missing values.

**Data flow**: Creates home settings and a matching existing `config.toml`, runs detection, and asserts an empty item list.

**Call relations**: Exercises `merge_missing_toml_values` preview logic in detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_skips_skills_when_all_skill_directories_exist`  (lines 1175–1193)

```
async fn detect_home_skips_skills_when_all_skill_directories_exist()
```

**Purpose**: Verifies that skills detection returns nothing when every source skill directory already exists in the target skills directory.

**Data flow**: Creates matching source and target skill directories, runs detection, and asserts no migration items.

**Call relations**: Exercises `count_missing_subdirectories` through home-scope detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 2 external calls (assert_eq!, create_dir_all).


##### `import_repo_agents_md_rewrites_terms_and_skips_non_empty_targets`  (lines 1196–1281)

```
async fn import_repo_agents_md_rewrites_terms_and_skips_non_empty_targets()
```

**Purpose**: Verifies that repo `AgentsMd` import rewrites external-agent branding terms and skips repos whose target `AGENTS.md` is already non-empty. It checks both copy and preserve behaviors in one test.

**Data flow**: Creates two repos, one with only source markdown and one with both source and non-empty target, runs import for both, asserts per-item results, and checks the copied file is rewritten while the existing target remains unchanged.

**Call relations**: Exercises `import_agents_md` behavior for non-empty targets and text rewriting.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_repo_agents_md_overwrites_empty_targets`  (lines 1284–1332)

```
async fn import_repo_agents_md_overwrites_empty_targets()
```

**Purpose**: Verifies that repo `AgentsMd` import treats whitespace-only targets as empty and overwrites them. This distinguishes empty from non-empty preservation behavior.

**Data flow**: Creates repo source markdown and whitespace-only target `AGENTS.md`, runs import, asserts one success result, and checks the target now contains rewritten content.

**Call relations**: Exercises `is_missing_or_empty_text_file` through `import_agents_md`.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_prefers_non_empty_external_agent_agents_source`  (lines 1335–1376)

```
async fn detect_repo_prefers_non_empty_external_agent_agents_source()
```

**Purpose**: Verifies that repo detection prefers `.claude/CLAUDE.md` when the root `CLAUDE.md` exists but is empty. Source selection should favor the first non-empty candidate.

**Data flow**: Creates an empty root `CLAUDE.md` and a non-empty `.claude/CLAUDE.md`, runs detection, and asserts the migration item points at the non-empty source.

**Call relations**: Exercises `find_repo_agents_md_source` through detection.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_repo_hooks_preserves_disabled_codex_hooks_feature`  (lines 1379–1447)

```
async fn import_repo_hooks_preserves_disabled_codex_hooks_feature()
```

**Purpose**: Verifies that importing hooks writes `hooks.json` without altering an existing Codex config that disables the hooks feature. Hook migration should not rewrite unrelated config.

**Data flow**: Creates repo hook settings and existing `.codex/config.toml` with `features.codex_hooks = false`, runs hook import, asserts one success result, checks config file unchanged, and verifies generated `hooks.json` contents.

**Call relations**: Exercises `import_hooks` while ensuring config preservation.

*Call graph*: calls 1 internal fn (service_for_paths); 7 external calls (new, assert_eq!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_repo_mcp_uses_home_settings_toggles_when_repo_settings_missing`  (lines 1450–1516)

```
async fn import_repo_mcp_uses_home_settings_toggles_when_repo_settings_missing()
```

**Purpose**: Verifies that repo MCP import falls back to home settings for enabled/disabled server toggles when repo settings are absent. This checks the `mcp_settings` fallback path.

**Data flow**: Creates repo project MCP config outside repo settings plus home settings disabling one server, runs MCP import, asserts one success result, reads generated config, and checks only the allowed server was migrated.

**Call relations**: Exercises `mcp_settings` fallback behavior through `import_mcp_server_config`.

*Call graph*: calls 1 internal fn (service_for_paths); 8 external calls (new, assert_eq!, create_dir_all, read_to_string, write, json!, from_str, vec!).


##### `import_repo_mcp_uses_local_settings_toggles_over_project_settings`  (lines 1519–1577)

```
async fn import_repo_mcp_uses_local_settings_toggles_over_project_settings()
```

**Purpose**: Verifies that repo-local settings override repo project settings for MCP enabled/disabled server toggles. It checks precedence between `settings.json` and `settings.local.json`.

**Data flow**: Creates repo `.mcp.json`, repo `settings.json`, and repo `settings.local.json` with conflicting toggles, runs MCP import, reads generated config, and asserts only the locally enabled/non-disabled server remains.

**Call relations**: Exercises `effective_external_settings` and MCP migration together.

*Call graph*: calls 1 internal fn (service_for_paths); 7 external calls (new, assert_eq!, create_dir_all, read_to_string, write, from_str, vec!).


##### `import_repo_mcp_ignores_invalid_home_settings_when_repo_settings_missing`  (lines 1580–1625)

```
async fn import_repo_mcp_ignores_invalid_home_settings_when_repo_settings_missing()
```

**Purpose**: Verifies that invalid home settings are ignored when repo MCP import falls back to home settings due to missing repo settings. MCP migration should still proceed from project config.

**Data flow**: Creates repo project MCP config and invalid home settings, runs MCP import, reads generated config, and asserts the expected server was migrated.

**Call relations**: Exercises the warning-and-ignore branch in `mcp_settings`.

*Call graph*: calls 1 internal fn (service_for_paths); 8 external calls (new, assert_eq!, create_dir_all, read_to_string, write, json!, from_str, vec!).


##### `import_repo_uses_non_empty_external_agent_agents_source`  (lines 1628–1659)

```
async fn import_repo_uses_non_empty_external_agent_agents_source()
```

**Purpose**: Verifies that repo `AgentsMd` import uses `.claude/CLAUDE.md` when the root source exists but is empty. It is the import counterpart to the detection preference test.

**Data flow**: Creates empty root source and non-empty `.claude/CLAUDE.md`, runs import, and asserts the generated `AGENTS.md` contains rewritten content from the non-empty source.

**Call relations**: Exercises `find_repo_agents_md_source` through `import_agents_md`.

*Call graph*: calls 1 internal fn (service_for_paths); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `import_continues_after_failed_migration_item`  (lines 1662–1693)

```
async fn import_continues_after_failed_migration_item()
```

**Purpose**: Verifies that a failed plugin migration item does not abort later items in the same batch. This is a key batch-import resilience rule.

**Data flow**: Creates a repo with source markdown, runs `import` with an invalid `Plugins` item followed by a valid `AgentsMd` item, and asserts the target `AGENTS.md` was still written.

**Call relations**: Exercises the plugin-specific continue-on-error behavior in `ExternalAgentConfigService::import`.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `migration_metric_tags_for_skills_include_skills_count`  (lines 1696–1704)

```
fn migration_metric_tags_for_skills_include_skills_count()
```

**Purpose**: Verifies that migration metric tags include `skills_count` for `Skills` items. It locks down metric tagging semantics.

**Data flow**: Calls `migration_metric_tags(ExternalAgentConfigMigrationItemType::Skills, Some(3))` and asserts the exact returned tag vector.

**Call relations**: Directly tests the metrics helper.

*Call graph*: 1 external calls (assert_eq!).


##### `detect_home_lists_enabled_plugins_from_settings`  (lines 1707–1753)

```
async fn detect_home_lists_enabled_plugins_from_settings()
```

**Purpose**: Verifies that home plugin detection groups enabled plugins by marketplace and ignores disabled ones. It checks the basic plugin-detection happy path.

**Data flow**: Creates home settings with two enabled plugins and one disabled plugin, runs detection, and asserts a single `Plugins` migration item with sorted plugin names.

**Call relations**: Exercises `detect_plugin_migration` and `extract_plugin_migration_details` through home detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_plugins_uses_local_settings_over_project_settings`  (lines 1756–1811)

```
async fn detect_home_plugins_uses_local_settings_over_project_settings()
```

**Purpose**: Verifies that local settings override plugin enablement from base settings during detection. Disabled and newly enabled plugins should reflect the merged effective settings.

**Data flow**: Creates base and local settings with conflicting plugin booleans, runs detection, and asserts the resulting plugin migration item contains the merged enabled set.

**Call relations**: Exercises `effective_external_settings` in plugin detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_repo_skips_plugins_that_are_already_configured_in_codex`  (lines 1814–1875)

```
async fn detect_repo_skips_plugins_that_are_already_configured_in_codex()
```

**Purpose**: Verifies that repo plugin detection excludes plugins already explicitly enabled in Codex home config while still reporting other enabled external-agent plugins.

**Data flow**: Creates repo plugin settings and Codex home config enabling one of them, runs detection, and asserts only the other plugin remains in the migration item.

**Call relations**: Exercises configured-plugin filtering in `extract_plugin_migration_details`.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_skips_plugins_that_are_disabled_in_codex`  (lines 1878–1918)

```
async fn detect_repo_skips_plugins_that_are_disabled_in_codex()
```

**Purpose**: Verifies that repo plugin detection also suppresses plugins explicitly disabled in Codex config. Any explicit Codex plugin entry counts as already configured.

**Data flow**: Creates repo plugin settings and Codex home config with the plugin disabled, runs detection, and asserts no migration items.

**Call relations**: Tests another configured-plugin filtering case.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_repo_skips_plugins_without_explicit_enabled_in_codex`  (lines 1921–1960)

```
async fn detect_repo_skips_plugins_without_explicit_enabled_in_codex()
```

**Purpose**: Verifies that repo plugin detection suppresses plugins that already have a Codex config entry even if `enabled` is omitted. Presence of the plugin key alone is treated as configured.

**Data flow**: Creates repo plugin settings and Codex home config with an empty plugin table, runs detection, and asserts no migration items.

**Call relations**: Covers the implicit-configured case in plugin filtering.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_requires_details`  (lines 1963–1973)

```
async fn import_plugins_requires_details()
```

**Purpose**: Verifies that `import_plugins` rejects missing migration details with an `InvalidData` error. Plugin import cannot proceed without explicit plugin groups.

**Data flow**: Calls `import_plugins(None, None)` on a test service, expects an error, and asserts its kind and message.

**Call relations**: Directly tests the validation guard in `ExternalAgentConfigService::import_plugins`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 1 external calls (assert_eq!).


##### `detect_repo_does_not_skip_plugins_only_configured_in_project_codex`  (lines 1976–2037)

```
async fn detect_repo_does_not_skip_plugins_only_configured_in_project_codex()
```

**Purpose**: Verifies that repo plugin detection only consults Codex home config, not repo-local `.codex/config.toml`, when deciding whether a plugin is already configured. Project-local config should not suppress migration suggestions.

**Data flow**: Creates repo plugin settings, repo-local Codex config enabling the plugin, and empty Codex home config, runs detection, and asserts the plugin is still reported.

**Call relations**: Exercises the scope choice in plugin detection.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `detect_home_skips_plugins_without_marketplace_source`  (lines 2040–2062)

```
async fn detect_home_skips_plugins_without_marketplace_source()
```

**Purpose**: Verifies that plugin detection returns nothing when enabled plugins reference a marketplace with no known source. Such plugins are not migratable.

**Data flow**: Creates home settings with an enabled plugin but no `extraKnownMarketplaces`, runs detection, and asserts no items.

**Call relations**: Exercises marketplace-source filtering in plugin detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_skips_plugins_with_invalid_marketplace_source`  (lines 2065–2092)

```
async fn detect_home_skips_plugins_with_invalid_marketplace_source()
```

**Purpose**: Verifies that plugin detection skips plugins whose marketplace source is invalid/unloadable. Detection should not offer migrations it cannot resolve.

**Data flow**: Creates home settings with an enabled plugin and an invalid marketplace source, runs detection, and asserts no items.

**Call relations**: Exercises source validation in plugin detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_repo_filters_plugins_against_installed_marketplace`  (lines 2095–2221)

```
async fn detect_repo_filters_plugins_against_installed_marketplace()
```

**Purpose**: Verifies that repo plugin detection filters enabled plugins against the set of installable plugins exposed by an already configured marketplace, excluding unavailable or missing plugins. It checks integration with marketplace metadata.

**Data flow**: Creates repo plugin settings, Codex home marketplace config, and a marketplace manifest where one plugin is `NOT_AVAILABLE`, one is available, and one is missing, runs detection, and asserts only the available plugin is reported.

**Call relations**: Exercises `configured_marketplace_plugins` and plugin filtering together.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_requires_source_marketplace_details`  (lines 2224–2269)

```
async fn import_plugins_requires_source_marketplace_details()
```

**Purpose**: Verifies that plugin import records marketplace/plugin failures when the requested marketplace is absent from source settings. It checks graceful failure reporting rather than hard abort.

**Data flow**: Creates settings for one marketplace but requests import details for another, runs `import_plugins`, and asserts failed marketplace/plugin IDs plus one raw error.

**Call relations**: Exercises the missing-import-source branch in `import_plugins`.

*Call graph*: calls 3 internal fn (assert_single_plugin_raw_error, fixture_paths, service_for_paths); 5 external calls (default, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_defers_marketplace_source_validation_to_add_marketplace`  (lines 2272–2304)

```
async fn import_plugins_defers_marketplace_source_validation_to_add_marketplace()
```

**Purpose**: Verifies that plugin import passes marketplace source validation through to `add_marketplace` rather than rejecting it earlier. A bad local path should surface as an import failure outcome.

**Data flow**: Creates settings with a relative local marketplace path that does not exist, runs `import_plugins` with matching details, and asserts failed marketplace/plugin IDs plus one raw error.

**Call relations**: Exercises the marketplace-install failure branch in `import_plugins`.

*Call graph*: calls 4 internal fn (assert_single_plugin_raw_error, fixture_paths, github_plugin_details, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `import_plugins_supports_external_agent_plugin_marketplace_layout`  (lines 2307–2380)

```
async fn import_plugins_supports_external_agent_plugin_marketplace_layout()
```

**Purpose**: Verifies direct plugin import from an external-agent-style local marketplace layout. Successful import should add the marketplace, install the plugin, and enable it in Codex config.

**Data flow**: Creates a local marketplace manifest and plugin manifest under the external-agent layout, runs `import_plugins`, asserts the exact successful `PluginImportOutcome`, and checks `config.toml` contains the enabled plugin stanza.

**Call relations**: Exercises the happy path of `import_plugins` for local marketplaces.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 9 external calls (default, assert!, assert_eq!, create_dir_all, read_to_string, write, json!, to_string_pretty, vec!).


##### `detect_home_supports_relative_external_agent_plugin_marketplace_path`  (lines 2383–2454)

```
async fn detect_home_supports_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Verifies that home plugin detection resolves relative marketplace paths in settings and still reports the plugin migration item. It checks source-root-relative path handling.

**Data flow**: Creates a relative-path local marketplace under external-agent home, writes settings using `./my-marketplace`, runs detection, and asserts the plugin migration item is returned.

**Call relations**: Exercises `resolve_external_marketplace_source` through home plugin detection.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 3 external calls (assert_eq!, create_dir_all, write).


##### `detect_home_infers_external_official_marketplace_when_missing_from_settings`  (lines 2457–2500)

```
async fn detect_home_infers_external_official_marketplace_when_missing_from_settings()
```

**Purpose**: Verifies that detection infers the official external marketplace source when an enabled plugin references it but settings omit an explicit marketplace definition.

**Data flow**: Creates settings enabling one plugin in the official marketplace without `extraKnownMarketplaces`, runs detection, and asserts the plugin migration item is still produced.

**Call relations**: Exercises official-marketplace inference in `collect_marketplace_import_sources`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 4 external calls (assert_eq!, format!, create_dir_all, write).


##### `import_plugins_supports_relative_external_agent_plugin_marketplace_path`  (lines 2503–2575)

```
async fn import_plugins_supports_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Verifies direct plugin import from a home-scoped relative local marketplace path. It is the import counterpart to the relative-path detection test.

**Data flow**: Creates a relative-path local marketplace under external-agent home, runs `import_plugins`, asserts successful outcome, and checks Codex config enables the plugin.

**Call relations**: Exercises relative-path resolution in `import_plugins`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 7 external calls (default, assert!, assert_eq!, create_dir_all, read_to_string, write, vec!).


##### `import_plugins_infers_external_official_marketplace_when_missing_from_settings`  (lines 2578–2624)

```
async fn import_plugins_infers_external_official_marketplace_when_missing_from_settings()
```

**Purpose**: Verifies that plugin import can infer the official marketplace source from enabled plugin IDs even when settings omit marketplace details. Marketplace addition may succeed while plugin installation still fails if the plugin is unavailable.

**Data flow**: Creates settings enabling one official-marketplace plugin with no explicit marketplace source, runs `import_plugins`, and asserts marketplace success, plugin failure, and one raw error for the plugin ID.

**Call relations**: Exercises official-marketplace inference through `import_plugins`.

*Call graph*: calls 3 internal fn (assert_single_plugin_raw_error, fixture_paths, service_for_paths); 6 external calls (default, assert_eq!, format!, create_dir_all, write, vec!).


##### `detect_repo_supports_project_relative_external_agent_plugin_marketplace_path`  (lines 2627–2706)

```
async fn detect_repo_supports_project_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Verifies that repo plugin detection resolves relative marketplace paths against the repo root rather than the external-agent home. This is the repo-scoped counterpart to the home relative-path test.

**Data flow**: Creates a repo-local marketplace and repo `.claude/settings.json` using `./my-marketplace`, runs detection, and asserts the plugin migration item is returned.

**Call relations**: Exercises repo-root-relative source resolution in plugin detection.

*Call graph*: calls 1 internal fn (service_for_paths); 5 external calls (new, assert_eq!, create_dir_all, write, vec!).


##### `import_plugins_supports_project_relative_external_agent_plugin_marketplace_path`  (lines 2709–2786)

```
async fn import_plugins_supports_project_relative_external_agent_plugin_marketplace_path()
```

**Purpose**: Verifies direct plugin import from a repo-scoped relative local marketplace path. Successful import should resolve the path against the repo root and enable the plugin.

**Data flow**: Creates a repo-local marketplace and settings, runs `import_plugins(Some(repo_root), ...)`, asserts successful outcome, and checks Codex config enables the plugin.

**Call relations**: Exercises repo-root-relative source resolution in `import_plugins`.

*Call graph*: calls 1 internal fn (service_for_paths); 8 external calls (default, new, assert!, assert_eq!, create_dir_all, read_to_string, write, vec!).


##### `import_skills_returns_only_new_skill_directory_names`  (lines 2789–2806)

```
fn import_skills_returns_only_new_skill_directory_names()
```

**Purpose**: Verifies that `import_skills` copies only missing skill directories and returns only the names of newly copied directories. Existing targets are skipped silently.

**Data flow**: Creates two source skill directories and one matching existing target directory, calls `import_skills(None)`, and asserts only the missing skill name is returned.

**Call relations**: Directly tests the selective-copy behavior of `ExternalAgentConfigService::import_skills`.

*Call graph*: calls 2 internal fn (fixture_paths, service_for_paths); 2 external calls (assert_eq!, create_dir_all).


### `app-server/src/config_manager_service_tests.rs`

`test` · `test execution`

This file is the regression suite for `config_manager_service.rs`. It builds temporary config directories and test `ConfigManager` instances, then drives the public read/write APIs with realistic protocol payloads. Several tests verify persistence details that are easy to break when editing TOML structurally: nested tables are emitted as explicit `toml_edit::Table`s, comments and key order survive writes, clearing a missing nested path is a no-op, and `Upsert` merges table contents while `Replace` overwrites them.

A large portion of the suite codifies validation and policy invariants. Writes to legacy `profile` and `profiles.*` keys are rejected for both single and batch writes; invalid user values are rejected even when a managed layer would override them; reserved built-in provider IDs cannot be overridden; and enterprise feature requirements can veto writes. Other tests cover optimistic concurrency (`expected_version` mismatch), defaulting writes to the active user config path when `file_path` is omitted, and preserving the selected profile-specific user config path even after a load failure.

Layering behavior is checked from both read and write sides. Reads must report origins and ordered layers correctly, including managed/session/user precedence. Writes may return `OkOverridden` plus metadata when a managed layer shadows the edited user value. The suite also verifies nested app and MCP-server paths deserialize back into the protocol config shape.

#### Function details

##### `toml_value_to_item_handles_nested_config_tables`  (lines 15–61)

```
fn toml_value_to_item_handles_nested_config_tables()
```

**Purpose**: Verifies that converting nested TOML config into `toml_edit::Item` produces explicit nested tables rather than collapsing structure. It specifically checks `mcp_servers.docs.http_headers` layout and scalar values.

**Data flow**: Builds a TOML string, parses it into `TomlValue`, converts it with `toml_value_to_item`, then inspects the resulting root, `mcp_servers`, `docs`, and `http_headers` tables and asserts explicitness and expected string values.

**Call relations**: This is a focused unit test for the conversion helper used during persistence, guarding the table-shape assumptions relied on by write-path edit generation.

*Call graph*: 3 external calls (assert!, assert_eq!, from_str).


##### `write_value_preserves_comments_and_order`  (lines 64–106)

```
async fn write_value_preserves_comments_and_order() -> Result<()>
```

**Purpose**: Checks that adding a new nested config key updates the file without disturbing existing comments or top-level/table ordering. It protects the comment-preserving behavior of `ConfigEditsBuilder` plus the helper conversions.

**Data flow**: Creates a temp `config.toml` with comments and sections, constructs a test `ConfigManager`, performs `write_value` for `features.personality = true`, reads the file back from disk, and compares the full text to the expected commented TOML.

**Call relations**: Exercises the full write pipeline through `ConfigManager::write_value`, with assertions aimed at persistence fidelity rather than just semantic config equality.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert_eq!, json!, read_to_string, write, tempdir).


##### `clear_missing_nested_config_is_noop`  (lines 109–130)

```
async fn clear_missing_nested_config_is_noop() -> Result<()>
```

**Purpose**: Ensures clearing a nonexistent nested path succeeds without modifying the file or reporting an override. This codifies the no-op semantics of `clear_path` on missing parents.

**Data flow**: Creates an empty temp config file, calls `write_value` with `features.personality = null`, captures the response, and asserts `WriteStatus::Ok`, `overridden_metadata == None`, and unchanged empty file contents.

**Call relations**: Covers the deletion branch of the write path and indirectly validates that no persistence occurs when no effective change is detected.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 3 external calls (assert_eq!, write, tempdir).


##### `write_value_rejects_legacy_profile_selector`  (lines 133–162)

```
async fn write_value_rejects_legacy_profile_selector() -> Result<()>
```

**Purpose**: Confirms that writing the legacy top-level `profile` selector is rejected as a validation error. This preserves the migration away from profile selection inside config contents.

**Data flow**: Writes a baseline config file, invokes `write_value` with `key_path = "profile"` and a string value, captures the error, asserts the returned write error code and message substring, and verifies the file remains unchanged.

**Call relations**: Exercises the explicit legacy-key rejection branch inside `ConfigManager::apply_edits` for single-value writes.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, assert_eq!, json!, write, tempdir).


##### `write_value_rejects_legacy_profile_table`  (lines 165–194)

```
async fn write_value_rejects_legacy_profile_table() -> Result<()>
```

**Purpose**: Confirms that writes under `profiles.*` are rejected as legacy profile-table mutations. It ensures nested legacy profile structures cannot be recreated through the API.

**Data flow**: Creates an empty config file, attempts to write `profiles.work.model`, asserts `ConfigValidationError` and an explanatory message, then checks that the file is still empty.

**Call relations**: Targets the second legacy-profile guard in `ConfigManager::apply_edits`, covering nested path rejection.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, assert_eq!, json!, write, tempdir).


##### `batch_write_rejects_legacy_profile_selector`  (lines 197–236)

```
async fn batch_write_rejects_legacy_profile_selector() -> Result<()>
```

**Purpose**: Verifies that batch writes fail atomically when any edit targets the legacy `profile` selector, even if earlier edits in the batch are otherwise valid. This protects against partial application.

**Data flow**: Creates a config file, submits a `ConfigBatchWriteParams` containing a valid `model` edit and an invalid `profile` edit, expects an error, asserts the validation code/message, and confirms the original file text is unchanged.

**Call relations**: Exercises the batch wrapper plus the shared validation path in `apply_edits`, specifically proving that invalid later edits prevent persistence of earlier ones.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, assert_eq!, write, tempdir, vec!).


##### `write_value_supports_nested_app_paths`  (lines 239–298)

```
async fn write_value_supports_nested_app_paths() -> Result<()>
```

**Purpose**: Checks that writes into the `apps` subtree can first create an app entry and then update a nested approval-mode field, and that the resulting config reads back into the typed `AppsConfig` protocol structure.

**Data flow**: Starts from an empty config file, writes a JSON object to `apps`, writes a string to `apps.app1.default_tools_approval_mode`, then calls `read` and asserts the returned `read.config.apps` equals the expected `AppsConfig`/`AppConfig` structure.

**Call relations**: Exercises nested path creation, schema validation, and read-side protocol conversion for the `apps` config domain.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, json!, write, tempdir).


##### `write_value_supports_custom_mcp_server_default_tool_approval_mode`  (lines 301–341)

```
async fn write_value_supports_custom_mcp_server_default_tool_approval_mode() -> Result<()>
```

**Purpose**: Verifies that nested writes under a custom MCP server table are persisted and visible in the read response’s `additional` JSON. This covers config fields that may not map to a dedicated strongly typed protocol field.

**Data flow**: Creates a config file with `[mcp_servers.docs]`, writes `mcp_servers.docs.default_tools_approval_mode = "approve"`, asserts the raw file contains the new line, then reads config and checks the nested JSON path under `additional`.

**Call relations**: Exercises nested table editing plus read-side passthrough of additional config content.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (assert!, assert_eq!, json!, read_to_string, write, tempdir).


##### `read_includes_origins_and_layers`  (lines 344–410)

```
async fn read_includes_origins_and_layers()
```

**Purpose**: Checks that a read with `include_layers = true` returns the effective config, origin metadata, and ordered layer list with managed config above user and system layers. It tolerates an optional top MDM layer on macOS hosts.

**Data flow**: Creates temp user and managed config files, builds a test manager with managed-config overrides, calls `read`, asserts the effective approval policy, inspects `origins["approval_policy"]`, normalizes away an optional MDM layer, and asserts the remaining layer ordering and source metadata.

**Call relations**: Exercises the read path’s origin/layer reporting rather than write behavior, validating how `ConfigLayerStack` is exposed through the protocol.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 6 external calls (assert!, assert_eq!, matches!, write, tempdir, vec!).


##### `write_value_succeeds_when_managed_preferences_expand_home_directory_paths`  (lines 414–458)

```
async fn write_value_succeeds_when_managed_preferences_expand_home_directory_paths() -> Result<()>
```

**Purpose**: On macOS, verifies that managed preferences containing `~`-based writable roots do not break unrelated user config writes. This guards a platform-specific interaction between managed config expansion and write validation.

**Data flow**: Builds loader overrides with base64-encoded managed preferences TOML containing `writable_roots = ["~/code"]`, writes `model = "updated"` through the service, and asserts success status plus updated file contents.

**Call relations**: Exercises the full write path under a managed-preferences environment that previously could interfere with config loading or validation.

*Call graph*: calls 3 internal fn (new_for_tests, default, with_managed_config_path_for_tests); 5 external calls (assert_eq!, json!, write, tempdir, vec!).


##### `write_value_reports_override`  (lines 461–514)

```
async fn write_value_reports_override()
```

**Purpose**: Checks a case where the user writes the same value that a managed layer already enforces, and confirms the write succeeds without override metadata. This distinguishes true shadowing from convergence with the effective value.

**Data flow**: Creates user and managed configs for `approval_policy`, performs a write setting the user value to `never`, reads config afterward to confirm the managed origin remains effective, and asserts the write response is `Ok` with `overridden_metadata == None`.

**Call relations**: Exercises the subtle branch in override computation where user and effective values match, so the response should not be marked overridden.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 6 external calls (assert!, assert_eq!, json!, write, tempdir, vec!).


##### `version_conflict_rejected`  (lines 517–538)

```
async fn version_conflict_rejected()
```

**Purpose**: Verifies optimistic concurrency enforcement by supplying a bogus `expected_version`. The service must reject the write with `ConfigVersionConflict` before mutating the file.

**Data flow**: Creates a user config file, calls `write_value` with `expected_version = Some("sha256:bogus")`, captures the error, and asserts the extracted write error code equals `ConfigVersionConflict`.

**Call relations**: Targets the version-check branch in `ConfigManager::apply_edits`.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (assert_eq!, json!, write, tempdir).


##### `write_value_defaults_to_user_config_path`  (lines 541–562)

```
async fn write_value_defaults_to_user_config_path()
```

**Purpose**: Ensures that omitting `file_path` causes writes to target the manager’s resolved default user config file. This is the normal convenience path for clients that do not specify a file explicitly.

**Data flow**: Creates an empty default `config.toml`, invokes `write_value` with `file_path: None`, then reads the default file from disk and asserts it contains the new `model` assignment.

**Call relations**: Exercises the path-defaulting logic in `apply_edits` when no explicit target path is provided.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (assert!, json!, read_to_string, write, tempdir).


##### `write_value_defaults_to_selected_user_config_path`  (lines 565–601)

```
async fn write_value_defaults_to_selected_user_config_path()
```

**Purpose**: Checks that when the manager is configured with a selected profile-specific user config path, omitted `file_path` writes go to that selected file rather than the main `config.toml`. It protects profile-v2 path selection behavior.

**Data flow**: Creates both main and selected config files, configures loader overrides with `user_config_path` and `user_config_profile`, performs a write with `file_path: None`, then asserts the selected file changed and the main file did not.

**Call relations**: Exercises the same default-path branch as the previous test, but under non-default selected-user-config state.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, from_absolute_path); 5 external calls (assert_eq!, json!, write, tempdir, vec!).


##### `load_default_config_preserves_selected_user_config_path_after_load_error`  (lines 604–636)

```
async fn load_default_config_preserves_selected_user_config_path_after_load_error()
```

**Purpose**: Verifies that a failed load of the selected user config does not erase the manager’s knowledge of which user config file is selected. This protects subsequent fallback/default loads from silently switching paths.

**Data flow**: Creates a valid main config and an invalid selected config, configures the manager to use the selected path, calls `load_latest_config` expecting an error, then calls `load_default_config` and asserts the resulting `config_layer_stack.get_user_config_file()` still points to the selected file.

**Call relations**: This test reaches beyond the service methods into `ConfigManager` state management, guarding path-selection persistence across load failures.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, from_absolute_path); 4 external calls (assert_eq!, write, tempdir, vec!).


##### `invalid_user_value_rejected_even_if_overridden_by_managed`  (lines 639–671)

```
async fn invalid_user_value_rejected_even_if_overridden_by_managed()
```

**Purpose**: Ensures user-layer validation happens before considering that a managed layer would override the same setting. Invalid user values must still be rejected and not persisted.

**Data flow**: Creates user and managed config files, attempts to write an invalid `approval_policy = "bogus"`, asserts `ConfigValidationError`, and verifies the user config file remains unchanged.

**Call relations**: Directly validates the design choice in `apply_edits` to validate the standalone user config before validating the effective merged config.

*Call graph*: calls 3 internal fn (new_for_tests, default, with_managed_config_path_for_tests); 6 external calls (assert_eq!, json!, read_to_string, write, tempdir, vec!).


##### `reserved_builtin_provider_override_rejected`  (lines 674–699)

```
async fn reserved_builtin_provider_override_rejected()
```

**Purpose**: Checks that writes attempting to redefine reserved built-in model provider IDs are rejected. This protects invariant provider identities such as `openai`.

**Data flow**: Creates a baseline config, attempts to write `model_providers.openai.name`, captures the error, asserts validation code and message fragments mentioning reserved built-in IDs and `openai`, and confirms the file is unchanged.

**Call relations**: Exercises schema/business-rule validation reached through `validate_config` and related config deserialization logic.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (assert!, assert_eq!, json!, read_to_string, write, tempdir).


##### `write_value_rejects_feature_requirement_conflict`  (lines 702–743)

```
async fn write_value_rejects_feature_requirement_conflict()
```

**Purpose**: Verifies that enterprise feature requirements loaded from cloud config can veto a user write that conflicts with required feature settings. This guards the post-deserialization requirement validation step.

**Data flow**: Creates an empty config, builds a manager with an enterprise requirement forcing `features.personality = true`, attempts to write `false`, asserts `ConfigValidationError` and an explanatory message, and checks the file remains empty.

**Call relations**: Exercises `validate_feature_requirements_for_config_toml` through the write path.

*Call graph*: calls 3 internal fn (new_for_tests, without_managed_config_for_tests, loader_with_enterprise_requirement); 6 external calls (assert!, assert_eq!, json!, write, tempdir, vec!).


##### `read_reports_managed_overrides_user_and_session_flags`  (lines 746–806)

```
async fn read_reports_managed_overrides_user_and_session_flags()
```

**Purpose**: Checks that read-side origin reporting correctly attributes the effective value to managed config even when both session flags and user config also set the same key. It also verifies layer ordering among managed, session, and user layers.

**Data flow**: Creates user and managed config files plus CLI override tuples, builds a manager, calls `read(include_layers = true)`, asserts the effective `model`, checks the origin source, strips an optional top MDM layer, and asserts the remaining layer order is managed, session flags, then user.

**Call relations**: Exercises the read path’s precedence/origin exposure in a three-layer conflict scenario.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 5 external calls (assert_eq!, matches!, write, tempdir, vec!).


##### `write_value_reports_managed_override`  (lines 809–842)

```
async fn write_value_reports_managed_override()
```

**Purpose**: Verifies that when a user writes a value that is still shadowed by managed config, the write response is marked `OkOverridden` and includes metadata naming the overriding layer and effective value. This is the positive case for override reporting.

**Data flow**: Creates empty user config and managed config forcing `approval_policy = never`, performs a user write to `on-request`, captures the response, and asserts `status == OkOverridden`, the overriding layer source matches the managed file, and `effective_value` is JSON `"never"`.

**Call relations**: Exercises `first_overridden_edit`/`compute_override_metadata` through the public write API.

*Call graph*: calls 4 internal fn (new_for_tests, default, with_managed_config_path_for_tests, try_from); 5 external calls (assert_eq!, json!, write, tempdir, vec!).


##### `upsert_merges_tables_replace_overwrites`  (lines 845–929)

```
async fn upsert_merges_tables_replace_overwrites() -> Result<()>
```

**Purpose**: Compares `MergeStrategy::Upsert` and `MergeStrategy::Replace` on a nested MCP server table to ensure upsert preserves unrelated nested tables while replace removes them. It is the main behavioral test for merge semantics.

**Data flow**: Writes a base TOML config with nested `env_http_headers` and `http_headers`, constructs a JSON overlay, performs an upsert write and parses the resulting file back into `TomlValue` for equality against the expected merged TOML, then resets the file, performs a replace write, and compares against the expected overwritten TOML.

**Call relations**: Exercises the `apply_merge` branch that calls `merge_toml_values` for table-to-table upserts and contrasts it with direct replacement.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 6 external calls (assert_eq!, json!, read_to_string, write, tempdir, from_str).


### `app-server/src/main_tests.rs`

`test` · `test execution`

This test module exercises the command-line surface of `AppServerArgs`, specifically the path where users supply inline configuration overrides with both the short `-c` form and the long `--config` form. The test constructs a synthetic argv array with a program name, two override arguments, and an unrelated `--listen off` option to ensure normal argument parsing still succeeds in the same invocation. It then inspects the parsed `config_overrides` field and explicitly invokes its override parser, asserting that the result is an ordered `Vec<(String, TomlValue)>` containing the exact keys `model` and `sandbox_mode` with TOML string values.

The file’s main value is as a regression check on the integration between Clap-derived argument parsing (`Parser::try_parse_from`) and the application’s config override representation. It confirms that multiple override flags accumulate rather than overwrite each other, that quoted TOML string syntax is preserved and decoded into `toml::Value`, and that the parser accepts both short and long flag spellings in one command. By using `pretty_assertions::assert_eq`, failures produce readable structural diffs, which is useful because the assertion compares nested tuple/vector/TOML data rather than plain scalars.

#### Function details

##### `app_server_accepts_cli_config_overrides`  (lines 7–37)

```
fn app_server_accepts_cli_config_overrides()
```

**Purpose**: Builds a representative app-server command line, parses it into `AppServerArgs`, converts the collected config override arguments into TOML-backed key/value pairs, and checks that the parsed overrides exactly match the expected two entries.

**Data flow**: It feeds a fixed argv slice into `AppServerArgs::try_parse_from`, producing an `AppServerArgs` instance or failing the test with `expect`. From that struct it reads `config_overrides`, calls `parse_overrides()` to transform raw CLI override strings into a `Vec<(String, TomlValue)>`, and compares the result against a literal expected vector containing `model` and `sandbox_mode` string values. The function writes no persistent state; its only outputs are test pass/fail and assertion diagnostics.

**Call relations**: This function is invoked by the Rust test harness as a `#[test]` case. Within its flow, parsing is delegated first to Clap’s generated `try_parse_from` implementation for `AppServerArgs`, then to the application’s override parser on the parsed field; the final step uses `assert_eq!` to validate the end-to-end result and surface any mismatch.

*Call graph*: 2 external calls (try_parse_from, assert_eq!).


### `app-server/src/message_processor_tracing_tests.rs`

`test` · `request handling tests`

This test file stands up a near-real message-processing stack around `MessageProcessor`, including a temporary Codex home, mock assistant backend, auth/config managers, an `OutgoingMessageSender`, and an in-memory OpenTelemetry exporter. The central helper type is `TracingHarness`, which initializes the processor by sending a real `initialize` request, keeps a per-connection `ConnectionSessionState`, and exposes helpers to submit typed `ClientRequest` values and read typed responses back from the outgoing channel. `RemoteTrace` constructs deterministic remote trace metadata by parsing hex trace/span IDs and formatting a `traceparent` header plus `tracestate`.

The file also provides span-inspection utilities: extracting string attributes from `SpanData`, locating RPC server spans by `rpc.system=jsonrpc` and `rpc.method`, formatting all exported spans for panic messages, and walking parent links to prove ancestry depth. Export polling is explicit: tests repeatedly force-flush the tracer provider and wait until exported spans satisfy a predicate, which avoids races with async span export.

The two tests verify different propagation paths. One checks `thread/start` both without incoming trace context and with a supplied remote parent, asserting that the server span is remote-parented and has nested internal descendants. The other checks `turn/start`, asserting that the JSON-RPC server span carries the returned `turn.id` attribute and that downstream core work (`codex.op=user_input`) descends from that request span. The `serial` attribute and one-off global tracing initialization avoid cross-test contamination from global subscriber state.

#### Function details

##### `RemoteTrace::new`  (lines 70–83)

```
fn new(trace_id: &str, parent_span_id: &str) -> Self
```

**Purpose**: Builds a deterministic remote tracing fixture from hex-encoded trace and parent span IDs. It packages both parsed OpenTelemetry IDs and the corresponding `W3cTraceContext` headers used by requests.

**Data flow**: Takes `trace_id` and `parent_span_id` as hex strings, parses them into `TraceId` and `SpanId`, formats a `traceparent` string with sampled flag `01`, adds a fixed `tracestate` of `vendor=value`, and returns a `RemoteTrace` containing all three representations.

**Call relations**: Both tracing tests call this first to create an incoming remote parent context before issuing traced requests, so later assertions can compare exported span IDs against known expected values.

*Call graph*: called by 2 (thread_start_jsonrpc_span_exports_server_span_and_parents_children, turn_start_jsonrpc_span_parents_core_turn_spans); 3 external calls (from_hex, from_hex, format!).


##### `init_test_tracing`  (lines 86–101)

```
fn init_test_tracing() -> &'static TestTracing
```

**Purpose**: Installs a singleton in-memory OpenTelemetry tracing pipeline for the test process. It ensures all spans emitted by the message processor are captured and queryable.

**Data flow**: Reads and initializes a `OnceLock<TestTracing>`; on first use it creates an `InMemorySpanExporter`, builds an `SdkTracerProvider` with a simple exporter, installs a `TraceContextPropagator`, wires a `tracing_subscriber` registry to a tracing-opentelemetry layer, sets it as the global subscriber, and returns a shared static `TestTracing` reference.

**Call relations**: Called only from `TracingHarness::new`, so every harness shares the same global subscriber/provider while each test resets exporter state before making assertions.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `request_from_client_request`  (lines 103–106)

```
fn request_from_client_request(request: ClientRequest) -> JSONRPCRequest
```

**Purpose**: Converts a typed protocol `ClientRequest` enum into the generic `JSONRPCRequest` shape expected by `MessageProcessor::process_request`. It relies on serde round-tripping rather than hand-written mapping.

**Data flow**: Consumes a `ClientRequest`, serializes it to `serde_json::Value`, deserializes that value into `JSONRPCRequest`, and returns the converted request or panics if the protocol types diverge.

**Call relations**: Used inside `TracingHarness::request` immediately before attaching optional trace context and dispatching the request into the processor.

*Call graph*: called by 1 (request); 2 external calls (from_value, to_value).


##### `TracingHarness::new`  (lines 118–157)

```
async fn new() -> Result<Self>
```

**Purpose**: Constructs a fully initialized integration-test harness around a real `MessageProcessor`. It also performs the mandatory `initialize` handshake so later requests run in an initialized session.

**Data flow**: Creates a repeating mock responses server and temporary Codex home, builds a test `Config`, constructs the processor plus outgoing receiver, initializes/reset tracing state, creates a fresh `ConnectionSessionState`, then sends a typed `ClientRequest::Initialize` through `self.request` and asserts `session.initialized()` before returning the populated harness.

**Call relations**: Both top-level tests begin here. Internally it orchestrates `build_test_config`, `build_test_processor`, `init_test_tracing`, and the harness request path so later test logic can focus only on traced operations.

*Call graph*: calls 4 internal fn (new, build_test_config, build_test_processor, init_test_tracing); called by 2 (thread_start_jsonrpc_span_exports_server_span_and_parents_children, turn_start_jsonrpc_span_parents_core_turn_spans); 7 external calls (new, default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, rebuild_interest_cache).


##### `TracingHarness::reset_tracing`  (lines 159–161)

```
fn reset_tracing(&self)
```

**Purpose**: Clears previously exported spans from the shared in-memory exporter. This lets a test isolate spans produced by a later request.

**Data flow**: Reads the harness’s static `TestTracing` reference and invokes `exporter.reset()`, producing no return value.

**Call relations**: Used by the turn-start test after thread creation so assertions only inspect spans from the subsequent `turn/start` request.


##### `TracingHarness::shutdown`  (lines 163–166)

```
async fn shutdown(self)
```

**Purpose**: Performs orderly processor teardown at the end of a test. It waits for worker threads and background tasks to finish so no async work leaks into later tests.

**Data flow**: Consumes the harness, awaits `processor.shutdown_threads()`, then awaits `processor.drain_background_tasks()`, and returns unit.

**Call relations**: Called at the end of both tests after span assertions complete.


##### `TracingHarness::request`  (lines 168–188)

```
async fn request(&mut self, request: ClientRequest, trace: Option<W3cTraceContext>) -> T
```

**Purpose**: Sends one typed client request through the real message processor and waits for the matching typed response on the outgoing channel. It also injects optional incoming trace context into the JSON-RPC envelope.

**Data flow**: Accepts a `ClientRequest` and optional `W3cTraceContext`; extracts and validates that the request ID is an integer, converts the request to `JSONRPCRequest`, sets `request.trace`, invokes `processor.process_request` with the fixed test connection ID, stdio transport, and shared session, then waits in `read_response` for the matching response and deserializes it to `T`.

**Call relations**: This is the harness’s core dispatch path. `TracingHarness::start_thread` uses it, and `TracingHarness::new` uses it for initialization.

*Call graph*: calls 2 internal fn (read_response, request_from_client_request); called by 1 (start_thread); 3 external calls (clone, id, panic!).


##### `TracingHarness::start_thread`  (lines 190–209)

```
async fn start_thread(
        &mut self,
        request_id: i64,
        trace: Option<W3cTraceContext>,
    ) -> ThreadStartResponse
```

**Purpose**: Issues a `thread/start` request configured for ephemeral threads and waits for both the RPC response and the follow-up `thread/started` notification. It returns the typed start response once the notification has been observed.

**Data flow**: Builds `ClientRequest::ThreadStart` with the supplied integer request ID and `ThreadStartParams { ephemeral: Some(true), ..default() }`, sends it through `self.request`, then drains outgoing messages until `read_thread_started_notification` sees a `ServerNotification::ThreadStarted`, finally returning the `ThreadStartResponse`.

**Call relations**: Used by both tracing tests to create threads before asserting span structure around thread startup or later turn startup.

*Call graph*: calls 2 internal fn (request, read_thread_started_notification); 2 external calls (Integer, default).


##### `build_test_config`  (lines 212–227)

```
async fn build_test_config(codex_home: &Path, server_uri: &str) -> Result<Config>
```

**Purpose**: Creates a temporary on-disk config rooted at the test Codex home and pointing at the mock backend server. It mirrors enough real configuration for `MessageProcessor` to boot.

**Data flow**: Takes a Codex home path and mock server URI, writes a mock responses TOML config with empty overrides and fixed provider/compaction settings, then builds a `codex_core::config::Config` via `ConfigBuilder` using that home directory and returns it.

**Call relations**: Called only from `TracingHarness::new` before processor construction.

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

**Purpose**: Assembles the concrete `MessageProcessor` dependency graph used by tracing tests. It wires auth, config management, analytics, outgoing transport, environment management, and session metadata into `MessageProcessorArgs`.

**Data flow**: Consumes an `Arc<Config>`, creates an mpsc channel for outgoing envelopes, builds an `AuthManager`, `ConfigManager`, analytics client, and `OutgoingMessageSender`, then constructs `MessageProcessor::new` with test-friendly dependencies such as `EnvironmentManager::default_for_tests()`, `SessionSource::VSCode`, stdio RPC transport, fixed installation ID, and plugin startup enabled; returns the processor and outgoing receiver.

**Call relations**: Called from `TracingHarness::new` to produce the real processor under test.

*Call graph*: calls 8 internal fn (analytics_events_client_from_config, new, new, new, default, default_for_tests, new, shared_from_config); called by 1 (new); 6 external calls (clone, new, new, default, default, channel).


##### `run_current_thread_test_with_stack`  (lines 274–294)

```
fn run_current_thread_test_with_stack(name: &str, future: F) -> Result<()>
```

**Purpose**: Runs an async test body on a dedicated current-thread Tokio runtime with an enlarged native thread stack. This avoids stack-size issues in the synchronous `#[test]` case.

**Data flow**: Accepts a thread name and future, spawns a new OS thread with a 4 MiB stack, builds a current-thread Tokio runtime inside it, blocks on the boxed future, joins the thread, and returns either the future’s `Result<()>` or an `anyhow!` panic error if the thread panicked.

**Call relations**: Used only by the `thread_start_jsonrpc_span_exports_server_span_and_parents_children` test, which is written as a plain `#[test]` rather than `#[tokio::test]`.

*Call graph*: called by 1 (thread_start_jsonrpc_span_exports_server_span_and_parents_children); 2 external calls (anyhow!, new).


##### `span_attr`  (lines 296–304)

```
fn span_attr(span: &'a SpanData, key: &str) -> Option<&'a str>
```

**Purpose**: Looks up a string-valued OpenTelemetry span attribute by key. It is a small inspection helper for assertions and diagnostics.

**Data flow**: Reads a `SpanData`’s `attributes` list, finds the first key matching `key`, returns `Some(&str)` only when the value is an OpenTelemetry string, otherwise returns `None`.

**Call relations**: Used by the span-finding and formatting helpers and indirectly by both tests to match spans on `rpc.method`, `rpc.system`, `codex.op`, and `turn.id`.


##### `find_rpc_span_with_trace`  (lines 306–326)

```
fn find_rpc_span_with_trace(
    spans: &'a [SpanData],
    kind: SpanKind,
    method: &str,
    trace_id: TraceId,
) -> &'a SpanData
```

**Purpose**: Finds a JSON-RPC span of a specific kind and method within a specific trace. On failure it panics with a formatted dump of all exported spans.

**Data flow**: Scans a slice of `SpanData`, filtering by `span_kind`, `rpc.system == "jsonrpc"`, `rpc.method == method`, and `trace_id`, then returns the matching span reference or panics with `format_spans(spans)` embedded in the message.

**Call relations**: Both tests use it to locate the request-level server span they want to validate.

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

**Purpose**: Finds any span in a given trace that satisfies a caller-provided predicate. It is the generic counterpart to `find_rpc_span_with_trace`.

**Data flow**: Iterates over exported spans, keeps only those whose `span_context.trace_id()` matches `trace_id`, applies the supplied predicate, and returns the first match or panics with a descriptive message plus formatted span dump.

**Call relations**: Used by the turn-start test to locate the downstream core span marked with `codex.op=user_input`.

*Call graph*: called by 1 (turn_start_jsonrpc_span_parents_core_turn_spans); 1 external calls (iter).


##### `format_spans`  (lines 348–365)

```
fn format_spans(spans: &[SpanData]) -> String
```

**Purpose**: Produces a compact multi-line textual summary of exported spans for debugging failed assertions. The output includes identity, hierarchy, and RPC method metadata.

**Data flow**: Maps each `SpanData` to a formatted line containing span name, span ID, kind, parent span ID, trace ID, and `rpc.method` if present, then joins the lines with newlines into a single `String`.

**Call relations**: Called from panic paths in the span search and ancestry assertion helpers so failures show the full exported span set.

*Call graph*: 1 external calls (iter).


##### `span_depth_from_ancestor`  (lines 367–390)

```
fn span_depth_from_ancestor(
    spans: &[SpanData],
    child: &SpanData,
    ancestor: &SpanData,
) -> Option<usize>
```

**Purpose**: Walks parent links from a child span upward to determine whether it descends from a given ancestor and, if so, at what depth. It tolerates missing intermediate spans by stopping the search.

**Data flow**: Takes the full span slice plus child and ancestor references, repeatedly follows `parent_span_id` through the exported span list, increments a depth counter, returns `Some(depth)` when the ancestor span ID is reached, and returns `None` if the chain ends or a parent span is absent.

**Call relations**: Used by `assert_span_descends_from` and indirectly by depth-based descendant checks.

*Call graph*: called by 1 (assert_span_descends_from); 1 external calls (iter).


##### `assert_span_descends_from`  (lines 392–403)

```
fn assert_span_descends_from(spans: &[SpanData], child: &SpanData, ancestor: &SpanData)
```

**Purpose**: Asserts that one exported span is somewhere beneath another in the same parent chain. It panics with a span dump if the ancestry relation is absent.

**Data flow**: Calls `span_depth_from_ancestor`; if it returns `Some(_)`, the function returns normally, otherwise it panics with both span names and `format_spans(spans)`.

**Call relations**: Used by the turn-start test to prove that the core `user_input` span is nested under the JSON-RPC `turn/start` server span.

*Call graph*: calls 1 internal fn (span_depth_from_ancestor); called by 1 (turn_start_jsonrpc_span_parents_core_turn_spans); 1 external calls (panic!).


##### `assert_has_internal_descendant_at_min_depth`  (lines 405–424)

```
fn assert_has_internal_descendant_at_min_depth(
    spans: &[SpanData],
    ancestor: &SpanData,
    min_depth: usize,
)
```

**Purpose**: Checks that a span has at least one internal descendant at or below a requested depth threshold. This verifies that request spans are not leaf-only wrappers.

**Data flow**: Scans all spans for one with `SpanKind::Internal`, the same trace ID as `ancestor`, and a computed depth from `ancestor` greater than or equal to `min_depth`; returns on success or panics with a formatted span dump on failure.

**Call relations**: Used by the thread-start test to verify both immediate and deeper nested internal work beneath the request span.

*Call graph*: called by 1 (thread_start_jsonrpc_span_exports_server_span_and_parents_children); 2 external calls (iter, panic!).


##### `read_response`  (lines 426–455)

```
async fn read_response(
    outgoing_rx: &mut mpsc::Receiver<crate::outgoing_message::OutgoingEnvelope>,
    request_id: i64,
) -> T
```

**Purpose**: Consumes the outgoing envelope stream until it finds the JSON-RPC response for the target request ID on the fixed test connection. It ignores unrelated broadcasts, notifications, and responses for other requests.

**Data flow**: Loops on `outgoing_rx.recv()` under a 5-second timeout, filters for `OutgoingEnvelope::ToConnection` with `connection_id == TEST_CONNECTION_ID`, then for `OutgoingMessage::Response` with matching integer `RequestId`, deserializes `response.result` into `T`, and returns it.

**Call relations**: Called by `TracingHarness::request` after dispatching a request into the processor.

*Call graph*: calls 1 internal fn (recv); called by 1 (request); 4 external calls (Integer, from_value, from_secs, timeout).


##### `read_thread_started_notification`  (lines 457–501)

```
async fn read_thread_started_notification(
    outgoing_rx: &mut mpsc::Receiver<crate::outgoing_message::OutgoingEnvelope>,
)
```

**Purpose**: Waits until a `thread/started` server notification appears on the outgoing stream, whether targeted to the test connection or broadcast globally. It ignores all other outgoing traffic.

**Data flow**: Loops on timed `recv()`, matches either `OutgoingEnvelope::ToConnection` for the test connection or `OutgoingEnvelope::Broadcast`, extracts `OutgoingMessage::AppServerNotification`, checks for `ServerNotification::ThreadStarted(_)`, and returns once found.

**Call relations**: Called by `TracingHarness::start_thread` so tests do not proceed until thread startup side effects have been emitted.

*Call graph*: calls 1 internal fn (recv); called by 1 (start_thread); 3 external calls (matches!, from_secs, timeout).


##### `wait_for_exported_spans`  (lines 503–526)

```
async fn wait_for_exported_spans(tracing: &TestTracing, predicate: F) -> Vec<SpanData>
```

**Purpose**: Polls the in-memory exporter until a caller-supplied predicate over exported spans becomes true. It force-flushes the tracer provider between polls to make async span completion visible.

**Data flow**: Repeatedly yields to the scheduler, calls `provider.force_flush()`, fetches finished spans from the exporter, stores the latest snapshot, evaluates `predicate(&spans)`, and either returns the matching span vector or, after 200 iterations with 50 ms sleeps, panics with the last formatted span dump.

**Call relations**: Used directly by both tests and by `wait_for_new_exported_spans` to synchronize assertions with asynchronous tracing/export timing.

*Call graph*: called by 3 (thread_start_jsonrpc_span_exports_server_span_and_parents_children, turn_start_jsonrpc_span_parents_core_turn_spans, wait_for_new_exported_spans); 5 external calls (new, panic!, from_millis, yield_now, sleep).


##### `wait_for_new_exported_spans`  (lines 528–541)

```
async fn wait_for_new_exported_spans(
    tracing: &TestTracing,
    baseline_len: usize,
    predicate: F,
) -> Vec<SpanData>
```

**Purpose**: Waits specifically for spans exported after a known baseline length and returns only that suffix. This lets a test isolate spans from a second request without resetting the exporter.

**Data flow**: Accepts a baseline span count and predicate over the new suffix, delegates to `wait_for_exported_spans` with a wrapper predicate requiring `spans.len() > baseline_len`, then drops the baseline prefix and returns the newly exported spans as a `Vec<SpanData>`.

**Call relations**: Used by the thread-start test after an initial untraced request to inspect only spans produced by the traced second request.

*Call graph*: calls 1 internal fn (wait_for_exported_spans); called by 1 (thread_start_jsonrpc_span_exports_server_span_and_parents_children).


##### `thread_start_jsonrpc_span_exports_server_span_and_parents_children`  (lines 545–633)

```
fn thread_start_jsonrpc_span_exports_server_span_and_parents_children() -> Result<()>
```

**Purpose**: Verifies that `thread/start` emits a JSON-RPC server span, that untraced requests still produce nested internal work, and that traced requests adopt the supplied remote parent span and trace ID.

**Data flow**: Runs inside `run_current_thread_test_with_stack`; creates a harness, constructs a `RemoteTrace`, starts one untraced thread and waits for a `thread/start` server span to appear, records the baseline span count, starts a second thread with remote trace context, waits for new spans containing both the traced server span and `app_server.thread_start.notify_started`, then asserts span name, remote parent span ID, remote-parent flag, trace ID, non-invalid span ID, and existence of internal descendants at depths 1 and 2 before shutting down.

**Call relations**: This is a top-level integration test. It drives the full harness request path and uses the span search/assertion helpers to validate propagation and nesting.

*Call graph*: calls 7 internal fn (new, new, assert_has_internal_descendant_at_min_depth, find_rpc_span_with_trace, run_current_thread_test_with_stack, wait_for_exported_spans, wait_for_new_exported_spans); 3 external calls (assert!, assert_eq!, assert_ne!).


##### `turn_start_jsonrpc_span_parents_core_turn_spans`  (lines 637–711)

```
async fn turn_start_jsonrpc_span_parents_core_turn_spans() -> Result<()>
```

**Purpose**: Verifies that a traced `turn/start` request creates a JSON-RPC server span that becomes the ancestor of downstream core turn-processing spans. It also checks that the request span records the returned turn ID.

**Data flow**: Creates a harness, starts a thread to obtain `thread_id`, resets tracing, constructs a `RemoteTrace`, sends a `ClientRequest::TurnStart` with text input `hello`, waits for exported spans containing both the traced `turn/start` server span and a span with `codex.op=user_input`, then asserts the server span’s remote parent ID, remote-parent flag, trace ID, `turn.id` attribute equal to the response turn ID, and ancestry from the core turn span to the server span before shutdown.

**Call relations**: This is the second top-level integration test. It depends on the harness and generic span helpers, but focuses on propagation from app-server request handling into deeper core turn execution.

*Call graph*: calls 6 internal fn (new, new, assert_span_descends_from, find_rpc_span_with_trace, find_span_with_trace, wait_for_exported_spans); 4 external calls (Integer, assert!, assert_eq!, vec!).


### `app-server/src/request_processors/external_agent_config_processor_tests.rs`

`test` · `test`

This test file is narrowly focused on `migration_items_need_runtime_refresh`, the helper that decides whether imported external-agent artifacts should invalidate runtime-loaded config, skills, hooks, commands, MCP server config, or plugins. The local `migration_item` helper constructs minimal `ExternalAgentConfigMigrationItem` values with empty description and no cwd/details so each assertion can isolate item type behavior without unrelated fields.

The single test enumerates all currently supported item types relevant to refresh semantics. It asserts that `Config`, `Skills`, `McpServerConfig`, `Hooks`, `Commands`, and `Plugins` return `true`, while `Sessions` returns `false`. That captures an important design boundary in the import system: session migration persists historical thread data but does not alter runtime-loaded extension/config sources, so it should not trigger plugin/skills cache clearing.

Because the predicate is simple but behaviorally important, this file acts as a regression guard against accidentally broadening or narrowing refresh-triggering item types during future migration feature additions.

#### Function details

##### `migration_item`  (lines 3–12)

```
fn migration_item(
    item_type: ExternalAgentConfigMigrationItemType,
) -> ExternalAgentConfigMigrationItem
```

**Purpose**: Creates a minimal migration item with the requested item type for use in predicate tests.

**Data flow**: Takes an `ExternalAgentConfigMigrationItemType`, constructs `ExternalAgentConfigMigrationItem` with that type, empty `description`, and `None` for `cwd` and `details`, and returns it.

**Call relations**: Used only by the test in this file to reduce repetition when building one-element slices for `migration_items_need_runtime_refresh`.

*Call graph*: 1 external calls (new).


##### `migration_items_that_update_runtime_sources_trigger_refresh`  (lines 15–37)

```
fn migration_items_that_update_runtime_sources_trigger_refresh()
```

**Purpose**: Asserts the exact set of migration item types that should and should not trigger runtime refresh.

**Data flow**: Builds one-item slices using `migration_item(...)`, calls `migration_items_need_runtime_refresh` for each relevant item type, and asserts expected boolean outcomes.

**Call relations**: Unit test for the helper defined in `external_agent_config_processor.rs`, guarding the import orchestration’s refresh decision.

*Call graph*: 1 external calls (assert!).


### `app-server/src/request_processors/remote_control_processor/remote_control_processor_tests.rs`

`test` · `test execution`

This test module exercises the small but important policy decisions in `remote_control_processor.rs`. Two async tests instantiate `RemoteControlRequestProcessor` with `None` for its handle and verify that pairing-related RPCs fail with `INTERNAL_ERROR_CODE` and the exact message stating remote control is unavailable for this app-server. Those tests confirm that subsystem absence is treated differently from invalid client input.

The remaining unit tests target pure helper functions. `validate_pairing_status_params` is checked for both invalid shapes: missing both `pairing_code` and `manual_pairing_code`, and supplying both at once. The expected `INVALID_REQUEST_ERROR_CODE` and exact protocol messages are asserted, preserving the API contract clients rely on. Error-mapping helpers are also covered directly: `map_pairing_start_error` must classify `InvalidInput` as invalid request and other failures as internal error, while `map_client_management_error` must downgrade `InvalidInput`, `NotFound`, `PermissionDenied`, and `WouldBlock` to invalid request and leave generic backend failures as internal errors.

Because these tests compare full `JSONRPCErrorError` structs, they protect not just control flow but also exact codes, `data: None`, and message text.

#### Function details

##### `pairing_start_returns_internal_error_when_remote_control_is_unavailable`  (lines 7–24)

```
async fn pairing_start_returns_internal_error_when_remote_control_is_unavailable()
```

**Purpose**: Verifies that starting pairing without any configured remote-control handle fails as an internal server error, not as an invalid request. It checks the exact JSON-RPC payload returned to clients.

**Data flow**: Constructs `RemoteControlRequestProcessor::new(None)`, calls `pairing_start(RemoteControlPairingStartParams::default(), None).await`, captures the expected error with `expect_err`, and compares it against a fully populated `JSONRPCErrorError` containing `INTERNAL_ERROR_CODE`, `data: None`, and the fixed unavailable message.

**Call relations**: This test drives the public `pairing_start` path through `RemoteControlRequestProcessor::handle`’s missing-handle branch, confirming the behavior observed by request dispatchers.

*Call graph*: calls 1 internal fn (new); 2 external calls (default, assert_eq!).


##### `pairing_status_returns_internal_error_when_remote_control_is_unavailable`  (lines 27–44)

```
async fn pairing_status_returns_internal_error_when_remote_control_is_unavailable()
```

**Purpose**: Verifies that querying pairing status without a remote-control handle also fails as an internal error. It ensures the same unavailable-subsystem contract applies to status lookup.

**Data flow**: Builds `RemoteControlRequestProcessor::new(None)`, passes `RemoteControlPairingStatusParams` with only `pairing_code` set, awaits `pairing_status`, extracts the error, and asserts equality with the expected `JSONRPCErrorError` using `INTERNAL_ERROR_CODE` and the unavailable message.

**Call relations**: Exercises the `pairing_status` path after parameter validation succeeds, proving that the later `handle()` check still produces the internal-error response when the subsystem is absent.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `pairing_status_rejects_missing_pairing_codes`  (lines 47–60)

```
fn pairing_status_rejects_missing_pairing_codes()
```

**Purpose**: Checks that pairing-status validation rejects requests that provide neither pairing identifier. The test locks down the exact invalid-request message.

**Data flow**: Calls `validate_pairing_status_params` with both `pairing_code` and `manual_pairing_code` set to `None`, then asserts the returned `Err(JSONRPCErrorError { ... })` matches `INVALID_REQUEST_ERROR_CODE`, `data: None`, and the required-message string.

**Call relations**: Targets the standalone validator used by `RemoteControlRequestProcessor::pairing_status`, covering the no-identifiers branch before any backend interaction.

*Call graph*: 1 external calls (assert_eq!).


##### `pairing_status_rejects_conflicting_pairing_codes`  (lines 63–77)

```
fn pairing_status_rejects_conflicting_pairing_codes()
```

**Purpose**: Checks that pairing-status validation rejects requests that provide both identifier fields simultaneously. This preserves the API’s mutual-exclusion rule.

**Data flow**: Invokes `validate_pairing_status_params` with both `pairing_code` and `manual_pairing_code` populated and asserts the returned invalid-request error equals the expected `JSONRPCErrorError` with the conflict message.

**Call relations**: Covers the second invalid branch of the validator used by `pairing_status`, ensuring ambiguous requests are rejected locally.

*Call graph*: 1 external calls (assert_eq!).


##### `pairing_start_maps_invalid_input_to_invalid_request`  (lines 80–92)

```
fn pairing_start_maps_invalid_input_to_invalid_request()
```

**Purpose**: Confirms that pairing backend failures tagged as `io::ErrorKind::InvalidInput` are exposed to clients as invalid requests. This distinguishes malformed pairing attempts from server faults.

**Data flow**: Constructs an `io::Error` with kind `InvalidInput` and message `remote control pairing is unavailable`, passes it to `map_pairing_start_error`, and asserts the returned `JSONRPCErrorError` contains `INVALID_REQUEST_ERROR_CODE` and the same message.

**Call relations**: Directly tests the helper used by both `pairing_start` and `pairing_status`, pinning down their shared error-classification rule.

*Call graph*: 1 external calls (assert_eq!).


##### `pairing_start_maps_backend_failures_to_internal_error`  (lines 95–104)

```
fn pairing_start_maps_backend_failures_to_internal_error()
```

**Purpose**: Confirms that non-input pairing failures are treated as internal errors. It protects the fallback branch of pairing error mapping.

**Data flow**: Creates `io::Error::other("remote control pairing failed")`, feeds it to `map_pairing_start_error`, and asserts the result is a `JSONRPCErrorError` with `INTERNAL_ERROR_CODE`, `data: None`, and the original message.

**Call relations**: Complements the previous test by covering the non-`InvalidInput` branch of the helper used in pairing RPCs.

*Call graph*: 1 external calls (assert_eq!).


##### `client_management_maps_user_actionable_errors_to_invalid_request`  (lines 107–123)

```
fn client_management_maps_user_actionable_errors_to_invalid_request()
```

**Purpose**: Verifies that several client-management `io::ErrorKind` values are intentionally downgraded to invalid requests. This includes transient or permission-related conditions clients can react to.

**Data flow**: Iterates over `InvalidInput`, `NotFound`, `PermissionDenied`, and `WouldBlock`, creates an `io::Error` for each with the same message, passes each to `map_client_management_error`, and asserts the returned `JSONRPCErrorError` always uses `INVALID_REQUEST_ERROR_CODE` and preserves the message.

**Call relations**: Directly covers the helper shared by `clients_list` and `clients_revoke`, validating all of its special-case branches.

*Call graph*: 1 external calls (assert_eq!).


##### `client_management_maps_backend_failures_to_internal_error`  (lines 126–135)

```
fn client_management_maps_backend_failures_to_internal_error()
```

**Purpose**: Verifies that generic client-management backend failures remain internal errors. It protects the default branch of the client-management mapper.

**Data flow**: Builds `io::Error::other("client management failed")`, passes it to `map_client_management_error`, and asserts the returned `JSONRPCErrorError` contains `INTERNAL_ERROR_CODE`, `data: None`, and the original message.

**Call relations**: Completes coverage of the helper used by client-management RPCs by checking the catch-all internal-error path.

*Call graph*: 1 external calls (assert_eq!).


### `app-server/src/request_processors/thread_processor_tests.rs`

`test` · `test-time regression coverage for thread request handling, resume, and state transitions`

This file is a dense test suite for the thread request-processing subsystem rather than production logic. It is organized into three modules: cwd-filter normalization tests, background-terminal pagination tests, and a large behavior suite covering thread summaries, config derivation, resume metadata, dynamic tool validation, and thread state management. The tests construct concrete protocol values such as `ThreadBackgroundTerminal`, `StoredThread`, `ThreadResumeParams`, `ThreadConfigSnapshot`, `Turn`, `ThreadItem`, and `SessionMeta`, then assert exact outputs from production helpers imported from the parent module.

A recurring theme is preserving wire-level semantics: timestamps from `StoredThread` keep millisecond precision, while protocol-facing summaries from `ThreadMetadata` are truncated to seconds; agent nickname/role and `forked_from_id` survive rollout/state-db summary paths; and aborted pending server requests resolve waiting callbacks with a structured `turnTransition` error and clear pending-request bookkeeping. The dynamic-tool tests are especially concrete, checking schema sanitization, nullable fields, namespace/name uniqueness, Responses API identifier regex and length limits, and reserved namespaces. Several async tests build temporary rollout files or in-memory managers (`ThreadStateManager`, `OutgoingMessageSender`, `ConfigManager`) to verify listener teardown, subscriber tracking, attestation-capable connection selection, and config precedence between session thread config and request overrides. The helper constructors in this file intentionally minimize boilerplate while keeping assertions on exact protocol payloads.

#### Function details

##### `thread_list_cwd_filter_tests::normalize_thread_list_cwd_filter_preserves_absolute_paths`  (lines 9–21)

```
fn normalize_thread_list_cwd_filter_preserves_absolute_paths()
```

**Purpose**: Verifies that a single absolute cwd filter string is accepted unchanged by the normalization helper. The test covers platform-specific absolute path syntax on Windows and non-Windows hosts.

**Data flow**: Builds a `String` absolute path based on `cfg!(windows)`, wraps it in `ThreadListCwdFilter::One`, passes it to `normalize_thread_list_cwd_filters`, and compares the returned `Option<Vec<PathBuf>>` to a vector containing the same path.

**Call relations**: This is a leaf test invoked by the Rust test harness. It exercises the production normalization path for already-absolute inputs and asserts that no rebasing against server cwd occurs.

*Call graph*: 3 external calls (from, assert_eq!, cfg!).


##### `thread_list_cwd_filter_tests::normalize_thread_list_cwd_filter_resolves_relative_paths_against_server_cwd`  (lines 24–36)

```
fn normalize_thread_list_cwd_filter_resolves_relative_paths_against_server_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that relative cwd filters are resolved against the server process current directory. It confirms the helper returns absolute `PathBuf` values rather than preserving relative strings.

**Data flow**: Computes an expected absolute path with `AbsolutePathBuf::relative_to_current_dir("repo-b")`, passes `ThreadListCwdFilter::Many(vec!["repo-b"])` into `normalize_thread_list_cwd_filters`, and asserts the normalized result equals `Some(vec![expected])`.

**Call relations**: Run by the test harness to cover the relative-path branch of cwd filter normalization. It complements the absolute-path test by proving the helper consults process cwd when needed.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 1 external calls (assert_eq!).


##### `background_terminal_pagination_tests::terminal`  (lines 45–57)

```
fn terminal(process_id: &str) -> ThreadBackgroundTerminal
```

**Purpose**: Creates a deterministic `ThreadBackgroundTerminal` fixture keyed by process id. The helper keeps all nonessential fields stable so pagination assertions can compare full structs.

**Data flow**: Accepts a `&str` process id, chooses a platform-specific absolute cwd, and returns a `ThreadBackgroundTerminal` with derived `item_id`, `process_id`, and `command`, plus parsed `AbsolutePathBuf` cwd and `None` for pid/cpu/rss fields.

**Call relations**: Used only by pagination tests in this module to generate ordered terminal lists and expected page slices without repeating struct literals.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (cfg!, format!).


##### `background_terminal_pagination_tests::paginates_with_process_id_cursor`  (lines 60–95)

```
fn paginates_with_process_id_cursor()
```

**Purpose**: Validates cursor-based pagination over background terminals using `process_id` as the anchor. It covers first-page generation, continuation when the anchor item disappeared, normal continuation when it still exists, and invalid cursor rejection.

**Data flow**: Builds several terminal vectors with `terminal`, calls `paginate_background_terminals` with different cursor/limit combinations, and asserts returned `(Vec<ThreadBackgroundTerminal>, Option<String>)` pairs or error status.

**Call relations**: Executed by the test harness to pin down pagination semantics. It specifically documents the fallback behavior when the cursor item is missing from the next snapshot: pagination resumes after the nearest surviving position rather than failing, except for completely unknown cursors.

*Call graph*: 4 external calls (assert!, assert_eq!, paginate_background_terminals, vec!).


##### `thread_processor_behavior_tests::forked_from_id_from_rollout`  (lines 99–105)

```
async fn forked_from_id_from_rollout(path: &Path) -> Option<String>
```

**Purpose**: Small async helper that extracts `forked_from_id` from a rollout file's session metadata. It hides the `Result` handling and UUID-to-string conversion needed by the tests.

**Data flow**: Takes a rollout `&Path`, awaits `codex_core::read_session_meta_line`, discards errors with `.ok()`, pulls `meta.forked_from_id`, and maps the `ThreadId` to `String`.

**Call relations**: Used by the `read_summary_from_rollout_preserves_forked_from_id` test to inspect rollout metadata directly, independent of higher-level summary conversion.

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

**Purpose**: Builds either a top-level dynamic function tool or a namespaced tool bundle for validation tests. It centralizes the repetitive `DynamicToolFunctionSpec` and namespace wrapper construction.

**Data flow**: Accepts optional namespace, tool name, JSON schema, and `defer_loading`; constructs a `DynamicToolFunctionSpec`; then returns `DynamicToolSpec::Function` when no namespace is provided or `DynamicToolSpec::Namespace` containing one `DynamicToolNamespaceTool::Function` otherwise.

**Call relations**: Shared fixture helper for the dynamic-tool validation tests. It lets each test vary only the namespace/name/schema constraints relevant to the validation branch under test.

*Call graph*: 4 external calls (into, Function, Namespace, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_unsupported_input_schema`  (lines 177–186)

```
fn validate_dynamic_tools_rejects_unsupported_input_schema()
```

**Purpose**: Confirms validation rejects a tool whose input schema uses an unsupported top-level type (`null`). The assertion also checks the error mentions the offending tool name.

**Data flow**: Creates a single tool with `dynamic_tool`, calls `validate_dynamic_tools`, expects an error string, and asserts that string contains `my_tool`.

**Call relations**: Test-harness entry covering the schema-rejection path in dynamic tool validation.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_sanitizable_input_schema`  (lines 189–198)

```
fn validate_dynamic_tools_accepts_sanitizable_input_schema()
```

**Purpose**: Verifies validation accepts a schema that is incomplete but sanitizable by core logic. The concrete case is a schema missing `type` but containing `properties`.

**Data flow**: Builds one tool with a minimal object-like schema, passes it to `validate_dynamic_tools`, and expects success.

**Call relations**: Documents that validation is intentionally permissive for schemas core can normalize later, rather than requiring already-canonical JSON Schema.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_nullable_field_schema`  (lines 201–216)

```
fn validate_dynamic_tools_accepts_nullable_field_schema()
```

**Purpose**: Checks that object schemas with nullable property types are accepted. This guards compatibility with `type: ["string", "null"]` field declarations.

**Data flow**: Constructs a tool whose `query` property allows string or null, validates the tool list, and expects no error.

**Call relations**: Covers a schema-shape acceptance case in the dynamic tool validator.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_same_name_in_different_namespaces`  (lines 219–243)

```
fn validate_dynamic_tools_accepts_same_name_in_different_namespaces()
```

**Purpose**: Ensures duplicate function names are allowed when separated by namespace. The test proves uniqueness is scoped per namespace, not globally.

**Data flow**: Creates two namespaced tools with identical function names but different namespace names, validates the vector, and expects success.

**Call relations**: Exercises namespace-aware duplicate detection in dynamic tool validation.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_accepts_responses_compatible_identifiers`  (lines 246–258)

```
fn validate_dynamic_tools_accepts_responses_compatible_identifiers()
```

**Purpose**: Verifies names and namespaces matching the Responses API identifier rules are accepted. The concrete identifiers include mixed case, underscore, and digits.

**Data flow**: Builds a namespaced tool using `Codex-App_2` and `lookup-ticket_2`, validates it, and expects success.

**Call relations**: Pins the accepted identifier character set for Responses-compatible dynamic tools.

*Call graph*: 1 external calls (vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_duplicate_name_in_same_namespace`  (lines 261–285)

```
fn validate_dynamic_tools_rejects_duplicate_name_in_same_namespace()
```

**Purpose**: Checks that two functions with the same name inside one namespace are rejected. The error must mention both the namespace and duplicated function name.

**Data flow**: Constructs a `DynamicToolSpec::Namespace` containing two identical `DynamicToolFunctionSpec` entries, runs `validate_dynamic_tools`, captures the error string, and asserts it contains `codex_app` and `my_tool`.

**Call relations**: Covers the duplicate-name rejection branch for namespaced tool bundles.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::thread_turns_list_merges_in_progress_active_turn_before_agent_status_running`  (lines 288–325)

```
fn thread_turns_list_merges_in_progress_active_turn_before_agent_status_running()
```

**Purpose**: Verifies turns-list reconstruction appends a live in-progress turn even when thread status is idle and there is no separate running-thread flag. This protects UI visibility of active local state before agent-status propagation catches up.

**Data flow**: Creates persisted rollout items containing one user message and a separate `Turn` marked `InProgress`, calls `reconstruct_thread_turns_for_turns_list`, and asserts the returned turns end with the active turn.

**Call relations**: Regression test for ordering/merge logic in turns-list reconstruction when persisted history and live state coexist.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_empty_namespace`  (lines 328–341)

```
fn validate_dynamic_tools_rejects_empty_namespace()
```

**Purpose**: Confirms an empty namespace string is invalid. The error is expected to mention the namespace problem explicitly.

**Data flow**: Builds a namespaced tool with `Some("")`, validates it, expects an error, and checks the message contains `namespace`.

**Call relations**: Covers namespace-presence validation in the dynamic tool validator.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_reserved_namespace`  (lines 344–357)

```
fn validate_dynamic_tools_rejects_reserved_namespace()
```

**Purpose**: Checks that reserved internal namespace prefixes are rejected. The concrete reserved value under test is `mcp__server__`.

**Data flow**: Creates a namespaced tool using the reserved namespace, validates it, expects failure, and asserts the error mentions `reserved`.

**Call relations**: Documents a guardrail preventing collisions with internal MCP namespace conventions.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_name_not_supported_by_responses`  (lines 360–377)

```
fn validate_dynamic_tools_rejects_name_not_supported_by_responses()
```

**Purpose**: Ensures tool names outside the Responses API identifier regex are rejected. The test uses a dotted name to trigger the failure.

**Data flow**: Builds a tool named `lookup.ticket`, validates it, captures the error, and asserts it mentions the bad name plus the Responses API regex `^[a-zA-Z0-9_-]+$`.

**Call relations**: Covers identifier-format validation for top-level tool names.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_namespace_not_supported_by_responses`  (lines 380–397)

```
fn validate_dynamic_tools_rejects_namespace_not_supported_by_responses()
```

**Purpose**: Ensures namespaces outside the Responses API identifier regex are rejected. The concrete invalid namespace contains a dot.

**Data flow**: Builds a namespaced tool with namespace `codex.app`, validates it, expects an error, and checks for both the bad namespace and the regex guidance.

**Call relations**: Parallel to the invalid-name test, but for namespace validation.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_name_longer_than_responses_limit`  (lines 400–415)

```
fn validate_dynamic_tools_rejects_name_longer_than_responses_limit()
```

**Purpose**: Checks the maximum Responses API tool-name length enforcement. The test uses a 129-character name and expects a limit error.

**Data flow**: Generates a long string with `"a".repeat(129)`, validates a tool using it, and asserts the error mentions `at most 128` and includes the offending name.

**Call relations**: Covers length-limit validation for tool names.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_namespace_fields_over_limits`  (lines 418–441)

```
fn validate_dynamic_tools_rejects_namespace_fields_over_limits()
```

**Purpose**: Verifies namespace metadata length limits for both namespace name and description. It mutates the same tool to test both branches.

**Data flow**: First validates a tool with a 65-character namespace name and asserts the error mentions `at most 64`; then destructures the namespace entry, replaces the name with `tickets`, sets a 1025-character description, revalidates, and asserts the description limit error mentions `at most 1024`.

**Call relations**: Exercises multiple namespace field-length checks in one test, using direct mutation of the constructed `DynamicToolSpec::Namespace`.

*Call graph*: 3 external calls (assert!, unreachable!, vec!).


##### `thread_processor_behavior_tests::validate_dynamic_tools_rejects_reserved_responses_namespace`  (lines 444–458)

```
fn validate_dynamic_tools_rejects_reserved_responses_namespace()
```

**Purpose**: Confirms the Responses API reserved namespace `functions` is rejected even though it matches the identifier regex. This distinguishes reserved-word checks from syntax checks.

**Data flow**: Builds a namespaced tool under `functions`, validates it, expects an error, and asserts the message mentions both `functions` and `Responses API`.

**Call relations**: Covers reserved-name validation specific to Responses API semantics.

*Call graph*: 2 external calls (assert!, vec!).


##### `thread_processor_behavior_tests::summary_from_stored_thread_preserves_millisecond_precision`  (lines 461–507)

```
fn summary_from_stored_thread_preserves_millisecond_precision()
```

**Purpose**: Checks that summaries built from `StoredThread` preserve RFC3339 millisecond precision for created and updated timestamps. This differs from protocol metadata summaries that intentionally round to seconds.

**Data flow**: Parses two RFC3339 timestamps with milliseconds, constructs a concrete `StoredThread`, calls `summary_from_stored_thread`, and asserts `summary.timestamp` and `summary.updated_at` equal the original millisecond strings.

**Call relations**: Regression test for timestamp formatting in the stored-thread summary path.

*Call graph*: calls 2 internal fn (read_only, from_string); 3 external calls (parse_from_rfc3339, from, assert_eq!).


##### `thread_processor_behavior_tests::requested_permissions_trust_project_uses_permission_profile_intent`  (lines 510–583)

```
fn requested_permissions_trust_project_uses_permission_profile_intent()
```

**Purpose**: Verifies trust-project detection is based on permission-profile intent rather than only exact built-in profile names. It covers disabled/full-access, workspace-write, custom restricted-write, and read-only cases.

**Data flow**: Builds an absolute cwd and several `PermissionProfile` variants, wraps them in `ConfigOverrides` either as typed `permission_profile` or string `default_permissions`, calls `requested_permissions_trust_project`, and asserts true for write/full-access intents and false for read-only intents.

**Call relations**: Documents how permission intent is inferred from both explicit runtime profiles and named built-in profiles.

*Call graph*: calls 4 internal fn (from_runtime_permissions, read_only, workspace_write, restricted); 3 external calls (assert!, test_path_buf, vec!).


##### `thread_processor_behavior_tests::config_load_error_marks_cloud_config_bundle_failures_for_relogin`  (lines 586–610)

```
fn config_load_error_marks_cloud_config_bundle_failures_for_relogin()
```

**Purpose**: Checks that auth-related cloud config bundle load failures are converted into a JSON-RPC error with structured relogin metadata. The message still remains a generic configuration-load failure.

**Data flow**: Wraps a `CloudConfigBundleLoadError` with code `Auth` and status 401 inside `std::io::Error::other`, passes it to `config_load_error`, and asserts the returned error's `data` JSON contains reason, errorCode, action `relogin`, statusCode, and detail.

**Call relations**: Covers the branch where config-load errors are annotated for client UX recovery.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, other).


##### `thread_processor_behavior_tests::config_load_error_leaves_non_cloud_config_bundle_failures_unmarked`  (lines 613–624)

```
fn config_load_error_leaves_non_cloud_config_bundle_failures_unmarked()
```

**Purpose**: Ensures ordinary configuration load failures are not decorated with cloud-config metadata. Only the generic failure message should remain.

**Data flow**: Creates a plain `std::io::Error::other` string error, converts it with `config_load_error`, and asserts `data` is `None` while the message still mentions configuration load failure.

**Call relations**: Negative-control test for cloud-config-specific error enrichment.

*Call graph*: 3 external calls (assert!, assert_eq!, other).


##### `thread_processor_behavior_tests::config_load_error_marks_non_auth_cloud_config_bundle_failures_without_relogin`  (lines 627–644)

```
fn config_load_error_marks_non_auth_cloud_config_bundle_failures_without_relogin()
```

**Purpose**: Checks that non-auth cloud config bundle failures still carry structured metadata, but without a relogin action. The concrete code under test is `RequestFailed`.

**Data flow**: Builds a `CloudConfigBundleLoadError` with code `RequestFailed`, wraps it in `std::io::Error`, converts it via `config_load_error`, and asserts the returned `data` JSON contains reason, errorCode, and detail only.

**Call relations**: Covers cloud-config error annotation for recoverable/non-auth failures.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, other).


##### `thread_processor_behavior_tests::config_load_error_marks_invalid_cloud_config_bundle_failures_without_relogin`  (lines 647–664)

```
fn config_load_error_marks_invalid_cloud_config_bundle_failures_without_relogin()
```

**Purpose**: Verifies invalid-bundle cloud config failures are surfaced with structured metadata but no relogin action. This distinguishes malformed bundle content from authentication problems.

**Data flow**: Creates a `CloudConfigBundleLoadError` with code `InvalidBundle`, wraps it in `std::io::Error`, passes it to `config_load_error`, and asserts the resulting `data` JSON contains reason, errorCode, and detail.

**Call relations**: Completes coverage of cloud-config error classification.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, other).


##### `thread_processor_behavior_tests::derive_config_from_params_uses_session_thread_config_model_provider`  (lines 667–730)

```
async fn derive_config_from_params_uses_session_thread_config_model_provider() -> Result<()>
```

**Purpose**: Tests config precedence when session thread config defines a model provider and request overrides attempt to replace it. The session-scoped provider and feature flags should win, while unrelated request overrides like `bypass_hook_trust` still apply.

**Data flow**: Creates a temporary config manager with a `StaticThreadConfigLoader` containing a `SessionThreadConfig`, calls `load_with_overrides` with request override JSON and default typed overrides, then asserts the resulting config uses provider id `session`, the session provider definition, disabled plugins from session config, and enabled `bypass_hook_trust` from request overrides.

**Call relations**: Async integration-style test for `ConfigManager` behavior as used by thread request processing.

*Call graph*: calls 3 internal fn (new, default, new); 11 external calls (new, from, new, new, default, assert!, assert_eq!, default, default, json! (+1 more)).


##### `thread_processor_behavior_tests::collect_resume_override_mismatches_includes_service_tier`  (lines 733–788)

```
fn collect_resume_override_mismatches_includes_service_tier()
```

**Purpose**: Ensures resume mismatch reporting includes `service_tier` differences between the resume request and active thread config snapshot. This helps explain why a resume request cannot exactly reproduce prior settings.

**Data flow**: Constructs a `ThreadResumeParams` with requested `service_tier` and a `ThreadConfigSnapshot` with a different active tier, calls `collect_resume_override_mismatches`, and asserts the returned vector contains the expected mismatch string.

**Call relations**: Regression test for mismatch-report completeness in resume validation.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, test_path_buf).


##### `thread_processor_behavior_tests::test_thread_metadata`  (lines 790–806)

```
fn test_thread_metadata(
        model: Option<&str>,
        reasoning_effort: Option<ReasoningEffort>,
    ) -> Result<ThreadMetadata>
```

**Purpose**: Helper that builds a minimally populated `ThreadMetadata` with configurable model and reasoning effort. It standardizes metadata fixtures for summary and resume-merge tests.

**Data flow**: Parses a fixed `ThreadId`, initializes `ThreadMetadataBuilder` with rollout path and current time, sets `model_provider`, builds metadata with fallback provider `mock_provider`, then overwrites `model` and `reasoning_effort` from arguments before returning it.

**Call relations**: Shared fixture constructor used by multiple tests that need realistic persisted thread metadata.

*Call graph*: calls 2 internal fn (from_string, new); 3 external calls (from, now, default).


##### `thread_processor_behavior_tests::summary_from_thread_metadata_formats_protocol_timestamps_as_seconds`  (lines 809–822)

```
fn summary_from_thread_metadata_formats_protocol_timestamps_as_seconds() -> Result<()>
```

**Purpose**: Checks that summaries derived from protocol `ThreadMetadata` truncate timestamps to whole seconds. This intentionally differs from the stored-thread summary path.

**Data flow**: Builds metadata with `test_thread_metadata`, overwrites `created_at` and `updated_at` with millisecond timestamps, calls `summary_from_thread_metadata`, and asserts the resulting strings omit fractional seconds.

**Call relations**: Documents the protocol-facing timestamp normalization rule for metadata summaries.

*Call graph*: 3 external calls (parse_from_rfc3339, test_thread_metadata, assert_eq!).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_prefers_persisted_model_and_reasoning_effort`  (lines 825–854)

```
fn merge_persisted_resume_metadata_prefers_persisted_model_and_reasoning_effort() -> Result<()>
```

**Purpose**: Verifies persisted metadata fills in missing resume overrides for model, provider, and reasoning effort. The reasoning effort is inserted into the request-overrides map under `model_reasoning_effort`.

**Data flow**: Starts with empty request and typed overrides, builds persisted metadata containing model and high reasoning effort, calls `merge_persisted_resume_metadata`, and asserts typed overrides now contain model/provider while request overrides contain `model_reasoning_effort: "high"`.

**Call relations**: Covers the defaulting branch where persisted resume metadata is adopted because the caller supplied no explicit override.

*Call graph*: 3 external calls (test_thread_metadata, assert_eq!, default).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_preserves_explicit_overrides`  (lines 857–885)

```
fn merge_persisted_resume_metadata_preserves_explicit_overrides() -> Result<()>
```

**Purpose**: Ensures explicit request or typed overrides are not overwritten by persisted metadata. The test covers both model and reasoning effort already being set by the caller.

**Data flow**: Initializes request overrides with `model_reasoning_effort = low` and typed overrides with model `gpt-5.2-codex`, merges persisted metadata containing different values, and asserts the explicit values remain unchanged while provider stays unset.

**Call relations**: Regression test for override precedence during thread resume.

*Call graph*: 5 external calls (default, from, test_thread_metadata, assert_eq!, String).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_persisted_values_when_model_overridden`  (lines 888–914)

```
fn merge_persisted_resume_metadata_skips_persisted_values_when_model_overridden() -> Result<()>
```

**Purpose**: Checks that a request-level `model` override suppresses importing persisted model/provider/reasoning defaults. Persisted metadata should not partially leak in once model selection is explicit.

**Data flow**: Starts with request overrides containing `model`, empty typed overrides, merges persisted metadata, and asserts typed overrides remain empty and request overrides are unchanged.

**Call relations**: Covers the branch where explicit model selection blocks persisted resume defaults.

*Call graph*: 5 external calls (from, test_thread_metadata, assert_eq!, default, String).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_persisted_values_when_provider_overridden`  (lines 917–937)

```
fn merge_persisted_resume_metadata_skips_persisted_values_when_provider_overridden() -> Result<()>
```

**Purpose**: Ensures an explicit typed `model_provider` override prevents persisted model/provider defaults from being applied. This avoids mixing a persisted model with a caller-selected provider.

**Data flow**: Starts with typed overrides containing `model_provider = oss`, merges persisted metadata, and asserts provider remains `oss` while model stays unset and no request overrides are added.

**Call relations**: Another precedence test for resume metadata merging.

*Call graph*: 3 external calls (default, test_thread_metadata, assert_eq!).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_persisted_values_when_reasoning_effort_overridden`  (lines 940–966)

```
fn merge_persisted_resume_metadata_skips_persisted_values_when_reasoning_effort_overridden() -> Result<()>
```

**Purpose**: Checks that an explicit request override for reasoning effort prevents persisted reasoning effort from being inserted. Persisted model/provider are also skipped in this scenario.

**Data flow**: Initializes request overrides with `model_reasoning_effort = low`, merges persisted metadata containing model and high effort, and asserts no typed overrides are added and the request override remains unchanged.

**Call relations**: Covers the reasoning-effort precedence branch in resume metadata merging.

*Call graph*: 5 external calls (from, test_thread_metadata, assert_eq!, default, String).


##### `thread_processor_behavior_tests::merge_persisted_resume_metadata_skips_missing_values`  (lines 969–988)

```
fn merge_persisted_resume_metadata_skips_missing_values() -> Result<()>
```

**Purpose**: Verifies merge behavior when persisted metadata lacks model and reasoning effort. Only the persisted provider is propagated into typed overrides.

**Data flow**: Starts with empty overrides, builds metadata with no model/effort, merges it, and asserts `model` stays `None`, `model_provider` becomes `mock_provider`, and request overrides remain `None`.

**Call relations**: Documents partial propagation semantics for sparse persisted metadata.

*Call graph*: 3 external calls (test_thread_metadata, assert_eq!, default).


##### `thread_processor_behavior_tests::read_summary_from_rollout_returns_empty_preview_when_no_user_message`  (lines 991–1044)

```
async fn read_summary_from_rollout_returns_empty_preview_when_no_user_message() -> Result<()>
```

**Purpose**: Checks that rollout summary extraction falls back to an empty preview when the rollout contains only session metadata and no user message. It also verifies `updated_at` comes from file modification time when available.

**Data flow**: Creates a temp rollout file containing one serialized `RolloutLine::SessionMeta`, sets the file mtime to the same parsed timestamp, calls `read_summary_from_rollout`, and compares the full `ConversationSummary` to an expected struct with empty preview and fallback provider.

**Call relations**: Async file-based regression test for the no-preview fallback path in summary extraction.

*Call graph*: calls 2 internal fn (default, from_string); 10 external calls (new, new, new, new, assert_eq!, parse_from_rfc3339, format!, write, SessionMeta, new).


##### `thread_processor_behavior_tests::read_summary_from_rollout_preserves_agent_nickname`  (lines 1047–1094)

```
async fn read_summary_from_rollout_preserves_agent_nickname() -> Result<()>
```

**Purpose**: Verifies agent nickname and role survive rollout summary extraction and conversion back into an API `Thread`. It also confirms `thread_source` is not inferred from the summary path.

**Data flow**: Writes a rollout containing `SessionMeta` with `SessionSource::SubAgent(ThreadSpawn)` plus top-level `agent_nickname` and `agent_role`, reads a `ConversationSummary`, converts it with `summary_to_thread`, and asserts nickname/role are preserved while `thread_source` is `None`.

**Call relations**: Covers the interaction between summary extraction and `with_thread_spawn_agent_metadata`/`summary_to_thread` behavior.

*Call graph*: calls 3 internal fn (default, from_string, from_absolute_path); 6 external calls (new, SubAgent, assert_eq!, format!, write, SessionMeta).


##### `thread_processor_behavior_tests::read_summary_from_rollout_preserves_forked_from_id`  (lines 1097–1132)

```
async fn read_summary_from_rollout_preserves_forked_from_id() -> Result<()>
```

**Purpose**: Checks that rollout session metadata retains `forked_from_id` and that it can be read back directly. This guards against losing fork lineage in persisted rollout headers.

**Data flow**: Writes a rollout file whose `SessionMeta` includes `forked_from_id`, then calls the local helper `forked_from_id_from_rollout` and asserts it returns the expected thread id string.

**Call relations**: Async metadata-preservation test focused specifically on fork ancestry.

*Call graph*: calls 2 internal fn (default, from_string); 5 external calls (new, assert_eq!, format!, write, SessionMeta).


##### `thread_processor_behavior_tests::aborting_pending_request_clears_pending_state`  (lines 1135–1196)

```
async fn aborting_pending_request_clears_pending_state() -> Result<()>
```

**Purpose**: Verifies that aborting pending server requests for a thread resolves the waiting client callback with a structured turn-transition error and removes pending-request bookkeeping. It also confirms no extra outgoing messages are emitted during cleanup.

**Data flow**: Creates an `OutgoingMessageSender`, wraps it in `ThreadScopedOutgoingMessageSender`, sends a `ServerRequestPayload::ToolRequestUserInput`, calls `abort_pending_server_requests`, receives the originally sent outgoing request from the channel, awaits the callback receiver for the aborted response, and asserts the error payload and empty pending-request set.

**Call relations**: Integration-style async test for outgoing request lifecycle cleanup when thread state changes invalidate pending client prompts.

*Call graph*: calls 4 internal fn (disabled, new, new, from_string); 7 external calls (new, ToolRequestUserInput, assert!, assert_eq!, panic!, channel, vec!).


##### `thread_processor_behavior_tests::summary_from_state_db_metadata_preserves_agent_nickname`  (lines 1199–1235)

```
fn summary_from_state_db_metadata_preserves_agent_nickname() -> Result<()>
```

**Purpose**: Checks that summaries reconstructed from state-db metadata preserve agent nickname and role through `summary_to_thread`. This mirrors the rollout-based preservation test for the database-backed path.

**Data flow**: Builds a summary with `summary_from_state_db_metadata` using serialized `SessionSource::SubAgent(ThreadSpawn)` and explicit nickname/role, converts it with `summary_to_thread`, and asserts the resulting `Thread` carries those fields.

**Call relations**: Regression test for parity between rollout-derived and state-db-derived summary conversion.

*Call graph*: calls 2 internal fn (from_string, from_absolute_path); 4 external calls (from, SubAgent, assert_eq!, to_string).


##### `thread_processor_behavior_tests::removing_thread_state_clears_listener_and_active_turn_history`  (lines 1238–1279)

```
async fn removing_thread_state_clears_listener_and_active_turn_history() -> Result<()>
```

**Purpose**: Verifies removing a thread state cancels its listener task, drops subscriptions, and clears active-turn history. The test checks both the cancellation signal and the newly recreated empty state.

**Data flow**: Creates a `ThreadStateManager`, initializes and subscribes a connection, injects a `cancel_tx` and tracked `TurnStarted` event into the thread state, calls `remove_thread_state`, awaits the cancellation receiver, then fetches the thread state again and asserts no subscribers, no cancel handle, and no active turn snapshot remain.

**Call relations**: Async lifecycle test for full thread-state teardown.

*Call graph*: calls 2 internal fn (new, from_string); 6 external calls (default, default, assert!, assert_eq!, channel, TurnStarted).


##### `thread_processor_behavior_tests::removing_auto_attached_connection_preserves_listener_for_other_connections`  (lines 1282–1330)

```
async fn removing_auto_attached_connection_preserves_listener_for_other_connections() -> Result<()>
```

**Purpose**: Ensures removing one subscribed connection does not tear down the thread listener while another connection remains subscribed. The listener cancellation channel should stay unresolved.

**Data flow**: Creates a manager, initializes two connections, subscribes both to one thread, installs a `cancel_tx`, removes only `connection_a`, asserts no threads need unloading, checks the cancel receiver does not fire within a short timeout, and verifies `connection_b` remains subscribed.

**Call relations**: Covers partial-unsubscribe behavior in thread listener management.

*Call graph*: calls 2 internal fn (new, from_string); 4 external calls (default, assert!, assert_eq!, channel).


##### `thread_processor_behavior_tests::adding_connection_to_thread_updates_has_connections_watcher`  (lines 1333–1381)

```
async fn adding_connection_to_thread_updates_has_connections_watcher() -> Result<()>
```

**Purpose**: Checks that the per-thread `has_connections` watch channel flips false when the last subscriber leaves and back to true when another connection is added. This validates watcher continuity across subscriber churn.

**Data flow**: Initializes two connections, subscribes one, obtains a watch receiver from `subscribe_to_has_connections`, unsubscribes the first connection and waits for `changed()`, then adds the second connection and waits for another `changed()`, asserting the watched boolean transitions false then true.

**Call relations**: Async test for the thread-state watch mechanism used by listener/background lifecycle code.

*Call graph*: calls 2 internal fn (new, from_string); 4 external calls (from_secs, default, assert!, timeout).


##### `thread_processor_behavior_tests::closed_connection_cannot_be_reintroduced_by_auto_subscribe`  (lines 1384–1405)

```
async fn closed_connection_cannot_be_reintroduced_by_auto_subscribe() -> Result<()>
```

**Purpose**: Ensures a connection removed from the manager cannot later be auto-subscribed back onto a thread. This prevents stale closed connections from reappearing in subscriber sets.

**Data flow**: Initializes a connection, removes it, asserts no threads unload, then attempts `try_ensure_connection_subscribed` and checks it returns `None` and leaves the thread without subscribers.

**Call relations**: Regression test for connection-liveness checks in auto-subscribe paths.

*Call graph*: calls 2 internal fn (new, from_string); 3 external calls (default, assert!, assert_eq!).


##### `thread_processor_behavior_tests::first_attestation_capable_connection_for_thread_only_uses_thread_subscribers`  (lines 1408–1480)

```
async fn first_attestation_capable_connection_for_thread_only_uses_thread_subscribers() -> Result<()>
```

**Purpose**: Verifies attestation-capable connection selection is scoped to subscribers of the target thread and returns the earliest attestation-capable subscriber for that thread. Unrelated threads and unsupported subscribers must be ignored.

**Data flow**: Initializes four connections with varying `ConnectionCapabilities`, subscribes them across two threads in a specific order, then queries `first_attestation_capable_connection_for_thread` for each thread and asserts the expected connection ids.

**Call relations**: Async test for attestation routing logic used when a thread needs a capable client connection.

*Call graph*: calls 2 internal fn (new, from_string); 3 external calls (default, assert!, assert_eq!).


### `app-server/src/request_processors/thread_summary_tests.rs`

`test` · `test-time validation of summary preview extraction`

This file contains a single targeted test for `extract_conversation_summary`. It constructs a synthetic rollout head as raw JSON values rather than writing a file: the first entry is session metadata, the second is a user message containing AGENTS.md instruction boilerplate, and the third is another user message prefixed with `USER_MESSAGE_BEGIN` followed by the actual prompt text. The test deserializes the first JSON object into `SessionMeta`, calls `extract_conversation_summary`, and asserts the resulting `ConversationSummary` uses `Count to 5` as the preview.

The important behavior being pinned down is that preview extraction should prefer the plain user-facing message content after stripping the synthetic prefix marker, rather than surfacing setup/instruction text from earlier user-message-shaped items. The expected summary also checks that timestamp, updated_at, path, provider, cwd, cli version, source, and absent git info are preserved exactly. Because this file isolates one subtle preview-selection rule, it serves as a compact regression guard for thread-list UI quality.

#### Function details

##### `extract_conversation_summary_prefers_plain_user_messages`  (lines 9–68)

```
fn extract_conversation_summary_prefers_plain_user_messages() -> Result<()>
```

**Purpose**: Verifies that summary preview extraction chooses the plain user prompt content and strips the `USER_MESSAGE_BEGIN` marker, instead of surfacing AGENTS.md instruction text. It asserts the full resulting `ConversationSummary` value.

**Data flow**: Builds a `conversation_id`, timestamp, path, and a JSON `head` vector containing session metadata plus two user messages; deserializes `SessionMeta` from `head[0]`; calls `extract_conversation_summary`; and compares the returned summary to an expected struct whose preview is `Count to 5`.

**Call relations**: Executed by the test harness as a focused regression test for `thread_summary::extract_conversation_summary`.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (from, assert_eq!, vec!).


### Shared fixture primitives
These reusable helpers create the mock auth state, config files, cached models, canned responses, rollout data, and fake backend services that integration tests build on.

### `app-server/tests/common/analytics_server.rs`

`test` · `test setup`

This small test helper encapsulates the boilerplate for creating a `wiremock::MockServer` that behaves like the analytics ingestion service expected by the app-server. The single async function starts an ephemeral mock server, installs one mock expectation, and returns the running server to the caller.

The configured mock matches only `POST` requests whose path is exactly `/codex/analytics-events/events`. When such a request arrives, it responds with `ResponseTemplate::new(200)`, meaning tests can point analytics clients at this server without needing to inspect or validate request bodies unless they choose to add more mocks themselves. Because the helper returns the `MockServer`, callers can still query its URI, mount additional expectations, or inspect received requests using `wiremock` APIs.

The design is intentionally minimal: it does not assert headers, payload shape, or call counts. Its purpose is to provide a permissive success endpoint so integration tests involving analytics emission can proceed without external network dependencies or flaky infrastructure.

#### Function details

##### `start_analytics_events_server`  (lines 8–16)

```
async fn start_analytics_events_server() -> Result<MockServer>
```

**Purpose**: Starts a mock analytics server and mounts a single success response for the analytics events POST endpoint. It returns the running `MockServer` so tests can use its address.

**Data flow**: Asynchronously starts `MockServer::start()`, builds a `wiremock::Mock` matching `method("POST")` and `path("/codex/analytics-events/events")`, configures it to respond with `ResponseTemplate::new(200)`, mounts it on the server, and returns `Ok(server)`. Errors can propagate through the `anyhow::Result` return type.

**Call relations**: Used by integration tests that need analytics submissions to succeed without contacting a real backend. It delegates all HTTP matching and response behavior to `wiremock` primitives.

*Call graph*: 5 external calls (given, start, new, method, path).


### `app-server/tests/common/auth_fixtures.rs`

`test` · `test fixture construction and auth setup`

This test-support module models the subset of ChatGPT auth state that app-server tests care about. `ChatGptAuthFixture` is a builder for the full persisted auth payload: access token, refresh token, optional account ID, structured ID-token claims, and an optional `last_refresh` override. Its fluent setters mutate and return `Self`, making tests concise when they need only one or two custom fields. `ChatGptIdTokenClaims` is a smaller builder for the JWT claims embedded in the fake ID token, covering `email`, `plan_type`, `chatgpt_user_id`, and `chatgpt_account_id`.

`encode_id_token` turns those claims into a syntactically valid unsigned JWT string. It constructs a header `{ "alg": "none", "typ": "JWT" }`, builds a JSON payload with top-level `email` plus an OpenAI auth namespace object at `https://api.openai.com/auth` containing the ChatGPT-specific claims, base64url-encodes header/payload/signature using `URL_SAFE_NO_PAD`, and joins the three segments with dots. The helper intentionally emits only claims that are present, so tests can simulate missing metadata.

`write_chatgpt_auth` is the bridge to the real auth persistence path. It encodes and then parses the synthetic ID token via `parse_chatgpt_jwt_claims`, assembles `TokenData`, chooses `last_refresh` from the fixture or defaults to `Some(Utc::now())`, builds a `codex_login::AuthDotJson` with `auth_mode: Some(AuthMode::Chatgpt)` and all non-ChatGPT credential fields unset, and finally calls `save_auth` with the requested `AuthCredentialsStoreMode` and default keyring backend. This means tests exercise the same on-disk auth format and parsing logic as production code rather than bypassing it.

#### Function details

##### `ChatGptAuthFixture::new`  (lines 29–37)

```
fn new(access_token: impl Into<String>) -> Self
```

**Purpose**: Creates a baseline ChatGPT auth fixture with a caller-supplied access token and sensible defaults for all other fields. It is the starting point for fluent test customization.

**Data flow**: Accepts `access_token: impl Into<String>`, converts it into a `String`, sets `refresh_token` to `"refresh-token"`, `account_id` to `None`, `claims` to `ChatGptIdTokenClaims::default()`, `last_refresh` to `None`, and returns the populated `ChatGptAuthFixture`.

**Call relations**: Used widely by integration tests that need fake ChatGPT auth state. Tests typically chain the builder setters defined below before passing the fixture to `write_chatgpt_auth`.

*Call graph*: called by 100 (get_auth_status_omits_token_after_permanent_refresh_failure, get_auth_status_omits_token_after_proactive_refresh_failure, get_auth_status_returns_token_after_proactive_refresh_recovery, get_account_omits_chatgpt_after_permanent_refresh_failure, get_account_with_chatgpt, get_account_with_chatgpt_missing_plan_claim_returns_unknown, mount_analytics_capture, list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_patches_updates_from_cached_snapshots (+15 more)); 2 external calls (into, default).


##### `ChatGptAuthFixture::refresh_token`  (lines 39–42)

```
fn refresh_token(mut self, refresh_token: impl Into<String>) -> Self
```

**Purpose**: Overrides the fixture’s refresh token in builder style. It lets tests simulate different refresh-token values or missing/invalid token scenarios upstream.

**Data flow**: Consumes `self` and `refresh_token: impl Into<String>`, converts the argument, writes it into `self.refresh_token`, and returns the updated fixture.

**Call relations**: Called by tests that need non-default refresh-token contents before persisting auth. It is one step in the fluent fixture-building chain.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::account_id`  (lines 44–47)

```
fn account_id(mut self, account_id: impl Into<String>) -> Self
```

**Purpose**: Sets the optional account ID stored alongside the tokens in the fixture. This allows tests to control account association independently of JWT claims.

**Data flow**: Consumes `self` and `account_id: impl Into<String>`, converts the value, stores `Some(...)` in `self.account_id`, and returns the updated fixture.

**Call relations**: Used by tests that need persisted account IDs in `TokenData`. It complements the claim-level `chatgpt_account_id` setter, which affects the ID token instead.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::plan_type`  (lines 49–52)

```
fn plan_type(mut self, plan_type: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT plan type claim inside the fixture’s ID-token claims. It is a convenience wrapper over mutating `self.claims.plan_type`.

**Data flow**: Consumes `self` and `plan_type: impl Into<String>`, converts the value, stores `Some(...)` in `self.claims.plan_type`, and returns the updated fixture.

**Call relations**: Used by tests that need account/plan metadata to appear in parsed JWT claims. It participates in the fluent builder chain before `encode_id_token` consumes the claims.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::chatgpt_user_id`  (lines 54–57)

```
fn chatgpt_user_id(mut self, chatgpt_user_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT user ID claim inside the fixture’s ID-token claims. This lets tests control user identity metadata extracted from the token.

**Data flow**: Consumes `self` and `chatgpt_user_id: impl Into<String>`, converts it, stores `Some(...)` in `self.claims.chatgpt_user_id`, and returns the updated fixture.

**Call relations**: Used by tests that need parsed ChatGPT user IDs. It is another fluent convenience around the nested claims struct.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::chatgpt_account_id`  (lines 59–62)

```
fn chatgpt_account_id(mut self, chatgpt_account_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT account ID claim inside the fixture’s ID-token claims. It controls the token-derived account identifier rather than the persisted token-data field.

**Data flow**: Consumes `self` and `chatgpt_account_id: impl Into<String>`, converts it, stores `Some(...)` in `self.claims.chatgpt_account_id`, and returns the updated fixture.

**Call relations**: Used by tests that need the JWT to carry account metadata. It is distinct from `ChatGptAuthFixture::account_id`, which sets `TokenData.account_id` directly.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::email`  (lines 64–67)

```
fn email(mut self, email: impl Into<String>) -> Self
```

**Purpose**: Sets the email claim inside the fixture’s ID-token claims. This allows tests to simulate authenticated identities with or without email metadata.

**Data flow**: Consumes `self` and `email: impl Into<String>`, converts it, stores `Some(...)` in `self.claims.email`, and returns the updated fixture.

**Call relations**: Used by tests that inspect account identity derived from JWT claims. It is part of the fluent fixture builder.

*Call graph*: 1 external calls (into).


##### `ChatGptAuthFixture::last_refresh`  (lines 69–72)

```
fn last_refresh(mut self, last_refresh: Option<DateTime<Utc>>) -> Self
```

**Purpose**: Overrides the fixture’s `last_refresh` field, including the ability to set it explicitly to `None`. This lets tests model fresh, stale, or absent refresh timestamps.

**Data flow**: Consumes `self` and `last_refresh: Option<DateTime<Utc>>`, wraps it in `Some(last_refresh)` to distinguish explicit override from defaulting, stores it in `self.last_refresh`, and returns the updated fixture.

**Call relations**: Used by tests that need precise control over refresh timing semantics before persisting auth. `write_chatgpt_auth` later interprets `None` in this wrapper as “use current time” only when no override was supplied.


##### `ChatGptAuthFixture::claims`  (lines 74–77)

```
fn claims(mut self, claims: ChatGptIdTokenClaims) -> Self
```

**Purpose**: Replaces the entire nested ID-token claims struct in one step. It is useful when tests build claims separately with `ChatGptIdTokenClaims`.

**Data flow**: Consumes `self` and a `ChatGptIdTokenClaims`, assigns it to `self.claims`, and returns the updated fixture. No other fields are changed.

**Call relations**: Used by tests that prefer constructing claims via the dedicated claims builder and then injecting them wholesale. It bypasses the individual convenience setters.


##### `ChatGptIdTokenClaims::new`  (lines 89–91)

```
fn new() -> Self
```

**Purpose**: Creates an empty claims builder with all optional fields unset. It is the starting point for fluent claim construction.

**Data flow**: Returns `Self::default()`, producing a `ChatGptIdTokenClaims` with all fields `None`. No inputs or side effects.

**Call relations**: Used by tests that want to build claim sets independently of `ChatGptAuthFixture`. The resulting claims are later consumed by `encode_id_token` or inserted into a fixture via `claims`.

*Call graph*: called by 8 (account_read_refresh_token_is_noop_in_external_mode, external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized, login_account_chatgpt_device_code_succeeds_and_notifies, set_auth_token_cancels_active_chatgpt_login, set_auth_token_updates_account_and_notifies); 1 external calls (default).


##### `ChatGptIdTokenClaims::email`  (lines 93–96)

```
fn email(mut self, email: impl Into<String>) -> Self
```

**Purpose**: Sets the email claim in builder style. It supports concise construction of token claims for tests.

**Data flow**: Consumes `self` and `email: impl Into<String>`, converts and stores `Some(...)` in `self.email`, then returns the updated claims struct.

**Call relations**: Used in fluent claim-building chains before the claims are encoded into a JWT or attached to a fixture.

*Call graph*: 1 external calls (into).


##### `ChatGptIdTokenClaims::plan_type`  (lines 98–101)

```
fn plan_type(mut self, plan_type: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT plan type claim in builder style. It controls the `chatgpt_plan_type` value placed under the OpenAI auth namespace.

**Data flow**: Consumes `self` and `plan_type: impl Into<String>`, converts and stores `Some(...)` in `self.plan_type`, then returns the updated claims struct.

**Call relations**: Used by tests that need plan metadata in the parsed ID token. It feeds directly into `encode_id_token`’s payload construction.

*Call graph*: 1 external calls (into).


##### `ChatGptIdTokenClaims::chatgpt_user_id`  (lines 103–106)

```
fn chatgpt_user_id(mut self, chatgpt_user_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT user ID claim in builder style. It controls one of the namespaced auth claims encoded into the fake JWT.

**Data flow**: Consumes `self` and `chatgpt_user_id: impl Into<String>`, converts and stores `Some(...)` in `self.chatgpt_user_id`, then returns the updated claims struct.

**Call relations**: Used by tests that need token-derived user identity. It is consumed later by `encode_id_token`.

*Call graph*: 1 external calls (into).


##### `ChatGptIdTokenClaims::chatgpt_account_id`  (lines 108–111)

```
fn chatgpt_account_id(mut self, chatgpt_account_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT account ID claim in builder style. It controls the namespaced account identifier encoded into the fake JWT.

**Data flow**: Consumes `self` and `chatgpt_account_id: impl Into<String>`, converts and stores `Some(...)` in `self.chatgpt_account_id`, then returns the updated claims struct.

**Call relations**: Used by tests that need token-derived account metadata. It contributes to the payload assembled by `encode_id_token`.

*Call graph*: 1 external calls (into).


##### `encode_id_token`  (lines 114–144)

```
fn encode_id_token(claims: &ChatGptIdTokenClaims) -> Result<String>
```

**Purpose**: Builds a syntactically valid unsigned JWT string from the provided ChatGPT ID-token claims. It is the core helper that turns structured test claims into the raw token format consumed by production parsing code.

**Data flow**: Accepts `&ChatGptIdTokenClaims`. It creates a JSON header with `alg: none` and `typ: JWT`, builds a mutable payload map containing optional top-level `email` and an optional nested object at `https://api.openai.com/auth` with `chatgpt_plan_type`, `chatgpt_user_id`, and `chatgpt_account_id` when present, serializes header and payload to bytes with `serde_json::to_vec`, base64url-encodes them plus a fixed `b"signature"` using `URL_SAFE_NO_PAD`, and returns `Ok(format!("{header}.{payload}.{signature}"))`. Serialization failures are wrapped with `anyhow::Context`.

**Call relations**: Called by `write_chatgpt_auth` before parsing the token back through production claim parsing. It intentionally mirrors JWT structure closely enough for `parse_chatgpt_jwt_claims` to consume it.

*Call graph*: called by 1 (write_chatgpt_auth); 5 external calls (format!, json!, new, Object, to_vec).


##### `write_chatgpt_auth`  (lines 146–179)

```
fn write_chatgpt_auth(
    codex_home: &Path,
    fixture: ChatGptAuthFixture,
    cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
) -> Result<()>
```

**Purpose**: Persists a complete fake ChatGPT auth configuration into the test Codex home directory using the real auth-writing path. It bridges fixture builders to on-disk state consumed by integration tests.

**Data flow**: Accepts `codex_home: &Path`, a `ChatGptAuthFixture`, and an `AuthCredentialsStoreMode`. It calls `encode_id_token(&fixture.claims)` to get a raw JWT, parses it with `parse_chatgpt_jwt_claims`, builds `TokenData` from the parsed ID token plus fixture access/refresh/account fields, resolves `last_refresh` from `fixture.last_refresh` or defaults to `Some(Utc::now())`, constructs an `AuthDotJson` with `auth_mode: Some(AuthMode::Chatgpt)` and all unrelated credential fields `None`, then calls `save_auth(codex_home, &auth, cli_auth_credentials_store_mode, AuthKeyringBackendKind::default())`. Errors are propagated with contextual messages.

**Call relations**: Used by integration tests to seed realistic auth state before exercising account/auth flows. It deliberately routes through production parsing and persistence helpers (`parse_chatgpt_jwt_claims`, `save_auth`) so tests cover the same formats and code paths as the real application.

*Call graph*: calls 3 internal fn (encode_id_token, default, parse_chatgpt_jwt_claims); 1 external calls (save_auth).


### `app-server/tests/common/config.rs`

`config` · `test setup`

This file contains two concrete config writers used by integration tests to materialize a minimal but valid `config.toml` in a temporary Codex home directory. The main helper assembles the file in three explicit phases: it first converts a `BTreeMap<Feature, bool>` into TOML entries under `[features]` by looking up each feature’s stable config key in the global `FEATURES` registry and panicking if a feature lacks a key; it then builds a provider block for `[model_providers.<id>]`, choosing the provider display name and optionally emitting `requires_openai_auth = true`; finally it writes a full config containing fixed test defaults such as `model = "mock-model"`, `approval_policy = "never"`, `sandbox_mode = "read-only"`, `wire_api = "responses"`, and retry counts of zero. A special case emits `openai_base_url` when the provider id is literally `openai`, matching code paths that still consult that legacy top-level setting. The second helper is a narrower variant for tests that need `chatgpt_base_url` present while still routing model traffic to a mock provider. Both functions overwrite `config.toml` directly and return plain `std::io::Result<()>`, leaving parsing/validation to the server under test.

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

**Purpose**: Writes a complete test `config.toml` that selects a mock model provider backed by a supplied mock server URI, with configurable feature flags, compaction limit, provider id, and optional OpenAI-auth requirement.

**Data flow**: It takes the target CODEX_HOME path, mock server base URI, a `BTreeMap<Feature, bool>`, numeric auto-compact limit, optional `requires_openai_auth`, provider id, and compact prompt text. It copies the feature map into a local sorted map, resolves each `Feature` to its TOML key via `FEATURES`, formats the `[features]` entries, derives provider-specific lines such as `requires_openai_auth` and optional top-level `openai_base_url`, then writes the assembled TOML string to `codex_home/config.toml`.

**Call relations**: This helper is invoked by tests that need a realistic app-server configuration without hand-authoring TOML. It does not delegate to other local helpers; instead it directly performs the full config assembly and final filesystem write in one place.

*Call graph*: 6 external calls (new, join, new, format!, matches!, write).


##### `write_mock_responses_config_toml_with_chatgpt_base_url`  (lines 82–108)

```
fn write_mock_responses_config_toml_with_chatgpt_base_url(
    codex_home: &Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a smaller test `config.toml` variant that includes `chatgpt_base_url` while still configuring a mock Responses provider.

**Data flow**: It receives the CODEX_HOME path, mock server URI, and a ChatGPT base URL string. It joins `config.toml` onto the home directory, interpolates those values into a fixed TOML template with `model_provider = "mock_provider"` and a single `[model_providers.mock_provider]` block, and writes the resulting text to disk.

**Call relations**: Tests use this variant when they specifically need the ChatGPT base URL setting present. Unlike the more general writer, it skips feature blocks and auth-condition logic and goes straight to formatting and writing the file.

*Call graph*: 3 external calls (join, format!, write).


### `app-server/tests/common/mock_model_server.rs`

`io_transport` · `test setup and mocked request handling`

This file builds lightweight HTTP servers that mimic the `/v1/responses` endpoint expected by the app server. The sequence-based helpers start a mock server from `core_test_support::responses::start_mock_server`, then mount a `wiremock::Mock` matching `POST` requests whose path ends in `/responses`. The response behavior is implemented by the local `SeqResponder`, which stores a `Vec<String>` of prebuilt SSE bodies and an `AtomicUsize` call counter. Its `Respond` implementation increments the counter with `Ordering::SeqCst`, indexes into the vector by call number, and panics if a request arrives after the supplied sequence is exhausted; this makes over-consumption visible in tests. One constructor also sets `.expect(num_calls as u64)` so wiremock verifies the exact number of requests, while the `_unchecked` variant omits that expectation for tests where extra or fewer calls are acceptable. The repeating-assistant helper skips the custom responder entirely: it constructs a single SSE transcript containing `response_created`, one assistant message, and `completed`, then mounts that same body for every matching request. All helpers return the running `MockServer`, allowing tests to inject its URI into config fixtures.

#### Function details

##### `create_mock_responses_server_sequence`  (lines 14–31)

```
async fn create_mock_responses_server_sequence(responses: Vec<String>) -> MockServer
```

**Purpose**: Starts a mock HTTP server that serves the provided SSE response bodies in order and asserts that exactly that many `/responses` calls occur.

**Data flow**: It takes a `Vec<String>` of prebuilt response bodies, starts a mock server, records `responses.len()` as the expected call count, wraps the vector and a zeroed `AtomicUsize` in `SeqResponder`, mounts a POST `/responses` mock using that responder, and returns the configured `MockServer`.

**Call relations**: Tests call this when they need deterministic multi-turn or multi-request model behavior and want wiremock to fail if the app server under- or over-calls the endpoint. It delegates per-request body selection to `SeqResponder::respond`.

*Call graph*: calls 1 internal fn (start_mock_server); 4 external calls (new, given, method, path_regex).


##### `create_mock_responses_server_sequence_unchecked`  (lines 35–50)

```
async fn create_mock_responses_server_sequence_unchecked(responses: Vec<String>) -> MockServer
```

**Purpose**: Starts the same sequential mock Responses server but without enforcing an exact request count.

**Data flow**: It accepts a vector of SSE bodies, starts a mock server, constructs `SeqResponder` with an atomic call counter and the supplied responses, mounts the POST `/responses` mock, and returns the server. Unlike the checked variant, it does not attach a wiremock `.expect(...)` constraint.

**Call relations**: This is used by tests that still need ordered responses but do not want wiremock’s request-count assertion. It shares the same responder implementation as the checked constructor, so exhausting the sequence still panics inside `SeqResponder::respond`.

*Call graph*: calls 1 internal fn (start_mock_server); 4 external calls (new, given, method, path_regex).


##### `SeqResponder::respond`  (lines 58–65)

```
fn respond(&self, _: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Selects the next response body from the stored sequence and wraps it as an SSE HTTP response template.

**Data flow**: On each incoming request, it atomically increments `num_calls` and uses the previous value as an index into `self.responses`. It expects that element to exist, clones the selected `String`, converts it with `responses::sse_response`, and returns the resulting `ResponseTemplate`.

**Call relations**: Wiremock invokes this method for each matched POST `/responses` request mounted by the sequence server constructors. It is the core sequencing mechanism those helpers rely on to turn a static vector into stateful per-call behavior.

*Call graph*: calls 1 internal fn (sse_response); 1 external calls (fetch_add).


##### `create_mock_responses_server_repeating_assistant`  (lines 69–82)

```
async fn create_mock_responses_server_repeating_assistant(message: &str) -> MockServer
```

**Purpose**: Starts a mock Responses server that always returns the same assistant message transcript for every request.

**Data flow**: It takes a message string, starts a mock server, builds one SSE body containing `response_created`, `assistant_message`, and `completed` events, mounts that body as the response for POST requests ending in `/responses`, and returns the server.

**Call relations**: Tests use this simpler helper when they only care that every model call yields the same assistant output. It bypasses `SeqResponder` and delegates SSE formatting to `core_test_support::responses` helpers.

*Call graph*: calls 3 internal fn (sse, sse_response, start_mock_server); 4 external calls (given, vec!, method, path_regex).


### `app-server/tests/common/models_cache.rs`

`config` · `test setup`

This file exists to short-circuit model discovery during integration tests. The private `preset_to_info` function maps a `codex_protocol::openai_models::ModelPreset` into a fully populated `ModelInfo`, filling in many fields with deterministic test defaults rather than leaving them absent. It preserves preset-derived identity and picker metadata such as `slug`, `display_name`, reasoning effort settings, service tiers, upgrade info, and visibility, while hard-coding values like `shell_type = ConfigShellToolType::ShellCommand`, `base_instructions = "base instructions"`, `supports_reasoning_summaries = false`, `truncation_policy = TruncationPolicyConfig::bytes(10_000)`, `context_window = Some(272_000)`, and `effective_context_window_percent = 95`. `write_models_cache` pulls the stable bundled preset list from `all_model_presets()`, filters to `show_in_picker`, assigns ascending integer priorities based on list order, converts each preset, and forwards to the writer. `write_models_cache_with_models` then serializes a cache object containing `fetched_at` as current UTC time, `etag: null`, the whole client version from `client_version_to_whole()`, and the supplied models, writing pretty-printed JSON to `models_cache.json` under the provided CODEX_HOME. The freshness timestamp is intentional: tests want the cache treated as current so no network fetch occurs.

#### Function details

##### `preset_to_info`  (lines 16–61)

```
fn preset_to_info(preset: &ModelPreset, priority: i32) -> ModelInfo
```

**Purpose**: Transforms one bundled `ModelPreset` into the richer `ModelInfo` structure used in the persisted models cache.

**Data flow**: It reads fields from a borrowed `ModelPreset` plus an explicit `priority` integer, clones or maps those preset values into a new `ModelInfo`, fills all remaining fields with fixed defaults or empty collections, and returns the constructed `ModelInfo` by value.

**Call relations**: This is an internal conversion step used by `write_models_cache` while building a cache from bundled presets. It does not perform I/O; its sole role is to normalize preset data into the cache schema expected downstream.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 2 external calls (default, new).


##### `write_models_cache`  (lines 67–86)

```
fn write_models_cache(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Builds a fresh `models_cache.json` from the bundled catalog’s picker-visible presets and writes it into the test CODEX_HOME.

**Data flow**: It takes the CODEX_HOME path, reads all bundled presets via `all_model_presets()`, filters to those with `show_in_picker`, enumerates them to assign ascending priorities, converts each with `preset_to_info`, collects the resulting `Vec<ModelInfo>`, and passes that vector to `write_models_cache_with_models`.

**Call relations**: Tests call this when they want a realistic default model catalog without hand-specifying models. It is a convenience wrapper over `write_models_cache_with_models`, supplying the model list derived from bundled presets.

*Call graph*: calls 2 internal fn (write_models_cache_with_models, all_model_presets).


##### `write_models_cache_with_models`  (lines 90–105)

```
fn write_models_cache_with_models(
    codex_home: &Path,
    models: Vec<ModelInfo>,
) -> std::io::Result<()>
```

**Purpose**: Serializes an explicit list of `ModelInfo` entries into the on-disk cache file format used by model-loading code.

**Data flow**: It accepts the CODEX_HOME path and a `Vec<ModelInfo>`, computes `models_cache.json` under that directory, captures `Utc::now()` as `fetched_at`, reads the current whole client version, builds a JSON object with `fetched_at`, `etag`, `client_version`, and `models`, pretty-prints it, and writes the resulting string to disk.

**Call relations**: This function is the final I/O sink for both custom-model tests and the higher-level `write_models_cache` wrapper. It centralizes the exact cache schema and freshness metadata so all tests produce the same file shape.

*Call graph*: called by 1 (write_models_cache); 6 external calls (join, now, client_version_to_whole, json!, to_string_pretty, write).


### `app-server/tests/common/responses.rs`

`util` · `test setup`

This helper module produces serialized server-sent event bodies, not parsed protocol structs. Each function returns an `anyhow::Result<String>` containing a complete SSE stream assembled with `core_test_support::responses::sse(...)`. The streams all follow the same high-level shape: a `response_created` event, one synthetic payload event representing either an assistant message or a tool/function call, and a terminal `completed` event. The shell-command helper is careful about argument encoding: it joins a `Vec<String>` command into a shell-escaped string with `shlex::try_join`, then embeds that plus optional `workdir` and `timeout_ms` into a JSON object serialized as the tool call’s `arguments` string. The exec-command helper intentionally emits a different schema (`cmd` and `yield_time_ms`) and chooses a platform-specific command line using `cfg!(windows)` so tests remain portable. The remaining builders hard-code representative payloads for apply-patch, request-user-input, and request-permissions flows, including nested question/option and filesystem permission structures. Because these helpers return raw SSE text, they are composable with the mock server utilities that simply replay supplied strings over HTTP.

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

**Purpose**: Builds an SSE transcript that asks the client to execute the `shell_command` tool with a shell-escaped command string and optional working directory and timeout.

**Data flow**: It takes a command vector, optional `&Path` workdir, optional timeout in milliseconds, and a tool call id. It shell-joins the command parts, serializes a JSON arguments object containing `command`, `workdir`, and `timeout_ms`, wraps that in `response_created` → `function_call(shell_command)` → `completed` events, and returns the final SSE string.

**Call relations**: Tests use this helper when they want the mock model to trigger the app server’s shell-command tool path. It delegates event formatting to `core_test_support::responses` and propagates failures from shell joining or JSON serialization.

*Call graph*: calls 1 internal fn (sse); 4 external calls (json!, to_string, try_join, vec!).


##### `create_final_assistant_message_sse_response`  (lines 25–31)

```
fn create_final_assistant_message_sse_response(message: &str) -> anyhow::Result<String>
```

**Purpose**: Builds an SSE transcript containing a single final assistant message.

**Data flow**: It accepts a message string, creates three events—response created, assistant message with fixed ids, and completed—and returns the serialized SSE body.

**Call relations**: This is the simplest response fixture and is commonly paired with mock model servers when tests only need a normal assistant completion rather than a tool call.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `create_apply_patch_sse_response`  (lines 33–42)

```
fn create_apply_patch_sse_response(
    patch_content: &str,
    call_id: &str,
) -> anyhow::Result<String>
```

**Purpose**: Builds an SSE transcript that requests an apply-patch shell command via the heredoc-based helper event.

**Data flow**: It takes patch content and a tool call id, creates an event sequence with `response_created`, `ev_apply_patch_shell_command_call_via_heredoc`, and `completed`, and returns the serialized SSE string.

**Call relations**: Tests use this to drive patch-application flows through the app server. It relies on the shared responses helper to encode the specialized apply-patch event shape.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `create_exec_command_sse_response`  (lines 44–62)

```
fn create_exec_command_sse_response(call_id: &str) -> anyhow::Result<String>
```

**Purpose**: Builds an SSE transcript that invokes the legacy `exec_command` tool with a portable demo command.

**Data flow**: It takes a tool call id, chooses either `cmd.exe /d /c echo hi` on Windows or `/bin/sh -c echo hi` elsewhere, collects those pieces into a command vector, serializes a JSON arguments object with `cmd` and `yield_time_ms: 500`, wraps it in response-created/function-call/completed events, and returns the SSE body.

**Call relations**: This helper is used by tests covering the `exec_command` tool path and intentionally hides platform differences behind `cfg!(windows)` so assertions can remain stable across OSes.

*Call graph*: calls 1 internal fn (sse); 5 external calls (cfg!, json!, to_string, once, vec!).


##### `create_request_user_input_sse_response`  (lines 64–85)

```
fn create_request_user_input_sse_response(call_id: &str) -> anyhow::Result<String>
```

**Purpose**: Builds an SSE transcript that asks the client to answer a structured `request_user_input` prompt.

**Data flow**: It takes a tool call id, serializes a fixed JSON payload containing one question with id `confirm_path`, header `Confirm`, prompt text, and two labeled options, then emits that payload as a `function_call(request_user_input)` between response-created and completed events.

**Call relations**: Tests use this fixture to exercise interactive user-input request handling. The function hard-codes a representative nested schema so callers do not need to construct the JSON manually.

*Call graph*: calls 1 internal fn (sse); 3 external calls (json!, to_string, vec!).


##### `create_request_permissions_sse_response`  (lines 87–105)

```
fn create_request_permissions_sse_response(call_id: &str) -> anyhow::Result<String>
```

**Purpose**: Builds an SSE transcript that asks the client for filesystem write permissions via the `request_permissions` tool.

**Data flow**: It takes a tool call id, serializes a fixed JSON object with a reason string and a `permissions.file_system.write` array containing `.` and `../shared`, wraps it in response-created/function-call/completed events, and returns the SSE string.

**Call relations**: This helper supports tests around permission escalation and approval UX. Like the user-input helper, it centralizes a realistic nested payload shape so mock model setup stays concise.

*Call graph*: calls 1 internal fn (sse); 3 external calls (json!, to_string, vec!).


### `app-server/tests/common/rollout.rs`

`io_transport` · `test setup and persisted-session fixture creation`

This module writes realistic rollout files in the directory layout the app server expects: `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread>.jsonl`. `rollout_path` derives that path directly from the filename timestamp string by slicing year, month, and day components. The public constructors are layered wrappers around a single internal writer, `create_fake_rollout_with_source_and_parent_thread_id`, which generates a fresh UUID, converts it into a `ThreadId`, creates parent directories, builds a `SessionMeta` and `SessionMetaLine`, and writes three JSONL records: a `session_meta` envelope, a `response_item` representing the initial user message, and an `event_msg` of type `user_message`. The helper also parses the RFC3339 timestamp and sets the file’s modified time to match, which matters for code paths that sort or filter sessions by filesystem metadata. Variants expose different knobs: `create_fake_rollout` defaults `SessionSource::Cli`; `create_fake_parented_rollout_with_source` injects `parent_thread_id`; `create_fake_rollout_with_token_usage` appends a fourth `event_msg` carrying a nontrivial `TokenCountEvent` so resume/fork tests can verify replay of total vs. last usage counters; and `create_fake_rollout_with_text_elements` writes a custom `text_elements` array and `local_images: []` in the user-message event. All functions return the generated thread/session UUID string for later requests.

#### Function details

##### `rollout_path`  (lines 18–28)

```
fn rollout_path(codex_home: &Path, filename_ts: &str, thread_id: &str) -> PathBuf
```

**Purpose**: Computes the canonical rollout JSONL path for a given CODEX_HOME, filename timestamp, and thread id.

**Data flow**: It takes the home directory, a timestamp string in `YYYY-MM-DDThh-mm-ss` filename form, and a thread id string. It slices year/month/day substrings from the timestamp and joins them into `codex_home/sessions/<year>/<month>/<day>/rollout-<timestamp>-<thread_id>.jsonl`, returning that `PathBuf`.

**Call relations**: The internal rollout writer and the token-usage appender both call this helper so path derivation stays consistent. It is pure path construction with no filesystem access.

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

**Purpose**: Creates a minimal rollout file using `SessionSource::Cli` and no parent thread id.

**Data flow**: It accepts CODEX_HOME, filename timestamp, RFC3339 metadata timestamp, preview text, optional model provider, and optional `GitInfo`. It forwards those values plus `SessionSource::Cli` to `create_fake_rollout_with_source` and returns the generated thread id string.

**Call relations**: This is the simplest public entry point for tests that only need a basic persisted session. `create_fake_rollout_with_token_usage` builds on it before appending an extra token-count event.

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

**Purpose**: Creates a minimal rollout and then appends a persisted token-usage event with deliberately asymmetric counters.

**Data flow**: It takes CODEX_HOME, filename timestamp, RFC3339 timestamp, preview text, and optional model provider. It first creates the base rollout via `create_fake_rollout`, then constructs an `EventMsg::TokenCount(TokenCountEvent)` containing `TokenUsageInfo` with distinct `total_token_usage` and `last_token_usage` values plus `model_context_window`, serializes that payload, reads the existing rollout file, appends a new JSONL line with the same timestamp and `type: "event_msg"`, writes the combined contents back, and returns the thread id.

**Call relations**: Resume and fork tests call this variant when they need replayable usage state already persisted on disk. It depends on `create_fake_rollout` for the initial file and `rollout_path` to reopen the same file for appending.

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

**Purpose**: Creates a minimal rollout while allowing the caller to choose the `SessionSource` recorded in session metadata.

**Data flow**: It receives the same inputs as `create_fake_rollout` plus a `SessionSource`, forwards them to `create_fake_rollout_with_source_and_parent_thread_id` with `parent_thread_id` set to `None`, and returns the generated thread id.

**Call relations**: This is a thin wrapper used by `create_fake_rollout` and by tests that care about source-specific behavior but not parentage. The actual file creation is delegated to the internal writer.

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

**Purpose**: Creates a minimal rollout with both an explicit `SessionSource` and an explicit parent thread id.

**Data flow**: It takes CODEX_HOME, timestamps, preview text, optional model provider, optional `GitInfo`, a `SessionSource`, and a `ThreadId` parent. It forwards all of that to `create_fake_rollout_with_source_and_parent_thread_id` with `Some(parent_thread_id)` and returns the generated child thread id.

**Call relations**: Tests that verify fork lineage or parent-child thread relationships use this wrapper. It exists to expose parent-thread control without duplicating the JSONL-writing logic.

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

**Purpose**: Implements the actual rollout fixture writer: generates ids, creates directories, writes the JSONL records, and aligns file modification time with the supplied timestamp.

**Data flow**: It takes CODEX_HOME, filename timestamp, RFC3339 timestamp, preview text, optional model provider, optional `GitInfo`, a `SessionSource`, and an optional parent `ThreadId`. It generates a UUID, converts it to a `ThreadId`, computes the rollout path, creates parent directories, builds a `SessionMeta` and `SessionMetaLine`, serializes three JSON lines (`session_meta`, initial user `response_item`, and `event_msg` user_message), writes them to the file, parses the RFC3339 timestamp into UTC, sets the file’s modified time via `FileTimes`, and returns the UUID string.

**Call relations**: Both `create_fake_rollout_with_source` and `create_fake_parented_rollout_with_source` funnel into this function, making it the central implementation for most rollout fixtures. It also relies on `rollout_path` so naming and directory layout match the app server’s expectations.

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

**Purpose**: Creates a rollout whose user-message event includes caller-supplied `text_elements` and an empty `local_images` array.

**Data flow**: It takes CODEX_HOME, timestamps, preview text, a `Vec<serde_json::Value>` of text elements, optional model provider, and optional `GitInfo`. It generates a UUID and `ThreadId`, manually derives the `sessions/YYYY/MM/DD` directory from the filename timestamp, creates that directory, builds `SessionMeta` with `SessionSource::Cli`, serializes three JSONL lines similar to the main writer but with `text_elements` embedded in the `event_msg` payload, writes the file, and returns the UUID string.

**Call relations**: Tests use this specialized variant when they need richer user-message payloads than the standard plain-text rollout helper provides. It duplicates some of the internal writer’s logic rather than delegating, because the event payload shape differs.

*Call graph*: calls 1 internal fn (from_string); 8 external calls (join, from, new_v4, format!, create_dir_all, write, json!, to_value).


### Integration harness facade
This layer assembles the shared fixtures into the exported support surface and the process-level app-server harness used by the integration suites.

### `app-server/tests/common/lib.rs`

`orchestration` · `cross-cutting test support`

This module is the public surface of the `tests/common` support package. Its main job is organization: it declares the internal helper modules (`analytics_server`, `auth_fixtures`, `config`, `mock_model_server`, `models_cache`, `responses`, `rollout`, `test_app_server`) and then re-exports the pieces that test files actually consume, so suites can depend on a single `app_test_support` namespace instead of importing each helper module directly. The exports cover auth fixtures and token encoding, config writers, temporary-path helpers from `core_test_support`, mock Responses API servers, model-cache writers, SSE response constructors, rollout/session fixture builders, and the `TestAppServer` process harness plus a few constants. The only local behavior is `to_response`, a small deserialization bridge for JSON-RPC responses: tests often receive a `JSONRPCResponse` whose `result` field is an untyped JSON value, and this helper converts that payload into a concrete protocol response type implementing `DeserializeOwned`. That keeps test bodies concise and centralizes the two-step serde conversion pattern used throughout the suite.

#### Function details

##### `to_response`  (lines 51–55)

```
fn to_response(response: JSONRPCResponse) -> anyhow::Result<T>
```

**Purpose**: Converts a `JSONRPCResponse`’s untyped `result` payload into a concrete response struct requested by the caller.

**Data flow**: It takes ownership of a `JSONRPCResponse`, serializes `response.result` into a generic `serde_json::Value`, then deserializes that value into type parameter `T: DeserializeOwned`. On success it returns `Ok(T)`; any serialization or deserialization failure is propagated as `anyhow::Error`.

**Call relations**: Many integration tests call this immediately after `TestAppServer` returns a JSON-RPC response, using it as the final decoding step from transport-level protocol objects into typed assertions. It delegates entirely to serde conversion functions and contains no protocol branching of its own.

*Call graph*: 2 external calls (from_value, to_value).


### `app-server/tests/common/test_app_server.rs`

`orchestration` · `entire integration-test run`

This is the central process-and-protocol driver used by the app-server test suite. `TestAppServer` owns a spawned Tokio `Child`, optional piped stdin, buffered stdout reader, an atomic integer request-id counter, and a `VecDeque<JSONRPCMessage>` used to buffer out-of-order messages while waiting for a specific response or notification. Construction flows through layered helpers: convenience constructors choose whether managed config is disabled, whether plugin startup tasks run, whether extra env vars or CLI args are injected, and optionally which executable path to launch. The core constructor configures `CODEX_HOME`, `RUST_LOG`, an isolated managed-config path under the temp home, removes the internal originator override env var, pipes stdio, spawns the process with `kill_on_drop(true)`, and forwards child stderr lines to the test process’s stderr for visibility.

On the protocol side, `initialize*` performs the JSON-RPC handshake and sends the `initialized` notification after validating the response id. The many `send_*_request` methods are thin typed wrappers that serialize params and call the shared `send_request`, which increments `next_request_id`, builds a `JSONRPCRequest`, and writes newline-delimited JSON. Reading is more sophisticated: `read_stream_until_message` first searches buffered messages, then keeps reading stdout until a predicate matches, buffering everything else. Specialized readers unwrap requests, responses, errors, or notifications and validate shape. `interrupt_turn_and_wait_for_aborted` handles races where a terminal `turn/completed` notification may already be buffered before the interrupt response arrives. Finally, `Drop` performs bounded synchronous cleanup—close stdin, poll for graceful exit, then kill and poll again—to reduce flaky leaked-child reports in test runners.

#### Function details

##### `TestAppServer::wait_for_exit`  (lines 134–136)

```
async fn wait_for_exit(&mut self) -> std::io::Result<ExitStatus>
```

**Purpose**: Waits asynchronously for the spawned app-server child process to exit and returns its `ExitStatus`.

**Data flow**: It reads the `process` field, awaits `Child::wait()`, and returns the resulting `std::io::Result<ExitStatus>` without modifying other harness state.

**Call relations**: Tests call this when they intentionally expect the server process to terminate. It is a direct wrapper over the child-process wait primitive.

*Call graph*: 1 external calls (wait).


##### `TestAppServer::new`  (lines 138–140)

```
async fn new(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Starts `codex-app-server` with the standard test defaults, including disabling plugin startup tasks.

**Data flow**: It takes a CODEX_HOME path and forwards it with no env overrides and the single `DISABLE_PLUGIN_STARTUP_TASKS_ARG` CLI argument to `new_with_env_and_args`, returning the constructed harness.

**Call relations**: This is the default constructor used by many integration tests. It delegates all actual process setup to `new_with_env_and_args`.

*Call graph*: called by 417 (get_auth_status_with_api_key, get_auth_status_with_api_key_no_include_token, get_auth_status_with_api_key_refresh_requested, get_auth_status_with_api_key_when_auth_not_required, login_api_key_rejected_when_forced_chatgpt, get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home, get_conversation_summary_by_thread_id_reads_rollout, initialized_mcp, test_fuzzy_file_search_accepts_cancellation_token, test_fuzzy_file_search_sorts_and_includes_indices (+15 more)); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_without_managed_config`  (lines 142–144)

```
async fn new_without_managed_config(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Starts the server while forcing managed configuration off for the child process.

**Data flow**: It takes CODEX_HOME and calls `new_with_env` with `CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG=1`, returning the resulting harness.

**Call relations**: Tests that need isolation from managed-config behavior use this convenience constructor. It layers one fixed env override on top of the standard startup path.

*Call graph*: called by 19 (list_apps_returns_empty_when_workspace_codex_plugins_disabled, experimental_feature_list_marks_apps_and_plugins_disabled_by_workspace_policy, experimental_feature_list_resolves_thread_project_config, skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled, thread_fork_tracks_thread_initialized_analytics, thread_goal_get_rejects_unmaterialized_thread, thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal, thread_goal_set_edits_objective_without_resetting_usage, thread_goal_set_persists_resumable_stopped_statuses, thread_goal_set_preserves_budget_limited_same_objective (+9 more)); 1 external calls (new_with_env).


##### `TestAppServer::new_without_managed_config_with_env`  (lines 146–153)

```
async fn new_without_managed_config_with_env(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with managed config disabled plus additional caller-specified environment overrides.

**Data flow**: It takes CODEX_HOME and a slice of `(key, Option<value>)` overrides, prepends the managed-config-disable pair to a local vector, extends it with the caller’s overrides, and passes the combined slice to `new_with_env`.

**Call relations**: This is a convenience wrapper for tests that need both managed-config isolation and custom environment shaping. It delegates process creation to `new_with_env`.

*Call graph*: called by 2 (plugin_list_returns_empty_when_workspace_codex_plugins_disabled, plugin_list_reuses_cached_workspace_codex_plugins_setting); 2 external calls (new_with_env, vec!).


##### `TestAppServer::new_with_plugin_startup_tasks`  (lines 155–157)

```
async fn new_with_plugin_startup_tasks(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Starts the server without suppressing plugin startup tasks.

**Data flow**: It takes CODEX_HOME and forwards empty env overrides and an empty args list to `new_with_env_and_args`, returning the harness.

**Call relations**: Tests covering plugin startup behavior use this constructor instead of the default `new`, which disables those tasks.

*Call graph*: called by 1 (plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_with_env_and_plugin_startup_tasks`  (lines 159–164)

```
async fn new_with_env_and_plugin_startup_tasks(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with caller-provided environment overrides and plugin startup tasks enabled.

**Data flow**: It takes CODEX_HOME and env overrides, then calls `new_with_env_and_args` with those overrides and no extra CLI args.

**Call relations**: This combines the custom-env and plugin-startup-enabled variants into one convenience entry point.

*Call graph*: called by 1 (app_server_startup_sync_downloads_remote_installed_plugin_bundles); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_with_args`  (lines 166–170)

```
async fn new_with_args(codex_home: &Path, args: &[&str]) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with additional CLI arguments while still including the default plugin-startup suppression flag.

**Data flow**: It takes CODEX_HOME and a slice of extra args, prepends `DISABLE_PLUGIN_STARTUP_TASKS_ARG` into a local vector, appends the caller args, and forwards the combined list to `new_with_env_and_args`.

**Call relations**: Tests use this when they need to exercise command-line switches but still want the usual plugin-startup behavior disabled.

*Call graph*: called by 4 (plugin_install_returns_invalid_request_for_disallowed_product_plugin, listen_off_exits_without_persisted_remote_control_enable, listen_off_honors_persisted_remote_control_enable, listen_off_ignores_persisted_enable_when_disabled_by_requirements); 2 external calls (new_with_env_and_args, vec!).


##### `TestAppServer::new_with_env`  (lines 177–187)

```
async fn new_with_env(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts the server with caller-specified environment overrides and the standard plugin-startup suppression flag.

**Data flow**: It takes CODEX_HOME and env overrides, then forwards them plus `[DISABLE_PLUGIN_STARTUP_TASKS_ARG]` to `new_with_env_and_args`.

**Call relations**: This is the main constructor for tests that need to set or remove environment variables in the child process.

*Call graph*: called by 83 (get_auth_status_no_auth, get_auth_status_omits_token_after_permanent_refresh_failure, get_auth_status_omits_token_after_proactive_refresh_failure, get_auth_status_returns_token_after_proactive_refresh_recovery, get_auth_status_with_personal_access_token_omits_token, account_read_refresh_token_is_noop_in_external_mode, external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized (+15 more)); 1 external calls (new_with_env_and_args).


##### `TestAppServer::new_with_program_and_env`  (lines 189–201)

```
async fn new_with_program_and_env(
        codex_home: &Path,
        program: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts a caller-specified executable path instead of the default cargo-built `codex-app-server`, while applying env overrides and default test args.

**Data flow**: It takes CODEX_HOME, a program path, and env overrides, then forwards them plus `[DISABLE_PLUGIN_STARTUP_TASKS_ARG]` to `new_with_program_env_and_args`.

**Call relations**: Specialized tests use this to launch alternate binaries or wrappers while reusing the same JSON-RPC harness.

*Call graph*: called by 1 (create_zsh_test_mcp_process); 1 external calls (new_with_program_env_and_args).


##### `TestAppServer::new_with_env_and_args`  (lines 203–211)

```
async fn new_with_env_and_args(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
        args: &[&str],
    ) -> anyhow::Result<Self>
```

**Purpose**: Resolves the `codex-app-server` binary path from Cargo and starts it with explicit env overrides and CLI args.

**Data flow**: It takes CODEX_HOME, env overrides, and args, resolves the executable path via `codex_utils_cargo_bin::cargo_bin("codex-app-server")`, adds context if lookup fails, and passes everything to `new_with_program_env_and_args`.

**Call relations**: Most public constructors funnel through this helper. It separates binary discovery from the lower-level process-spawn logic.

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

**Purpose**: Performs the actual child-process setup: configures stdio, environment, working directory, stderr forwarding, and initializes harness state.

**Data flow**: It takes CODEX_HOME, an executable path, env overrides, and args. It builds a `tokio::process::Command`, pipes stdin/stdout/stderr, sets current dir and key env vars (`CODEX_HOME`, `RUST_LOG`, isolated managed-config path), removes the internal originator override env var, applies args and per-key overrides/removals, spawns the child with `kill_on_drop(true)`, extracts stdin and stdout handles, wraps stdout in `BufReader`, spawns a background task to echo child stderr lines to test stderr, and returns a `TestAppServer` with `next_request_id` zeroed and an empty pending-message deque.

**Call relations**: All constructors ultimately delegate here. It is the only place that touches process-launch details and establishes the transport channels later used by send/read helpers.

*Call graph*: 8 external calls (new, new, join, piped, new, new, eprintln!, spawn).


##### `TestAppServer::initialize`  (lines 280–292)

```
async fn initialize(&mut self) -> anyhow::Result<()>
```

**Purpose**: Runs the standard initialize handshake using a default client identity and asserts that the result is a JSON-RPC response rather than an error.

**Data flow**: It constructs a `ClientInfo` with `DEFAULT_CLIENT_NAME`, title `None`, and version `0.1.0`, passes it to `initialize_with_client_info`, checks that the returned `JSONRPCMessage` is `Response`, and returns `Ok(())`.

**Call relations**: Most tests call this immediately after constructing the harness. It delegates the actual handshake to `initialize_with_client_info` and panics only if the returned message shape is impossible under its own expectations.

*Call graph*: calls 1 internal fn (initialize_with_client_info); 1 external calls (unreachable!).


##### `TestAppServer::initialize_with_client_info`  (lines 295–307)

```
async fn initialize_with_client_info(
        &mut self,
        client_info: ClientInfo,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Runs initialize using caller-supplied client metadata and default capabilities that enable the experimental API.

**Data flow**: It takes a `ClientInfo`, wraps it in `InitializeParams` together with `Some(InitializeCapabilities { experimental_api: true, ..Default::default() })`, and forwards to `initialize_with_capabilities`.

**Call relations**: This is the customizable variant behind `initialize`. It exists for tests that need to vary client identity while keeping the usual capability set.

*Call graph*: calls 1 internal fn (initialize_with_capabilities); called by 1 (initialize); 1 external calls (default).


##### `TestAppServer::initialize_with_capabilities`  (lines 309–319)

```
async fn initialize_with_capabilities(
        &mut self,
        client_info: ClientInfo,
        capabilities: Option<InitializeCapabilities>,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Runs initialize with explicit client info and optional capability set.

**Data flow**: It takes a `ClientInfo` and optional `InitializeCapabilities`, packages them into `InitializeParams`, and forwards to `initialize_with_params`.

**Call relations**: This is the last typed wrapper before the raw initialize request is sent.

*Call graph*: calls 1 internal fn (initialize_with_params); called by 1 (initialize_with_client_info).


##### `TestAppServer::initialize_with_params`  (lines 321–361)

```
async fn initialize_with_params(
        &mut self,
        params: InitializeParams,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Sends the `initialize` request, validates the matching response or error id, and sends the `initialized` notification on success.

**Data flow**: It takes `InitializeParams`, serializes them to `serde_json::Value`, sends a request with method `initialize`, reads one JSON-RPC message from stdout, and matches on its variant. For a `Response`, it verifies the id equals the sent integer request id, sends `ClientNotification::Initialized`, and returns the response wrapped as `JSONRPCMessage`; for an `Error`, it verifies the id and returns it; for `Notification` or `Request`, it bails with an error.

**Call relations**: All initialize entry points delegate here. It is the only place that performs the full handshake sequencing and id validation.

*Call graph*: calls 3 internal fn (read_jsonrpc_message, send_notification, send_request); called by 1 (initialize_with_capabilities); 5 external calls (bail!, Error, Response, Integer, to_value).


##### `TestAppServer::send_get_auth_status_request`  (lines 364–370)

```
async fn send_get_auth_status_request(
        &mut self,
        params: GetAuthStatusParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a typed `getAuthStatus` JSON-RPC request.

**Data flow**: It takes `GetAuthStatusParams`, serializes them to JSON, and forwards method name plus params to `send_request`, returning the numeric request id.

**Call relations**: Auth tests call this before waiting for a matching response with the generic stream readers.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_get_conversation_summary_request`  (lines 373–379)

```
async fn send_get_conversation_summary_request(
        &mut self,
        params: GetConversationSummaryParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a typed `getConversationSummary` request.

**Data flow**: It serializes `GetConversationSummaryParams` and passes them to `send_request`, returning the assigned request id.

**Call relations**: Tests that inspect persisted rollout summaries use this wrapper instead of constructing raw JSON manually.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_get_account_rate_limits_request`  (lines 382–385)

```
async fn send_get_account_rate_limits_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/rateLimits/read` with no params.

**Data flow**: It calls `send_request` with the fixed method name and `None` params, returning the request id.

**Call relations**: This is a no-payload convenience wrapper over the generic request sender.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_consume_account_rate_limit_reset_credit_request`  (lines 388–397)

```
async fn send_consume_account_rate_limit_reset_credit_request(
        &mut self,
        params: ConsumeAccountRateLimitResetCreditParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/rateLimitResetCredit/consume` with typed params.

**Data flow**: It serializes `ConsumeAccountRateLimitResetCreditParams`, sends the request, and returns the request id.

**Call relations**: Higher-level test helpers call this when exercising reset-credit consumption flows.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_consume_reset_credit); 1 external calls (to_value).


##### `TestAppServer::send_add_credits_nudge_email_request`  (lines 400–407)

```
async fn send_add_credits_nudge_email_request(
        &mut self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/sendAddCreditsNudgeEmail` with typed params.

**Data flow**: It serializes `SendAddCreditsNudgeEmailParams`, forwards them to `send_request`, and returns the request id.

**Call relations**: Used by tests covering account-related nudging behavior.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_get_account_request`  (lines 410–416)

```
async fn send_get_account_request(
        &mut self,
        params: GetAccountParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/read` with typed params.

**Data flow**: It serializes `GetAccountParams`, sends the request, and returns the request id.

**Call relations**: Provides a typed wrapper for account-read tests.

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

**Purpose**: Sends `account/login/start` using the `ChatgptAuthTokens` login variant.

**Data flow**: It takes an access token, ChatGPT account id, and optional plan type, constructs `LoginAccountParams::ChatgptAuthTokens`, serializes it, sends the request, and returns the request id.

**Call relations**: Tests use this when they want to simulate login via already-issued ChatGPT auth tokens rather than API key or device-code flows.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_feedback_upload_request`  (lines 435–441)

```
async fn send_feedback_upload_request(
        &mut self,
        params: FeedbackUploadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `feedback/upload` with typed params.

**Data flow**: It serializes `FeedbackUploadParams`, forwards them to `send_request`, and returns the request id.

**Call relations**: A straightforward typed request wrapper for feedback-upload tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_start_request`  (lines 444–450)

```
async fn send_thread_start_request(
        &mut self,
        params: ThreadStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/start` with typed params.

**Data flow**: It serializes `ThreadStartParams`, sends the request, and returns the request id.

**Call relations**: Many higher-level thread-start helpers in tests build on this low-level sender before waiting for responses and notifications.

*Call graph*: calls 1 internal fn (send_request); called by 9 (start_thread, start_thread, start_turn, start_plan_mode_turn, start_default_thread, start_thread, start_thread, start_thread, run_environment_selection_case); 1 external calls (to_value).


##### `TestAppServer::send_thread_resume_request`  (lines 453–459)

```
async fn send_thread_resume_request(
        &mut self,
        params: ThreadResumeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/resume` with typed params.

**Data flow**: It serializes `ThreadResumeParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that reopen persisted threads.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_fork_request`  (lines 462–468)

```
async fn send_thread_fork_request(
        &mut self,
        params: ThreadForkParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/fork` with typed params.

**Data flow**: It serializes `ThreadForkParams`, sends the request, and returns the request id.

**Call relations**: Fork-related test helpers call this before reading the corresponding response.

*Call graph*: calls 1 internal fn (send_request); called by 1 (fork_fake_rollout_thread); 1 external calls (to_value).


##### `TestAppServer::send_thread_archive_request`  (lines 471–477)

```
async fn send_thread_archive_request(
        &mut self,
        params: ThreadArchiveParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/archive` with typed params.

**Data flow**: It serializes `ThreadArchiveParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for archive operations.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_delete_request`  (lines 480–486)

```
async fn send_thread_delete_request(
        &mut self,
        params: ThreadDeleteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/delete` with typed params.

**Data flow**: It serializes `ThreadDeleteParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that verify deletion behavior.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_set_name_request`  (lines 489–495)

```
async fn send_thread_set_name_request(
        &mut self,
        params: ThreadSetNameParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/name/set` with typed params.

**Data flow**: It serializes `ThreadSetNameParams`, sends the request, and returns the request id.

**Call relations**: Supports tests around thread naming.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_metadata_update_request`  (lines 498–504)

```
async fn send_thread_metadata_update_request(
        &mut self,
        params: ThreadMetadataUpdateParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/metadata/update` with typed params.

**Data flow**: It serializes `ThreadMetadataUpdateParams`, sends the request, and returns the request id.

**Call relations**: Used when tests need to mutate thread metadata.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_settings_update_request`  (lines 507–513)

```
async fn send_thread_settings_update_request(
        &mut self,
        params: ThreadSettingsUpdateParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/settings/update` with typed params.

**Data flow**: It serializes `ThreadSettingsUpdateParams`, sends the request, and returns the request id.

**Call relations**: Higher-level helpers use this to exercise settings updates.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_thread_settings_update); 1 external calls (to_value).


##### `TestAppServer::send_thread_unsubscribe_request`  (lines 516–522)

```
async fn send_thread_unsubscribe_request(
        &mut self,
        params: ThreadUnsubscribeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/unsubscribe` with typed params.

**Data flow**: It serializes `ThreadUnsubscribeParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for unsubscribe flows.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_unarchive_request`  (lines 525–531)

```
async fn send_thread_unarchive_request(
        &mut self,
        params: ThreadUnarchiveParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/unarchive` with typed params.

**Data flow**: It serializes `ThreadUnarchiveParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that restore archived threads.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_compact_start_request`  (lines 534–540)

```
async fn send_thread_compact_start_request(
        &mut self,
        params: ThreadCompactStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/compact/start` with typed params.

**Data flow**: It serializes `ThreadCompactStartParams`, sends the request, and returns the request id.

**Call relations**: Supports compaction-related tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_shell_command_request`  (lines 543–549)

```
async fn send_thread_shell_command_request(
        &mut self,
        params: ThreadShellCommandParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/shellCommand` with typed params.

**Data flow**: It serializes `ThreadShellCommandParams`, sends the request, and returns the request id.

**Call relations**: Used when tests invoke shell-command behavior through the thread API.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_rollback_request`  (lines 552–558)

```
async fn send_thread_rollback_request(
        &mut self,
        params: ThreadRollbackParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/rollback` with typed params.

**Data flow**: It serializes `ThreadRollbackParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for rollback tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_list_request`  (lines 561–567)

```
async fn send_thread_list_request(
        &mut self,
        params: ThreadListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/list` with typed params.

**Data flow**: It serializes `ThreadListParams`, sends the request, and returns the request id.

**Call relations**: List-thread helpers call this before reading and decoding the response.

*Call graph*: calls 1 internal fn (send_request); called by 3 (list_threads, list_threads_for_parent, list_threads_with_sort); 1 external calls (to_value).


##### `TestAppServer::send_thread_search_request`  (lines 570–576)

```
async fn send_thread_search_request(
        &mut self,
        params: ThreadSearchParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/search` with typed params.

**Data flow**: It serializes `ThreadSearchParams`, sends the request, and returns the request id.

**Call relations**: Used by tests covering thread search.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_loaded_list_request`  (lines 579–585)

```
async fn send_thread_loaded_list_request(
        &mut self,
        params: ThreadLoadedListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/loaded/list` with typed params.

**Data flow**: It serializes `ThreadLoadedListParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for loaded-thread listing.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_read_request`  (lines 588–594)

```
async fn send_thread_read_request(
        &mut self,
        params: ThreadReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/read` with typed params.

**Data flow**: It serializes `ThreadReadParams`, sends the request, and returns the request id.

**Call relations**: Read-thread helpers use this before waiting for the matching response.

*Call graph*: calls 1 internal fn (send_request); called by 1 (read_thread_with_turns); 1 external calls (to_value).


##### `TestAppServer::send_thread_turns_list_request`  (lines 597–603)

```
async fn send_thread_turns_list_request(
        &mut self,
        params: ThreadTurnsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/turns/list` with typed params.

**Data flow**: It serializes `ThreadTurnsListParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that inspect turn lists.

*Call graph*: calls 1 internal fn (send_request); called by 1 (read_single_turn_items_view); 1 external calls (to_value).


##### `TestAppServer::send_thread_turns_items_list_request`  (lines 606–612)

```
async fn send_thread_turns_items_list_request(
        &mut self,
        params: ThreadTurnsItemsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/turns/items/list` with typed params.

**Data flow**: It serializes `ThreadTurnsItemsListParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for turn-item listing.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_list_models_request`  (lines 615–621)

```
async fn send_list_models_request(
        &mut self,
        params: ModelListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `model/list` with typed params.

**Data flow**: It serializes `ModelListParams`, sends the request, and returns the request id.

**Call relations**: Used by model-listing tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_model_provider_capabilities_read_request`  (lines 624–631)

```
async fn send_model_provider_capabilities_read_request(
        &mut self,
        params: ModelProviderCapabilitiesReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `modelProvider/capabilities/read` with typed params.

**Data flow**: It serializes `ModelProviderCapabilitiesReadParams`, sends the request, and returns the request id.

**Call relations**: Supports tests that inspect provider capability metadata.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_experimental_feature_list_request`  (lines 634–640)

```
async fn send_experimental_feature_list_request(
        &mut self,
        params: ExperimentalFeatureListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `experimentalFeature/list` with typed params.

**Data flow**: It serializes `ExperimentalFeatureListParams`, sends the request, and returns the request id.

**Call relations**: Used by tests around experimental feature visibility.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_permission_profile_list_request`  (lines 643–649)

```
async fn send_permission_profile_list_request(
        &mut self,
        params: PermissionProfileListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `permissionProfile/list` with typed params.

**Data flow**: It serializes `PermissionProfileListParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for permission-profile listing.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_experimental_feature_enablement_set_request`  (lines 652–659)

```
async fn send_experimental_feature_enablement_set_request(
        &mut self,
        params: codex_app_server_protocol::ExperimentalFeatureEnablementSetParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `experimentalFeature/enablement/set` with typed params.

**Data flow**: It serializes `ExperimentalFeatureEnablementSetParams`, sends the request, and returns the request id.

**Call relations**: Higher-level helpers use this to toggle experimental features during tests.

*Call graph*: calls 1 internal fn (send_request); called by 1 (set_experimental_feature_enablement); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_enable_request`  (lines 662–665)

```
async fn send_remote_control_enable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/enable` with no params.

**Data flow**: It calls `send_request` with the fixed method and `None`, returning the request id.

**Call relations**: A convenience wrapper for persisted remote-control enablement.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_remote_control_ephemeral_enable_request`  (lines 668–674)

```
async fn send_remote_control_ephemeral_enable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/enable` with `{ "ephemeral": true }` to request runtime-only enablement.

**Data flow**: It constructs a small JSON object with `ephemeral: true`, sends it via `send_request`, and returns the request id.

**Call relations**: Used by tests that distinguish ephemeral from persisted remote-control state.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_remote_control_disable_request`  (lines 677–680)

```
async fn send_remote_control_disable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/disable` with no params.

**Data flow**: It calls `send_request` with the fixed method and no params, returning the request id.

**Call relations**: A convenience wrapper for persisted disablement.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_remote_control_ephemeral_disable_request`  (lines 683–689)

```
async fn send_remote_control_ephemeral_disable_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/disable` with `{ "ephemeral": true }` for runtime-only disablement.

**Data flow**: It constructs the ephemeral JSON payload, sends it, and returns the request id.

**Call relations**: Used by tests that verify temporary disable behavior.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_remote_control_status_read_request`  (lines 692–695)

```
async fn send_remote_control_status_read_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/status/read` with no params.

**Data flow**: It calls `send_request` with the fixed method and `None`, returning the request id.

**Call relations**: A no-payload wrapper for status reads.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_remote_control_pairing_start_request`  (lines 698–705)

```
async fn send_remote_control_pairing_start_request(
        &mut self,
        params: RemoteControlPairingStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/pairing/start` with typed params.

**Data flow**: It serializes `RemoteControlPairingStartParams`, sends the request, and returns the request id.

**Call relations**: Used by pairing-flow tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_pairing_status_request`  (lines 708–715)

```
async fn send_remote_control_pairing_status_request(
        &mut self,
        params: RemoteControlPairingStatusParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/pairing/status` with typed params.

**Data flow**: It serializes `RemoteControlPairingStatusParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for pairing-status polling.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_clients_list_request`  (lines 718–724)

```
async fn send_remote_control_clients_list_request(
        &mut self,
        params: RemoteControlClientsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/client/list` with typed params.

**Data flow**: It serializes `RemoteControlClientsListParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that inspect paired clients.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_remote_control_clients_revoke_request`  (lines 727–734)

```
async fn send_remote_control_clients_revoke_request(
        &mut self,
        params: RemoteControlClientsRevokeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `remoteControl/client/revoke` with typed params.

**Data flow**: It serializes `RemoteControlClientsRevokeParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for client revocation.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_apps_list_request`  (lines 737–740)

```
async fn send_apps_list_request(&mut self, params: AppsListParams) -> anyhow::Result<i64>
```

**Purpose**: Sends `app/list` with typed params.

**Data flow**: It serializes `AppsListParams`, sends the request, and returns the request id.

**Call relations**: Used directly and by cache-warming helpers that need to trigger app discovery.

*Call graph*: calls 1 internal fn (send_request); called by 1 (warm_app_directory_cache); 1 external calls (to_value).


##### `TestAppServer::send_mcp_resource_read_request`  (lines 743–749)

```
async fn send_mcp_resource_read_request(
        &mut self,
        params: McpResourceReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `mcpServer/resource/read` with typed params.

**Data flow**: It serializes `McpResourceReadParams`, sends the request, and returns the request id.

**Call relations**: Supports MCP resource-read tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_mcp_server_tool_call_request`  (lines 752–758)

```
async fn send_mcp_server_tool_call_request(
        &mut self,
        params: McpServerToolCallParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `mcpServer/tool/call` with typed params.

**Data flow**: It serializes `McpServerToolCallParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that invoke MCP tools through the server.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_skills_list_request`  (lines 761–767)

```
async fn send_skills_list_request(
        &mut self,
        params: SkillsListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `skills/list` with typed params.

**Data flow**: It serializes `SkillsListParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for skills listing.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_skills_extra_roots_set_request`  (lines 770–776)

```
async fn send_skills_extra_roots_set_request(
        &mut self,
        params: SkillsExtraRootsSetParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `skills/extraRoots/set` with typed params.

**Data flow**: It serializes `SkillsExtraRootsSetParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that alter skill search roots.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_hooks_list_request`  (lines 779–785)

```
async fn send_hooks_list_request(
        &mut self,
        params: HooksListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `hooks/list` with typed params.

**Data flow**: It serializes `HooksListParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for hook-listing tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_marketplace_add_request`  (lines 788–794)

```
async fn send_marketplace_add_request(
        &mut self,
        params: MarketplaceAddParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `marketplace/add` with typed params.

**Data flow**: It serializes `MarketplaceAddParams`, sends the request, and returns the request id.

**Call relations**: Used by marketplace-add tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_marketplace_remove_request`  (lines 797–803)

```
async fn send_marketplace_remove_request(
        &mut self,
        params: MarketplaceRemoveParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `marketplace/remove` with typed params.

**Data flow**: It serializes `MarketplaceRemoveParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for marketplace removal.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_marketplace_upgrade_request`  (lines 806–812)

```
async fn send_marketplace_upgrade_request(
        &mut self,
        params: MarketplaceUpgradeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `marketplace/upgrade` with typed params.

**Data flow**: It serializes `MarketplaceUpgradeParams`, sends the request, and returns the request id.

**Call relations**: Higher-level marketplace-upgrade helpers build on this sender.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_marketplace_upgrade); 1 external calls (to_value).


##### `TestAppServer::send_plugin_install_request`  (lines 815–821)

```
async fn send_plugin_install_request(
        &mut self,
        params: PluginInstallParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `plugin/install` with typed params.

**Data flow**: It serializes `PluginInstallParams`, sends the request, and returns the request id.

**Call relations**: Used directly and by remote-plugin-install helpers.

*Call graph*: calls 1 internal fn (send_request); called by 1 (send_remote_plugin_install_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_uninstall_request`  (lines 824–830)

```
async fn send_plugin_uninstall_request(
        &mut self,
        params: PluginUninstallParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `plugin/uninstall` with typed params.

**Data flow**: It serializes `PluginUninstallParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for uninstall tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_list_request`  (lines 833–839)

```
async fn send_plugin_list_request(
        &mut self,
        params: PluginListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `plugin/list` with typed params.

**Data flow**: It serializes `PluginListParams`, sends the request, and returns the request id.

**Call relations**: Used by plugin-listing tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_installed_request`  (lines 842–848)

```
async fn send_plugin_installed_request(
        &mut self,
        params: PluginInstalledParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `plugin/installed` with typed params.

**Data flow**: It serializes `PluginInstalledParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for installed-plugin queries.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_read_request`  (lines 851–857)

```
async fn send_plugin_read_request(
        &mut self,
        params: PluginReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `plugin/read` with typed params.

**Data flow**: It serializes `PluginReadParams`, sends the request, and returns the request id.

**Call relations**: Used by plugin-read tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_plugin_skill_read_request`  (lines 860–866)

```
async fn send_plugin_skill_read_request(
        &mut self,
        params: PluginSkillReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `plugin/skill/read` with typed params.

**Data flow**: It serializes `PluginSkillReadParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for plugin-skill reads.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_list_mcp_server_status_request`  (lines 869–875)

```
async fn send_list_mcp_server_status_request(
        &mut self,
        params: ListMcpServerStatusParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `mcpServerStatus/list` with typed params.

**Data flow**: It serializes `ListMcpServerStatusParams`, sends the request, and returns the request id.

**Call relations**: Higher-level helpers use this to inspect MCP server status names and metadata.

*Call graph*: calls 1 internal fn (send_request); called by 1 (mcp_server_names); 1 external calls (to_value).


##### `TestAppServer::send_raw_request`  (lines 878–884)

```
async fn send_raw_request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends an arbitrary JSON-RPC request method with caller-supplied raw params for protocol-level validation tests.

**Data flow**: It takes a method string and optional `serde_json::Value`, forwards them directly to `send_request`, and returns the request id.

**Call relations**: This bypasses typed protocol structs when tests intentionally want malformed or edge-case payloads.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_list_collaboration_modes_request`  (lines 886–892)

```
async fn send_list_collaboration_modes_request(
        &mut self,
        params: CollaborationModeListParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `collaborationMode/list` with typed params.

**Data flow**: It serializes `CollaborationModeListParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for collaboration-mode listing.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_mock_experimental_method_request`  (lines 895–901)

```
async fn send_mock_experimental_method_request(
        &mut self,
        params: MockExperimentalMethodParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `mock/experimentalMethod` with typed params.

**Data flow**: It serializes `MockExperimentalMethodParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that exercise experimental-method plumbing.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_memory_mode_set_request`  (lines 904–910)

```
async fn send_thread_memory_mode_set_request(
        &mut self,
        params: ThreadMemoryModeSetParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the experimental v2 `thread/memoryMode/set` request.

**Data flow**: It serializes `ThreadMemoryModeSetParams`, sends the request, and returns the request id.

**Call relations**: Supports tests around memory-mode changes.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_turn_start_request`  (lines 913–919)

```
async fn send_turn_start_request(
        &mut self,
        params: TurnStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `turn/start` request.

**Data flow**: It serializes `TurnStartParams`, sends the request, and returns the request id.

**Call relations**: Many turn-driving helpers call this before waiting for turn lifecycle notifications.

*Call graph*: calls 1 internal fn (send_request); called by 6 (send_turn_and_wait, start_turn, start_plan_mode_turn, materialize_thread_rollout, start_text_turn, run_environment_selection_case); 1 external calls (to_value).


##### `TestAppServer::send_thread_inject_items_request`  (lines 922–928)

```
async fn send_thread_inject_items_request(
        &mut self,
        params: ThreadInjectItemsParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `thread/inject_items` request.

**Data flow**: It serializes `ThreadInjectItemsParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that inject items into a thread.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_request`  (lines 931–937)

```
async fn send_command_exec_request(
        &mut self,
        params: CommandExecParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `command/exec` request.

**Data flow**: It serializes `CommandExecParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for command execution tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_spawn_request`  (lines 940–946)

```
async fn send_process_spawn_request(
        &mut self,
        params: ProcessSpawnParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `process/spawn` request.

**Data flow**: It serializes `ProcessSpawnParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that exercise lower-level process APIs.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_write_stdin_request`  (lines 949–955)

```
async fn send_process_write_stdin_request(
        &mut self,
        params: ProcessWriteStdinParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `process/writeStdin` request.

**Data flow**: It serializes `ProcessWriteStdinParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for writing to spawned processes.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_resize_pty_request`  (lines 958–964)

```
async fn send_process_resize_pty_request(
        &mut self,
        params: ProcessResizePtyParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `process/resizePty` request.

**Data flow**: It serializes `ProcessResizePtyParams`, sends the request, and returns the request id.

**Call relations**: Used by PTY-resize tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_process_kill_request`  (lines 967–973)

```
async fn send_process_kill_request(
        &mut self,
        params: ProcessKillParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `process/kill` request.

**Data flow**: It serializes `ProcessKillParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for process termination tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_write_request`  (lines 976–982)

```
async fn send_command_exec_write_request(
        &mut self,
        params: CommandExecWriteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `command/exec/write` request.

**Data flow**: It serializes `CommandExecWriteParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that stream input into command executions.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_resize_request`  (lines 985–991)

```
async fn send_command_exec_resize_request(
        &mut self,
        params: CommandExecResizeParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `command/exec/resize` request.

**Data flow**: It serializes `CommandExecResizeParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for command-exec PTY resizing.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_command_exec_terminate_request`  (lines 994–1000)

```
async fn send_command_exec_terminate_request(
        &mut self,
        params: CommandExecTerminateParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `command/exec/terminate` request.

**Data flow**: It serializes `CommandExecTerminateParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that terminate command executions.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_turn_interrupt_request`  (lines 1003–1009)

```
async fn send_turn_interrupt_request(
        &mut self,
        params: TurnInterruptParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `turn/interrupt` request.

**Data flow**: It serializes `TurnInterruptParams`, sends the request, and returns the request id.

**Call relations**: The cleanup helper `interrupt_turn_and_wait_for_aborted` uses this as its first step.

*Call graph*: calls 1 internal fn (send_request); called by 1 (interrupt_turn_and_wait_for_aborted); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_start_request`  (lines 1012–1018)

```
async fn send_thread_realtime_start_request(
        &mut self,
        params: ThreadRealtimeStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `thread/realtime/start` request.

**Data flow**: It serializes `ThreadRealtimeStartParams`, sends the request, and returns the request id.

**Call relations**: Used by realtime-session startup helpers.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_webrtc_realtime_with_codex_responses_as_items); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_append_audio_request`  (lines 1021–1028)

```
async fn send_thread_realtime_append_audio_request(
        &mut self,
        params: ThreadRealtimeAppendAudioParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `thread/realtime/appendAudio` request.

**Data flow**: It serializes `ThreadRealtimeAppendAudioParams`, sends the request, and returns the request id.

**Call relations**: Realtime append-audio helpers call this.

*Call graph*: calls 1 internal fn (send_request); called by 1 (append_audio); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_append_text_request`  (lines 1031–1038)

```
async fn send_thread_realtime_append_text_request(
        &mut self,
        params: ThreadRealtimeAppendTextParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `thread/realtime/appendText` request.

**Data flow**: It serializes `ThreadRealtimeAppendTextParams`, sends the request, and returns the request id.

**Call relations**: Realtime append-text helpers call this.

*Call graph*: calls 1 internal fn (send_request); called by 1 (append_text); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_append_speech_request`  (lines 1041–1048)

```
async fn send_thread_realtime_append_speech_request(
        &mut self,
        params: ThreadRealtimeAppendSpeechParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `thread/realtime/appendSpeech` request.

**Data flow**: It serializes `ThreadRealtimeAppendSpeechParams`, sends the request, and returns the request id.

**Call relations**: Realtime append-speech helpers call this.

*Call graph*: calls 1 internal fn (send_request); called by 1 (append_speech); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_stop_request`  (lines 1051–1057)

```
async fn send_thread_realtime_stop_request(
        &mut self,
        params: ThreadRealtimeStopParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `thread/realtime/stop` request.

**Data flow**: It serializes `ThreadRealtimeStopParams`, sends the request, and returns the request id.

**Call relations**: Used by realtime-stop tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_thread_realtime_list_voices_request`  (lines 1059–1066)

```
async fn send_thread_realtime_list_voices_request(
        &mut self,
        params: ThreadRealtimeListVoicesParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `thread/realtime/listVoices` with typed params.

**Data flow**: It serializes `ThreadRealtimeListVoicesParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for realtime voice-list queries.

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

**Purpose**: Performs deterministic cleanup of an in-flight turn by sending `turn/interrupt` and waiting for both the interrupt response and a terminal `turn/completed` notification, tolerating races where completion is already buffered.

**Data flow**: It takes thread id, turn id, and a read timeout. It sends `turn/interrupt`, waits up to the timeout for the matching response, and if that times out checks `pending_turn_completed_notification` to treat an already-buffered terminal notification as success. It then waits similarly for a `turn/completed` notification, again accepting a buffered matching completion on timeout, and returns `Ok(())` once terminal cleanup is confirmed.

**Call relations**: Tests call this at teardown after intentionally leaving work in flight. It orchestrates `send_turn_interrupt_request`, `read_stream_until_response_message`, `read_stream_until_notification_message`, and the buffered-message predicate helper to avoid flaky races.

*Call graph*: calls 4 internal fn (pending_turn_completed_notification, read_stream_until_notification_message, read_stream_until_response_message, send_turn_interrupt_request); 2 external calls (Integer, timeout).


##### `TestAppServer::send_turn_steer_request`  (lines 1127–1133)

```
async fn send_turn_steer_request(
        &mut self,
        params: TurnSteerParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `turn/steer` request.

**Data flow**: It serializes `TurnSteerParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that steer an active turn.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_review_start_request`  (lines 1136–1142)

```
async fn send_review_start_request(
        &mut self,
        params: ReviewStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends the v2 `review/start` request.

**Data flow**: It serializes `ReviewStartParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for review-start flows.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_windows_sandbox_setup_start_request`  (lines 1144–1150)

```
async fn send_windows_sandbox_setup_start_request(
        &mut self,
        params: WindowsSandboxSetupStartParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `windowsSandbox/setupStart` with typed params.

**Data flow**: It serializes `WindowsSandboxSetupStartParams`, sends the request, and returns the request id.

**Call relations**: Used by Windows sandbox setup tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_config_read_request`  (lines 1152–1158)

```
async fn send_config_read_request(
        &mut self,
        params: ConfigReadParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `config/read` with typed params.

**Data flow**: It serializes `ConfigReadParams`, sends the request, and returns the request id.

**Call relations**: Higher-level config-read helpers use this sender.

*Call graph*: calls 1 internal fn (send_request); called by 1 (read_config); 1 external calls (to_value).


##### `TestAppServer::send_config_requirements_read_request`  (lines 1160–1163)

```
async fn send_config_requirements_read_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `configRequirements/read` with no params.

**Data flow**: It calls `send_request` with the fixed method and `None`, returning the request id.

**Call relations**: A convenience wrapper for requirements reads.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_config_value_write_request`  (lines 1165–1171)

```
async fn send_config_value_write_request(
        &mut self,
        params: ConfigValueWriteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `config/value/write` with typed params.

**Data flow**: It serializes `ConfigValueWriteParams`, sends the request, and returns the request id.

**Call relations**: Used by config mutation tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_config_batch_write_request`  (lines 1173–1179)

```
async fn send_config_batch_write_request(
        &mut self,
        params: ConfigBatchWriteParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `config/batchWrite` with typed params.

**Data flow**: It serializes `ConfigBatchWriteParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for batch config writes.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_read_file_request`  (lines 1181–1187)

```
async fn send_fs_read_file_request(
        &mut self,
        params: FsReadFileParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/readFile` with typed params.

**Data flow**: It serializes `FsReadFileParams`, sends the request, and returns the request id.

**Call relations**: Used by filesystem read tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_write_file_request`  (lines 1189–1195)

```
async fn send_fs_write_file_request(
        &mut self,
        params: FsWriteFileParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/writeFile` with typed params.

**Data flow**: It serializes `FsWriteFileParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for file-write tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_create_directory_request`  (lines 1197–1203)

```
async fn send_fs_create_directory_request(
        &mut self,
        params: FsCreateDirectoryParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/createDirectory` with typed params.

**Data flow**: It serializes `FsCreateDirectoryParams`, sends the request, and returns the request id.

**Call relations**: Used by directory-creation tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_get_metadata_request`  (lines 1205–1211)

```
async fn send_fs_get_metadata_request(
        &mut self,
        params: FsGetMetadataParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/getMetadata` with typed params.

**Data flow**: It serializes `FsGetMetadataParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for metadata queries.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_read_directory_request`  (lines 1213–1219)

```
async fn send_fs_read_directory_request(
        &mut self,
        params: FsReadDirectoryParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/readDirectory` with typed params.

**Data flow**: It serializes `FsReadDirectoryParams`, sends the request, and returns the request id.

**Call relations**: Used by directory-listing tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_remove_request`  (lines 1221–1224)

```
async fn send_fs_remove_request(&mut self, params: FsRemoveParams) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/remove` with typed params.

**Data flow**: It serializes `FsRemoveParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for remove operations.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_copy_request`  (lines 1226–1229)

```
async fn send_fs_copy_request(&mut self, params: FsCopyParams) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/copy` with typed params.

**Data flow**: It serializes `FsCopyParams`, sends the request, and returns the request id.

**Call relations**: Used by filesystem copy tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_watch_request`  (lines 1231–1234)

```
async fn send_fs_watch_request(&mut self, params: FsWatchParams) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/watch` with typed params.

**Data flow**: It serializes `FsWatchParams`, sends the request, and returns the request id.

**Call relations**: A typed wrapper for watch registration.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_fs_unwatch_request`  (lines 1236–1242)

```
async fn send_fs_unwatch_request(
        &mut self,
        params: FsUnwatchParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fs/unwatch` with typed params.

**Data flow**: It serializes `FsUnwatchParams`, sends the request, and returns the request id.

**Call relations**: Used by watch-removal tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (to_value).


##### `TestAppServer::send_logout_account_request`  (lines 1245–1247)

```
async fn send_logout_account_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/logout` with no params.

**Data flow**: It calls `send_request` with the fixed method and `None`, returning the request id.

**Call relations**: A convenience wrapper for logout tests.

*Call graph*: calls 1 internal fn (send_request).


##### `TestAppServer::send_login_account_api_key_request`  (lines 1250–1259)

```
async fn send_login_account_api_key_request(
        &mut self,
        api_key: &str,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/login/start` using the raw API-key login payload shape.

**Data flow**: It takes an API key string, builds `{ "type": "apiKey", "apiKey": <key> }`, sends it via `send_request`, and returns the request id.

**Call relations**: Auth tests and helper functions use this to log in with an API key before asserting later auth status.

*Call graph*: calls 1 internal fn (send_request); called by 4 (login_with_api_key_via_request, login_with_api_key, login_with_api_key, login_with_api_key); 1 external calls (json!).


##### `TestAppServer::send_login_account_chatgpt_request`  (lines 1262–1267)

```
async fn send_login_account_chatgpt_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/login/start` requesting ChatGPT login.

**Data flow**: It builds `{ "type": "chatgpt" }`, sends it, and returns the request id.

**Call relations**: Used by tests that initiate ChatGPT login flows.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_login_account_chatgpt_device_code_request`  (lines 1270–1275)

```
async fn send_login_account_chatgpt_device_code_request(&mut self) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/login/start` requesting ChatGPT device-code login.

**Data flow**: It builds `{ "type": "chatgptDeviceCode" }`, sends it, and returns the request id.

**Call relations**: A convenience wrapper for device-code login tests.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_cancel_login_account_request`  (lines 1278–1284)

```
async fn send_cancel_login_account_request(
        &mut self,
        params: CancelLoginAccountParams,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `account/login/cancel` with typed params.

**Data flow**: It serializes `CancelLoginAccountParams`, sends the request, and returns the request id.

**Call relations**: Used by tests that cancel in-progress login flows.

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

**Purpose**: Sends `fuzzyFileSearch` with query, roots, and an optional cancellation token.

**Data flow**: It takes a query string, root paths, and optional token, builds a JSON object with `query` and `roots`, conditionally inserts `cancellationToken`, sends it via `send_request`, and returns the request id.

**Call relations**: This is the one-shot fuzzy-search request path, distinct from the session-based start/update/stop helpers.

*Call graph*: calls 1 internal fn (send_request); 1 external calls (json!).


##### `TestAppServer::send_fuzzy_file_search_session_start_request`  (lines 1303–1314)

```
async fn send_fuzzy_file_search_session_start_request(
        &mut self,
        session_id: &str,
        roots: Vec<String>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fuzzyFileSearch/sessionStart` with a session id and roots.

**Data flow**: It builds a JSON object containing `sessionId` and `roots`, sends it, and returns the request id.

**Call relations**: The higher-level `start_fuzzy_file_search_session` helper uses this before waiting for the response.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_fuzzy_file_search_session); 1 external calls (json!).


##### `TestAppServer::start_fuzzy_file_search_session`  (lines 1316–1326)

```
async fn start_fuzzy_file_search_session(
        &mut self,
        session_id: &str,
        roots: Vec<String>,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Starts a fuzzy-file-search session and waits for the matching JSON-RPC response.

**Data flow**: It takes a session id and roots, sends the session-start request, wraps the numeric id in `RequestId::Integer`, waits until `read_stream_until_response_message` returns the matching response, and returns that `JSONRPCResponse`.

**Call relations**: This is a convenience orchestration helper over the lower-level send and read primitives for session-based fuzzy search.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_fuzzy_file_search_session_start_request); 1 external calls (Integer).


##### `TestAppServer::send_fuzzy_file_search_session_update_request`  (lines 1328–1339)

```
async fn send_fuzzy_file_search_session_update_request(
        &mut self,
        session_id: &str,
        query: &str,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fuzzyFileSearch/sessionUpdate` with a session id and query.

**Data flow**: It builds a JSON object with `sessionId` and `query`, sends it, and returns the request id.

**Call relations**: Used directly and by `update_fuzzy_file_search_session`.

*Call graph*: calls 1 internal fn (send_request); called by 2 (update_fuzzy_file_search_session, assert_update_request_fails_for_missing_session); 1 external calls (json!).


##### `TestAppServer::update_fuzzy_file_search_session`  (lines 1341–1351)

```
async fn update_fuzzy_file_search_session(
        &mut self,
        session_id: &str,
        query: &str,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Updates a fuzzy-file-search session and waits for the matching response.

**Data flow**: It takes a session id and query, sends the update request, waits for the response with the corresponding integer request id, and returns the `JSONRPCResponse`.

**Call relations**: This is the response-waiting convenience wrapper over `send_fuzzy_file_search_session_update_request`.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_fuzzy_file_search_session_update_request); 1 external calls (Integer).


##### `TestAppServer::send_fuzzy_file_search_session_stop_request`  (lines 1353–1362)

```
async fn send_fuzzy_file_search_session_stop_request(
        &mut self,
        session_id: &str,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends `fuzzyFileSearch/sessionStop` with a session id.

**Data flow**: It builds `{ "sessionId": <id> }`, sends it, and returns the request id.

**Call relations**: Used directly and by `stop_fuzzy_file_search_session`.

*Call graph*: calls 1 internal fn (send_request); called by 1 (stop_fuzzy_file_search_session); 1 external calls (json!).


##### `TestAppServer::stop_fuzzy_file_search_session`  (lines 1364–1373)

```
async fn stop_fuzzy_file_search_session(
        &mut self,
        session_id: &str,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Stops a fuzzy-file-search session and waits for the matching response.

**Data flow**: It takes a session id, sends the stop request, waits for the response with the corresponding integer request id, and returns the `JSONRPCResponse`.

**Call relations**: This is the response-waiting convenience wrapper over `send_fuzzy_file_search_session_stop_request`.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_fuzzy_file_search_session_stop_request); 1 external calls (Integer).


##### `TestAppServer::send_request`  (lines 1375–1390)

```
async fn send_request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Allocates the next integer request id, wraps the method and params in a `JSONRPCRequest`, and writes it to the child process.

**Data flow**: It takes a method string and optional JSON params, increments `next_request_id` with relaxed atomic ordering, constructs `JSONRPCMessage::Request(JSONRPCRequest { id, method, params, trace: None })`, sends it via `send_jsonrpc_message`, and returns the numeric request id.

**Call relations**: Nearly every typed `send_*_request` helper funnels through this function, making it the central request-construction path.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 104 (initialize_with_params, send_add_credits_nudge_email_request, send_apps_list_request, send_cancel_login_account_request, send_chatgpt_auth_tokens_login_request, send_command_exec_request, send_command_exec_resize_request, send_command_exec_terminate_request, send_command_exec_write_request, send_config_batch_write_request (+15 more)); 3 external calls (fetch_add, Request, Integer).


##### `TestAppServer::send_response`  (lines 1392–1399)

```
async fn send_response(
        &mut self,
        id: RequestId,
        result: serde_json::Value,
    ) -> anyhow::Result<()>
```

**Purpose**: Writes a JSON-RPC response message back to the child process, typically when the server has issued a request to the test harness.

**Data flow**: It takes a `RequestId` and result JSON value, wraps them in `JSONRPCResponse`, converts that to `JSONRPCMessage::Response`, sends it via `send_jsonrpc_message`, and returns success or error.

**Call relations**: Tests that emulate client-side handling of server-initiated requests use this helper after reading a `ServerRequest`.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 1 (respond_to_refresh_request); 1 external calls (Response).


##### `TestAppServer::send_error`  (lines 1401–1408)

```
async fn send_error(
        &mut self,
        id: RequestId,
        error: JSONRPCErrorError,
    ) -> anyhow::Result<()>
```

**Purpose**: Writes a JSON-RPC error message back to the child process.

**Data flow**: It takes a `RequestId` and `JSONRPCErrorError`, wraps them in `JSONRPCError`, converts that to `JSONRPCMessage::Error`, sends it via `send_jsonrpc_message`, and returns success or error.

**Call relations**: Used when tests need to reject a server-initiated request instead of responding successfully.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); 1 external calls (Error).


##### `TestAppServer::send_notification`  (lines 1410–1424)

```
async fn send_notification(
        &mut self,
        notification: ClientNotification,
    ) -> anyhow::Result<()>
```

**Purpose**: Serializes a typed `ClientNotification` enum into the generic JSON-RPC notification envelope and writes it to the child process.

**Data flow**: It takes a `ClientNotification`, converts it to `serde_json::Value`, extracts the `method` string and optional `params` field from that value, constructs `JSONRPCMessage::Notification(JSONRPCNotification { ... })`, and sends it via `send_jsonrpc_message`.

**Call relations**: The initialize handshake uses this to send `initialized`, and tests can use it for other client-originated notifications.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 1 (initialize_with_params); 2 external calls (Notification, to_value).


##### `TestAppServer::send_jsonrpc_message`  (lines 1426–1436)

```
async fn send_jsonrpc_message(&mut self, message: JSONRPCMessage) -> anyhow::Result<()>
```

**Purpose**: Performs the actual transport write of one newline-delimited JSON-RPC message to the child’s stdin.

**Data flow**: It takes a `JSONRPCMessage`, logs it to stderr, checks that `stdin` is still present, serializes the message to a JSON string, writes the bytes plus a trailing newline to the child stdin, flushes, and returns success or an error if stdin is closed or serialization/write fails.

**Call relations**: All request, response, error, and notification senders delegate here, making it the single outbound transport primitive.

*Call graph*: called by 4 (send_error, send_notification, send_request, send_response); 3 external calls (bail!, eprintln!, to_string).


##### `TestAppServer::read_jsonrpc_message`  (lines 1438–1444)

```
async fn read_jsonrpc_message(&mut self) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Reads one line from the child’s stdout and deserializes it as a `JSONRPCMessage`.

**Data flow**: It allocates a local `String`, reads one line into it from the buffered stdout reader, parses that line with `serde_json::from_str::<JSONRPCMessage>`, logs the parsed message to stderr, and returns it.

**Call relations**: This is the single inbound transport primitive used by the higher-level stream-reading helpers.

*Call graph*: called by 2 (initialize_with_params, read_stream_until_message); 3 external calls (read_line, new, eprintln!).


##### `TestAppServer::read_stream_until_request_message`  (lines 1446–1459)

```
async fn read_stream_until_request_message(&mut self) -> anyhow::Result<ServerRequest>
```

**Purpose**: Consumes the message stream until the next server-initiated JSON-RPC request appears, buffering all non-request messages.

**Data flow**: It logs entry, calls `read_stream_until_message` with a predicate matching `JSONRPCMessage::Request(_)`, unwraps the resulting message as a `JSONRPCRequest`, converts it into a typed `ServerRequest` with `try_into()`, and returns that typed request.

**Call relations**: Tests that need to answer server-originated requests use this helper. It relies on the generic buffered stream scanner to preserve unrelated messages for later.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 1 (respond_to_refresh_request); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_stream_until_response_message`  (lines 1461–1477)

```
async fn read_stream_until_response_message(
        &mut self,
        request_id: RequestId,
    ) -> anyhow::Result<JSONRPCResponse>
```

**Purpose**: Consumes the stream until it finds a response or error carrying the specified request id, then unwraps it as a successful `JSONRPCResponse`.

**Data flow**: It takes a `RequestId`, logs entry, calls `read_stream_until_message` with a predicate comparing `message_request_id(message)` to the target id, unwraps the matched message as `JSONRPCMessage::Response`, and returns the response.

**Call relations**: Most tests pair a `send_*_request` call with this helper to await the corresponding response while buffering unrelated notifications.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 37 (interrupt_turn_and_wait_for_aborted, start_fuzzy_file_search_session, stop_fuzzy_file_search_session, update_fuzzy_file_search_session, login_with_api_key_via_request, fork_fake_rollout_thread, send_turn_and_wait, start_thread, mcp_server_names, start_thread (+15 more)); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_stream_until_error_message`  (lines 1479–1493)

```
async fn read_stream_until_error_message(
        &mut self,
        request_id: RequestId,
    ) -> anyhow::Result<JSONRPCError>
```

**Purpose**: Consumes the stream until it finds a message with the specified request id and unwraps it as a JSON-RPC error.

**Data flow**: It takes a `RequestId`, scans the stream with the same id-based predicate used for responses, unwraps the matched message as `JSONRPCMessage::Error`, and returns the error object.

**Call relations**: Tests expecting failures use this instead of the response reader.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 4 (assert_update_request_fails_for_missing_session, expect_error_message, read_error_response, assert_remote_control_disabled_by_requirements); 1 external calls (unreachable!).


##### `TestAppServer::read_stream_until_notification_message`  (lines 1495–1514)

```
async fn read_stream_until_notification_message(
        &mut self,
        method: &str,
    ) -> anyhow::Result<JSONRPCNotification>
```

**Purpose**: Consumes the stream until it finds a notification with the specified method name, buffering everything else.

**Data flow**: It takes a method string, logs entry, calls `read_stream_until_message` with a predicate matching `JSONRPCMessage::Notification` whose `method` equals the target, unwraps the result as `JSONRPCNotification`, and returns it.

**Call relations**: Many lifecycle-oriented tests use this to wait for notifications such as `turn/completed` or cache-update events.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 25 (interrupt_turn_and_wait_for_aborted, assert_no_session_updates_for, read_app_list_updated_notification, read_command_exec_delta, wait_for_context_compaction_completed, wait_for_context_compaction_started, wait_for_turn_completed, wait_for_dynamic_tool_completed, wait_for_dynamic_tool_started, maybe_fs_changed_notification (+15 more)); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_stream_until_matching_notification`  (lines 1516–1539)

```
async fn read_stream_until_matching_notification(
        &mut self,
        description: &str,
        predicate: F,
    ) -> anyhow::Result<JSONRPCNotification>
```

**Purpose**: Consumes the stream until it finds a notification satisfying an arbitrary caller-supplied predicate.

**Data flow**: It takes a human-readable description and a predicate over `&JSONRPCNotification`, logs entry, scans with `read_stream_until_message`, unwraps the matched message as a notification, and returns it.

**Call relations**: This is the flexible notification-waiting variant used when matching requires inspecting notification params rather than just the method name.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 2 (wait_for_session_completed, wait_for_session_updated); 2 external calls (eprintln!, unreachable!).


##### `TestAppServer::read_next_message`  (lines 1541–1543)

```
async fn read_next_message(&mut self) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Returns the next available message from either the pending buffer or the live stream, regardless of type.

**Data flow**: It calls `read_stream_until_message` with a predicate that always returns true and returns the resulting `JSONRPCMessage`.

**Call relations**: Collection-style test helpers use this when they want to inspect the raw message stream without filtering.

*Call graph*: calls 1 internal fn (read_stream_until_message); called by 4 (collect_turn_notifications, collect_cyber_policy_error_and_validate_no_reroute, collect_model_verification_notifications_and_validate_no_warning_item, collect_turn_notifications_and_validate_no_warning_item).


##### `TestAppServer::clear_message_buffer`  (lines 1549–1551)

```
fn clear_message_buffer(&mut self)
```

**Purpose**: Drops all buffered non-consumed messages accumulated by prior filtered reads.

**Data flow**: It mutably accesses `pending_messages` and clears the deque in place.

**Call relations**: Tests call this when they intentionally want to ignore stale buffered messages before observing a new phase of activity.

*Call graph*: called by 1 (run_environment_selection_case); 1 external calls (clear).


##### `TestAppServer::pending_notification_methods`  (lines 1553–1561)

```
fn pending_notification_methods(&self) -> Vec<String>
```

**Purpose**: Returns the method names of all currently buffered notification messages.

**Data flow**: It iterates over `pending_messages`, filters to `JSONRPCMessage::Notification`, clones each notification’s `method`, collects them into a `Vec<String>`, and returns that vector.

**Call relations**: This is an inspection/debugging helper for tests that need to assert what notifications have already been buffered.

*Call graph*: 1 external calls (iter).


##### `TestAppServer::read_stream_until_message`  (lines 1565–1580)

```
async fn read_stream_until_message(&mut self, predicate: F) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Implements buffered stream scanning: return the first message matching a predicate, preserving all earlier non-matching messages for later reads.

**Data flow**: It takes a predicate over `&JSONRPCMessage`. It first tries `take_pending_message` to satisfy the predicate from the existing buffer; if none matches, it loops reading fresh messages with `read_jsonrpc_message`, returning immediately on the first match and otherwise pushing each non-matching message onto `pending_messages`.

**Call relations**: All specialized read helpers delegate to this function. It is the core mechanism that lets tests wait for one message type without losing interleaved notifications or responses.

*Call graph*: calls 2 internal fn (read_jsonrpc_message, take_pending_message); called by 6 (read_next_message, read_stream_until_error_message, read_stream_until_matching_notification, read_stream_until_notification_message, read_stream_until_request_message, read_stream_until_response_message); 1 external calls (push_back).


##### `TestAppServer::take_pending_message`  (lines 1582–1590)

```
fn take_pending_message(&mut self, predicate: &F) -> Option<JSONRPCMessage>
```

**Purpose**: Searches the buffered message deque for the first entry matching a predicate and removes it if found.

**Data flow**: It takes a predicate reference, scans `pending_messages` for the first matching position, removes and returns that message if present, or returns `None` otherwise.

**Call relations**: Only `read_stream_until_message` calls this, using it to prefer already-buffered messages before reading more from stdout.

*Call graph*: called by 1 (read_stream_until_message); 2 external calls (iter, remove).


##### `TestAppServer::pending_turn_completed_notification`  (lines 1592–1609)

```
fn pending_turn_completed_notification(&self, thread_id: &str, turn_id: &str) -> bool
```

**Purpose**: Checks whether the buffered message deque already contains a `turn/completed` notification for a specific thread id and turn id.

**Data flow**: It iterates over `pending_messages`, filters to notifications with method `turn/completed`, extracts their params, attempts to deserialize each into `TurnCompletedNotification`, and returns true if any payload’s `thread_id` and `turn.id` match the supplied strings.

**Call relations**: The interrupt cleanup helper uses this to tolerate races where the terminal completion notification arrives before or during timeout handling.

*Call graph*: called by 1 (interrupt_turn_and_wait_for_aborted); 1 external calls (iter).


##### `TestAppServer::message_request_id`  (lines 1611–1618)

```
fn message_request_id(message: &JSONRPCMessage) -> Option<&RequestId>
```

**Purpose**: Extracts the `RequestId` from a request, response, or error message, returning `None` for notifications.

**Data flow**: It pattern-matches on a borrowed `JSONRPCMessage` and returns a borrowed reference to the embedded id for request/response/error variants or `None` for notifications.

**Call relations**: The response and error readers use this helper inside their stream predicates to match messages by request id.


##### `TestAppServer::drop`  (lines 1622–1662)

```
fn drop(&mut self)
```

**Purpose**: Performs bounded synchronous child-process cleanup to reduce flaky leaked-process reports when the harness is dropped.

**Data flow**: On drop, it closes stdin by taking and dropping it, polls `process.try_wait()` for up to 200 ms to allow graceful EOF-driven shutdown, calls `start_kill()` if the child is still alive, then polls `try_wait()` for up to 5 seconds with short sleeps until the OS reports exit or an error occurs.

**Call relations**: This runs automatically at test teardown for every `TestAppServer`. It complements Tokio’s best-effort `kill_on_drop(true)` with explicit synchronous waiting because `Drop` cannot be async.

*Call graph*: 6 external calls (start_kill, try_wait, sleep, from_millis, from_secs, now).


### Integration suite indexes
These top-level test modules collect the shared harness into the compiled integration binary and organize the feature-specific suite tree, including the large v2 branch.

### `app-server/tests/all.rs`

`test` · `test run`

This file is the integration-test entry module for the app server. The crate-level attribute `#![allow(clippy::expect_used)]` relaxes linting for the test binary, acknowledging that tests often use `expect` for concise failure messages and setup assertions. The remaining content is a single `mod suite;` declaration, accompanied by a comment explaining the structure: this binary aggregates submodules located under `tests/suite/`.

The practical effect is that Cargo builds one integration test target containing all of the suite’s nested modules rather than many unrelated top-level test binaries. That can simplify shared setup patterns, reduce duplication in imports and helpers, and make it easier to organize tests by feature area under a common namespace. There is no runtime logic beyond Rust’s normal test harness discovery, but this file determines compilation boundaries and test organization. When `cargo test` runs for this target, the Rust test harness traverses the module tree rooted here, discovers `#[test]` and async test functions in descendant modules, and executes them according to the harness configuration. The file is therefore active only in test builds and serves as the structural root of the server’s integration coverage.


### `app-server/tests/suite/mod.rs`

`test` · `test run`

This file is a pure test-suite module manifest. It declares five child modules: `auth`, `conversation_summary`, `fuzzy_file_search`, `strict_config`, and `v2`. Each declaration tells the Rust test harness and compiler to include the corresponding source file or directory as part of the single integration-test binary rooted at `tests/all.rs`.

Its role is organizational rather than behavioral. By separating broad test domains at this level, the suite can keep older or cross-cutting tests distinct from the much larger `v2` API surface, while still compiling everything into one coherent test crate. The `v2` module is especially significant because it acts as a second-level index for a large number of endpoint- and feature-specific tests. This file therefore defines the first layer of taxonomy for integration coverage: authentication behavior, conversation summarization, fuzzy file search behavior, strict configuration validation, and the versioned API suite. There are no functions, fixtures, or assertions here, but the module boundaries it establishes affect compile-time inclusion, namespace paths for shared helpers, and how developers navigate the test corpus when adding or debugging coverage.


### `app-server/tests/suite/v2/mod.rs`

`test` · `test run`

This file is the module manifest for the app server’s `v2` integration tests. It declares a long list of child modules covering account operations, analytics, app listing, attestation, client metadata, collaboration mode listing, compaction, config RPC, websocket connection handling, dynamic tools, executor behavior, experimental APIs, external-agent configuration, filesystem operations, hooks, image generation, initialization, marketplace actions, MCP resources and tools, memory reset, model APIs, permission profiles, planning, plugin lifecycle operations, process execution, rate limits, realtime conversation, remote control, review flows, safety checks, skills, sleep, thread lifecycle operations, turn control, web search, and Windows sandbox setup.

Several modules are gated with `#[cfg(...)]`, which is the key behavior in this file. Unix-only tests such as `command_exec` and `connection_handling_websocket_unix` compile only on Unix platforms; `executor_mcp` is excluded on Windows; `remote_thread_store` appears only in debug builds. Those conditions prevent unsupported tests from compiling or running in incompatible environments while preserving a single canonical suite definition. There is no executable test logic here, but this file is the authoritative inventory of v2 integration coverage and the place where platform-specific test topology is encoded. During test compilation, Rust uses these declarations and cfg guards to decide exactly which feature modules become part of the test binary on the current target.
