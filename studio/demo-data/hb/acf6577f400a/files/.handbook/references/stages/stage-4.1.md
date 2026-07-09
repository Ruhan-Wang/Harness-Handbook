# Config layer ingestion and requirements composition  `stage-4.1`

This stage is the system’s configuration intake and assembly line. It runs mostly during startup, and again whenever settings must be refreshed. Its job is to read settings from user files, administrator-managed files, cloud policy, command-line options, and session overrides, then turn them into one effective set of rules the rest of Codex can trust.

The core config loading part defines what valid settings look like, reads each layer, reports precise mistakes, merges layers in priority order, and records where each value came from. The requirements layering part does the same for safety rules: command permissions, sandbox limits, hooks, network policy, and allow or deny rules. It combines them carefully so security-sensitive settings are not accidentally weakened.

The configuration service part is the editing and support desk. It lets the app and daemon inspect or change settings, writes files safely, explains errors, and imports older settings when possible. Finally, config/src/lib.rs is the public front door for this whole library. It gathers the internal pieces and exposes the configuration tools other parts of the codebase should use.

## Sub-stages

- [Core config schemas, diagnostics, merge, and layered loading](stage-4.1.1.md) `stage-4.1.1` — 22 files
- [Requirements layering and execution-policy composition](stage-4.1.2.md) `stage-4.1.2` — 11 files
- [Configuration management services and editable persistence surfaces](stage-4.1.3.md) `stage-4.1.3` — 8 files

## Files in this stage

### Config layer ingestion and requirements composition
### `config/src/lib.rs`

`config` · `config load and cross-cutting configuration access`

This file does not contain the detailed rules for reading or checking configuration. Instead, it acts like the index desk at a large office: it knows which departments exist and makes their public services easy to find. The project has many kinds of configuration, including user config files, cloud-supplied config, permission rules, plugin and marketplace settings, MCP server settings, hooks, profiles, thread config, and requirement policies. Those pieces live in separate files so each area can stay focused.

The first part declares the internal modules that make up the configuration crate. Some modules are public, such as `config_toml`, `loader`, `permissions_toml`, `profile_toml`, `schema`, `test_support`, and `types`, meaning other crates can reach into them directly. Most modules stay private, and this file selectively re-exports their important types and functions with `pub use`. A re-export means outside code can import these items from this crate’s top level instead of knowing the exact internal file where they live.

It also defines `CONFIG_TOML_FILE`, the standard filename for the main configuration file. Without this file, other parts of the system would need to know many internal module paths, making the configuration API harder to use and easier to accidentally break when files are reorganized.
