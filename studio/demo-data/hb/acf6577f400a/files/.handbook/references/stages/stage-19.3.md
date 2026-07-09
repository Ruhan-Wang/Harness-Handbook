# Managed proxying and local IPC transport substrates  `stage-19.3`

This stage is shared behind-the-scenes transport work. It gives the system safe ways to send traffic outward and to talk between local processes. The proxy configuration code takes user proxy settings and security rules, checks them, and turns them into a plan that can start or update the managed network proxy. The proxy then uses certificates to inspect HTTPS when allowed, applies MITM hook rules to selected decrypted requests, blocks unsafe connections to private or local addresses unless permitted, and builds clear HTTP responses when requests are allowed, denied, or fail. Its upstream transport sends approved requests to the real server, either directly, through an environment proxy, or through a platform-specific socket.

Other files provide local “pipes” for parts of the program to communicate on the same machine. The Unix-domain socket layer hides operating-system differences. Shell escalation sockets can also pass open file handles between processes. Linux sandbox proxy routing builds small bridges so sandboxed code can reach a host-side proxy without opening the host network. The Windows named-pipe and IDE IPC code let the terminal UI safely ask a local IDE what the user is viewing.

## Files in this stage

### Managed proxy configuration
These files define the effective managed proxy policy and the hook rules that shape how proxy enforcement should behave at runtime.

### `core/src/config/network_proxy_spec.rs`

`config` · `startup, config recomputation, and live proxy updates`

This file is the bridge between “what the user or manager configured” and “what the network proxy is actually allowed to do.” The proxy is the gatekeeper for outbound network access, so mistakes here could either block useful work or allow traffic that policy was meant to stop.

The main type, NetworkProxySpec, keeps both the original proxy configuration and the effective configuration after managed requirements have been applied. Managed requirements can force the proxy on, pin ports, restrict upstream proxies, set allowed or denied domains, control Unix socket access, and decide whether users may add extra domains. Think of it like a building access list: a central administrator may set the core rules, and this file decides whether a local occupant can add extra guests.

Before any plan is accepted, it is checked against constraints so the effective proxy settings do not violate the required limits. The file also knows how to merge network rules from an execution policy, start the proxy with optional approval prompts, and update a running proxy with new state. A small static reloader is used because this spec already contains the final configuration; there is no external file to watch for changes.

#### Function details

##### `StartedNetworkProxy::new`  (lines 38–43)

```
fn new(proxy: NetworkProxy, handle: NetworkProxyHandle) -> Self
```

**Purpose**: Creates a small wrapper around a running network proxy and the background handle that keeps it alive. The handle is stored so the proxy does not immediately stop.

**Data flow**: It receives a built NetworkProxy and its NetworkProxyHandle. It stores both together and returns a StartedNetworkProxy value that owns them.

**Call relations**: NetworkProxySpec::start_proxy calls this after the proxy has been successfully built and started. The returned wrapper is what the rest of the system keeps when it needs a live proxy.

*Call graph*: called by 1 (start_proxy).


##### `StartedNetworkProxy::proxy`  (lines 45–47)

```
fn proxy(&self) -> NetworkProxy
```

**Purpose**: Gives callers a usable copy of the proxy object while the wrapper keeps ownership of the running proxy handle. This lets other code update or talk to the proxy without taking it apart.

**Data flow**: It reads the stored proxy, clones it, and returns the clone. The original wrapper and its background handle stay unchanged.

**Call relations**: NetworkProxySpec::apply_to_started_proxy uses this when it needs to reach into an already running proxy and replace its configuration state.

*Call graph*: called by 1 (apply_to_started_proxy); 1 external calls (clone).


##### `StaticNetworkProxyReloader::new`  (lines 56–58)

```
fn new(state: ConfigState) -> Self
```

**Purpose**: Creates a reloader that always points at one fixed proxy configuration state. It is used when the proxy state comes from this spec rather than from a changing external source.

**Data flow**: It receives a ConfigState, stores it, and returns a StaticNetworkProxyReloader containing that state.

**Call relations**: NetworkProxySpec::build_state_with_audit_metadata calls this while preparing the full proxy state for startup.

*Call graph*: called by 1 (build_state_with_audit_metadata).


##### `StaticNetworkProxyReloader::maybe_reload`  (lines 62–64)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Answers the proxy’s periodic “has anything changed?” question. For this static reloader, the answer is always no.

**Data flow**: It reads no changing input and returns an asynchronous result containing None, meaning there is no new configuration to load.

**Call relations**: This is part of the ConfigReloader interface used by the proxy infrastructure. The proxy can call it on its normal reload path, but this implementation deliberately never produces a surprise update.

*Call graph*: 1 external calls (pin).


##### `StaticNetworkProxyReloader::reload_now`  (lines 66–68)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Returns the fixed configuration state immediately when the proxy asks for a forced reload. This gives the proxy a valid state even though there is no external source to reread.

**Data flow**: It clones the stored ConfigState and returns it through an asynchronous result. The reloader’s stored copy remains unchanged.

**Call relations**: This is the “reload immediately” half of the ConfigReloader interface. It supports the proxy state created by NetworkProxySpec::build_state_with_audit_metadata.

*Call graph*: 2 external calls (pin, clone).


##### `StaticNetworkProxyReloader::source_label`  (lines 70–72)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a human-readable name for this reloader. This is useful for logs or diagnostics that want to say where proxy settings came from.

**Data flow**: It takes no outside data and returns the string label "StaticNetworkProxyReloader".

**Call relations**: The proxy infrastructure can call this through the ConfigReloader interface when reporting or debugging reload behavior.


##### `NetworkProxySpec::enabled`  (lines 76–78)

```
fn enabled(&self) -> bool
```

**Purpose**: Reports whether the effective proxy configuration says the network proxy should be on. Callers use this before deciding whether proxy behavior is needed.

**Data flow**: It reads the effective config stored in the spec and returns the boolean enabled flag.

**Call relations**: This is a simple query on the prepared spec. It reflects any managed requirements already applied by NetworkProxySpec::from_config_and_constraints.


##### `NetworkProxySpec::proxy_host_and_port`  (lines 80–82)

```
fn proxy_host_and_port(&self) -> String
```

**Purpose**: Returns the proxy address in a compact host-and-port form, such as an address another component can connect to. If the configured address lacks a port, it uses the proxy’s default HTTP port.

**Data flow**: It reads the effective proxy URL from the spec, passes it to the shared address helper with default port 3128, and returns the resulting host:port string.

**Call relations**: This is a read-only convenience method for code that needs to advertise or connect through the configured proxy endpoint.

*Call graph*: 1 external calls (host_and_port_from_network_addr).


##### `NetworkProxySpec::socks_enabled`  (lines 84–86)

```
fn socks_enabled(&self) -> bool
```

**Purpose**: Reports whether SOCKS5 support is enabled. SOCKS5 is a proxy protocol often used by tools that need a generic network tunnel rather than just HTTP.

**Data flow**: It reads the effective network configuration and returns the SOCKS5 enabled flag.

**Call relations**: Like NetworkProxySpec::enabled, this reflects the final configuration after managed requirements have been applied.


##### `NetworkProxySpec::from_config_and_constraints`  (lines 88–120)

```
fn from_config_and_constraints(
        config: NetworkProxyConfig,
        requirements: Option<NetworkConstraints>,
        permission_profile: &PermissionProfile,
    ) -> std::io::Result<Self>
```

**Purpose**: Builds a complete NetworkProxySpec from ordinary proxy settings, optional managed requirements, and the current permission profile. This is the main safety checkpoint that turns many inputs into one validated plan.

**Data flow**: It starts with the given NetworkProxyConfig and saves a copy as the base config. If managed NetworkConstraints exist, it applies them to produce an effective config and matching constraints; otherwise it uses the config as-is with default constraints. It then validates that the effective settings obey the constraints and returns either a ready NetworkProxySpec or an input error.

**Call relations**: This is called by the broader config-building flow and by NetworkProxySpec::recompute_for_permission_profile. Many tests also call it because it is where the key policy combinations are resolved.

*Call graph*: called by 25 (build_network_proxy_spec, allow_only_requirements_do_not_create_deny_constraints_in_full_access, danger_full_access_keeps_managed_allowlist_and_denylist_fixed, deny_only_requirements_do_not_create_allow_constraints_in_full_access, managed_allowed_domains_only_blocks_all_user_domains_in_full_access_without_managed_list, managed_allowed_domains_only_disables_default_mode_allowlist_expansion, managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses, managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains, managed_unrestricted_profile_allows_domain_expansion, requirements_allowed_domains_are_a_baseline_for_user_allowlist (+15 more)); 4 external calls (apply_requirements, validate_policy_against_constraints, clone, default).


##### `NetworkProxySpec::start_proxy`  (lines 122–151)

```
async fn start_proxy(
        &self,
        permission_profile: &PermissionProfile,
        policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
        blocked_request_observer: Option<Arc<dyn Blo
```

**Purpose**: Starts a real network proxy from this spec. It also decides whether blocked network requests should ask for approval, be observed, or be denied automatically under managed sandbox rules.

**Data flow**: It receives the permission profile, optional policy decider, optional blocked-request observer, an approval-flow flag, and audit metadata. It builds proxy state from the spec, configures a proxy builder with optional approval and observer hooks, starts the proxy, and returns a StartedNetworkProxy. If building or running fails, it returns an I/O error with context.

**Call relations**: The higher-level start_managed_network_proxy flow calls this once the spec is ready. Inside, it uses NetworkProxySpec::build_state_with_audit_metadata and wraps the running result with StartedNetworkProxy::new.

*Call graph*: calls 3 internal fn (build_state_with_audit_metadata, new, builder); called by 1 (start_managed_network_proxy); 2 external calls (new, managed_sandbox_active).


##### `NetworkProxySpec::recompute_for_permission_profile`  (lines 153–162)

```
fn recompute_for_permission_profile(
        &self,
        permission_profile: &PermissionProfile,
    ) -> std::io::Result<Self>
```

**Purpose**: Rebuilds the spec for a different permission profile while keeping the original base settings and managed requirements. This matters because managed profiles can change whether users may expand allowlists or denylists.

**Data flow**: It takes the stored base config and stored requirements, combines them with the new PermissionProfile, and runs the normal spec-building and validation path again. The result is a fresh NetworkProxySpec or an error.

**Call relations**: It delegates to NetworkProxySpec::from_config_and_constraints so recomputation follows the same rules as initial construction.

*Call graph*: 2 external calls (from_config_and_constraints, clone).


##### `NetworkProxySpec::with_exec_policy_network_rules`  (lines 164–177)

```
fn with_exec_policy_network_rules(
        &self,
        exec_policy: &Policy,
    ) -> std::io::Result<Self>
```

**Purpose**: Returns a copy of the spec with extra network domain rules from an execution policy. An execution policy is a set of rules for a particular command or run, so this lets per-run rules affect the proxy safely.

**Data flow**: It clones the current spec, adds allowed and denied domains from the given Policy into the cloned effective config, validates that the new config still obeys the spec’s constraints, and returns the updated spec or an error.

**Call relations**: The managed proxy startup flow calls this before starting the proxy. It hands the detailed domain insertion work to apply_exec_policy_network_rules and then runs the same constraint validation used elsewhere.

*Call graph*: calls 1 internal fn (apply_exec_policy_network_rules); called by 1 (start_managed_network_proxy); 1 external calls (validate_policy_against_constraints).


##### `NetworkProxySpec::apply_to_started_proxy`  (lines 179–191)

```
async fn apply_to_started_proxy(
        &self,
        started_proxy: &StartedNetworkProxy,
    ) -> std::io::Result<()>
```

**Purpose**: Applies this spec’s current configuration to a proxy that is already running. This allows live updates without stopping and restarting the proxy process.

**Data flow**: It builds a ConfigState from the spec, gets a proxy clone from the StartedNetworkProxy wrapper, and asks that proxy to replace its current configuration state. It returns success or an I/O error if the update fails.

**Call relations**: This is the live-update counterpart to NetworkProxySpec::start_proxy. It uses NetworkProxySpec::build_config_state_for_spec and StartedNetworkProxy::proxy to reach the running proxy.

*Call graph*: calls 2 internal fn (build_config_state_for_spec, proxy).


##### `NetworkProxySpec::build_state_with_audit_metadata`  (lines 193–204)

```
fn build_state_with_audit_metadata(
        &self,
        audit_metadata: NetworkProxyAuditMetadata,
    ) -> std::io::Result<NetworkProxyState>
```

**Purpose**: Builds the full runtime state needed to start a proxy, including audit metadata. Audit metadata is extra information used for logging or review, such as context about why requests were allowed or blocked.

**Data flow**: It first builds a ConfigState from the spec, wraps that state in a StaticNetworkProxyReloader, and then combines the state, reloader, and audit metadata into a NetworkProxyState. The result is ready to give to the proxy builder.

**Call relations**: NetworkProxySpec::start_proxy calls this during startup. It relies on NetworkProxySpec::build_config_state_for_spec for the validated proxy config and StaticNetworkProxyReloader::new for the fixed reload source.

*Call graph*: calls 3 internal fn (build_config_state_for_spec, new, with_reloader_and_audit_metadata); called by 1 (start_proxy); 1 external calls (new).


##### `NetworkProxySpec::build_config_state_for_spec`  (lines 206–210)

```
fn build_config_state_for_spec(&self) -> std::io::Result<ConfigState>
```

**Purpose**: Converts the spec’s effective config and constraints into the proxy’s internal configuration state. This is the form the proxy engine actually uses at runtime.

**Data flow**: It clones the effective NetworkProxyConfig and NetworkProxyConstraints, passes them to the shared build_config_state helper, and returns the resulting ConfigState. If conversion fails, it turns that failure into an I/O error.

**Call relations**: Both NetworkProxySpec::build_state_with_audit_metadata and NetworkProxySpec::apply_to_started_proxy call this, so the same state-building path is used for initial startup and live updates.

*Call graph*: called by 2 (apply_to_started_proxy, build_state_with_audit_metadata); 3 external calls (build_config_state, clone, clone).


##### `NetworkProxySpec::apply_requirements`  (lines 212–318)

```
fn apply_requirements(
        mut config: NetworkProxyConfig,
        requirements: &NetworkConstraints,
        permission_profile: &PermissionProfile,
        hard_deny_allowlist_misses: bool,
```

**Purpose**: Applies managed network requirements to a user-provided proxy config and records matching constraints that must not be violated later. This is where administrator-style rules become concrete proxy settings.

**Data flow**: It receives a mutable proxy config, the managed requirements, the permission profile, and whether allowlist misses should be hard-denied. It updates fields such as enabled state, proxy ports, upstream proxy permissions, domain allow and deny lists, Unix socket rules, and local binding. It also builds a NetworkProxyConstraints value that remembers which settings were fixed by requirements, then returns the updated config and constraints.

**Call relations**: NetworkProxySpec::from_config_and_constraints calls this when managed requirements are present. It uses helper decisions such as allowlist_expansion_enabled, denylist_expansion_enabled, and merge_domain_lists to decide when user domain entries may be combined with managed ones.

*Call graph*: 5 external calls (allowlist_expansion_enabled, denylist_expansion_enabled, merge_domain_lists, format!, default).


##### `NetworkProxySpec::allowlist_expansion_enabled`  (lines 320–325)

```
fn allowlist_expansion_enabled(
        permission_profile: &PermissionProfile,
        hard_deny_allowlist_misses: bool,
    ) -> bool
```

**Purpose**: Decides whether users may add extra allowed domains beyond the managed allowlist. This is only permitted in a managed sandbox when the requirements do not demand managed-only allowed domains.

**Data flow**: It reads the permission profile and the hard-deny flag. It returns true only when the profile is managed and hard-deny allowlist behavior is not active.

**Call relations**: NetworkProxySpec::apply_requirements calls this before deciding whether to merge user allowed domains with managed allowed domains.

*Call graph*: 1 external calls (managed_sandbox_active).


##### `NetworkProxySpec::managed_allowed_domains_only`  (lines 327–329)

```
fn managed_allowed_domains_only(requirements: &NetworkConstraints) -> bool
```

**Purpose**: Checks whether the managed requirements say that only managed allowed domains should be used. When true, user-provided allowed domains cannot expand access.

**Data flow**: It reads the managed_allowed_domains_only option from NetworkConstraints and returns its value, defaulting to false when it is not set.

**Call relations**: NetworkProxySpec::from_config_and_constraints uses this early to decide whether allowlist misses should be hard denied and whether allowlist expansion should be disabled.


##### `NetworkProxySpec::denylist_expansion_enabled`  (lines 331–333)

```
fn denylist_expansion_enabled(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Decides whether users may add extra denied domains on top of the managed denylist. In managed sandbox mode, adding more denials is allowed because it only makes access stricter.

**Data flow**: It reads the permission profile and returns true when the profile is a managed one.

**Call relations**: NetworkProxySpec::apply_requirements calls this before deciding whether to merge user denied domains with managed denied domains.

*Call graph*: 1 external calls (managed_sandbox_active).


##### `NetworkProxySpec::managed_sandbox_active`  (lines 335–337)

```
fn managed_sandbox_active(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Checks whether the current permission profile is the managed sandbox kind. This is a small shared test used by several policy decisions in this file.

**Data flow**: It receives a PermissionProfile and returns true if it is the Managed variant, otherwise false.

**Call relations**: NetworkProxySpec::allowlist_expansion_enabled, NetworkProxySpec::denylist_expansion_enabled, and NetworkProxySpec::start_proxy use this to choose behavior that only applies under managed sandbox rules.

*Call graph*: 1 external calls (matches!).


##### `NetworkProxySpec::merge_domain_lists`  (lines 339–349)

```
fn merge_domain_lists(mut managed: Vec<String>, user_entries: &[String]) -> Vec<String>
```

**Purpose**: Combines managed domain entries with user domain entries without adding duplicates that differ only by letter case. This keeps the final allow or deny list clean while preserving managed entries first.

**Data flow**: It starts with a managed list and scans the user entries. For each user entry not already present case-insensitively, it appends that entry. It returns the merged list.

**Call relations**: NetworkProxySpec::apply_requirements uses this when policy allows user allowlist or denylist entries to expand the managed baseline.


##### `apply_exec_policy_network_rules`  (lines 352–356)

```
fn apply_exec_policy_network_rules(config: &mut NetworkProxyConfig, exec_policy: &Policy)
```

**Purpose**: Adds network domain rules from an execution policy into a proxy config. It separates domains that should be allowed from domains that should be denied and applies each group appropriately.

**Data flow**: It asks the Policy for its compiled network domains, receiving allowed and denied domain lists. It then inserts the allowed list as allow rules and the denied list as deny rules into the given NetworkProxyConfig.

**Call relations**: NetworkProxySpec::with_exec_policy_network_rules calls this while preparing a per-run version of the spec. It delegates the actual insertion and duplicate filtering to upsert_network_domains.

*Call graph*: calls 1 internal fn (upsert_network_domains); called by 1 (with_exec_policy_network_rules); 1 external calls (compiled_network_domains).


##### `upsert_network_domains`  (lines 358–373)

```
fn upsert_network_domains(config: &mut NetworkProxyConfig, hosts: Vec<String>, allow: bool)
```

**Purpose**: Inserts or updates a batch of domain permissions in the proxy config. “Upsert” means add it if missing or replace the existing permission if it is already there.

**Data flow**: It receives a mutable config, a list of host names, and a flag saying whether they should be allowed or denied. It ignores duplicate host names within the incoming batch, normalizes host names through the proxy’s normalizer, and writes the chosen allow or deny permission into the config.

**Call relations**: apply_exec_policy_network_rules calls this twice: once for allowed domains and once for denied domains. This keeps the execution-policy rule application consistent with the proxy’s normal domain-permission format.

*Call graph*: called by 1 (apply_exec_policy_network_rules); 1 external calls (new).


### `network-proxy/src/mitm_hook.rs`

`domain_logic` · `config load and request handling`

A network proxy normally passes requests through according to broad policy. This file adds a more precise tool: for a specific host, method, path, query string, and headers, the proxy can rewrite request headers, for example removing one Authorization header and adding another from a secret. “MITM” means “man-in-the-middle” here: the proxy can inspect encrypted HTTPS traffic because it is configured to intercept and decrypt it.

The file has three main jobs. First, it checks configuration before the proxy starts. It rejects unsafe or unclear rules, such as hooks without MITM enabled, empty methods, wildcard hosts, unsupported body matching, bad header names, or secret files that are not absolute paths. Second, it compiles human-written rules into runtime objects. For example, strings can be exact matches, or glob patterns, where `*` means “match some text.” Secrets for injected headers are resolved from an environment variable or a file. Third, during request handling, it looks up hooks for the request host and tests each rule in order. The first matching rule wins and returns the header actions to apply. If no hook is configured for the host, or hooks exist but none match, it says so explicitly.

#### Function details

##### `CompiledGlobMatcher::fmt`  (lines 141–145)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a compiled glob matcher for debugging without exposing the internal matcher details. It shows the original pattern, which is the useful human-readable part.

**Data flow**: It receives a formatter and reads the stored pattern string → it writes a debug view named `CompiledGlobMatcher` with that pattern → it returns the formatter result.

**Call relations**: This is used implicitly when Rust code prints or compares debug output for this type. It delegates the actual debug formatting to the standard debug builder.

*Call graph*: 1 external calls (debug_struct).


##### `CompiledGlobMatcher::eq`  (lines 149–151)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Decides whether two compiled glob matchers should be considered the same. It compares their original pattern text, not the compiled internal matcher.

**Data flow**: It receives two matcher objects → it compares their `pattern` strings → it returns true if the pattern text is identical, otherwise false.

**Call relations**: This supports equality checks for larger hook structures that contain glob matchers, especially in tests and configuration comparisons.


##### `CompiledGlobMatcher::is_match`  (lines 157–159)

```
fn is_match(&self, candidate: &str) -> bool
```

**Purpose**: Tests whether a piece of text matches a precompiled glob pattern. A glob is a simple wildcard pattern, such as `op*` matching `open`.

**Data flow**: It receives a candidate string → it asks the compiled glob matcher to test that string → it returns true for a match and false otherwise.

**Call relations**: Path and value matchers call this when a rule uses `pattern:` instead of an exact literal value.

*Call graph*: 1 external calls (is_match).


##### `validate_mitm_hook_config`  (lines 171–229)

```
fn validate_mitm_hook_config(config: &NetworkProxyConfig) -> Result<()>
```

**Purpose**: Checks the MITM hook section of the proxy configuration before it is used. This prevents the proxy from starting with rules that are impossible, ambiguous, or not yet supported.

**Data flow**: It receives the full network proxy configuration → it reads the configured hooks and validates hosts, methods, paths, query rules, header rules, strip actions, and injected-header actions → it returns success or a detailed error explaining the bad setting.

**Call relations**: Startup validation and hook compilation call this first. It relies on smaller helpers such as host normalization, path matcher compilation, and header validation so that errors point to the exact part of the configuration.

*Call graph*: calls 7 internal fn (compile_path_matchers, normalize_hook_host, normalize_methods, validate_header_constraints, validate_injected_headers, validate_query_constraints, validate_strip_request_headers); called by 8 (compile_mitm_hooks_with_resolvers, validate_allows_hooks_in_full_mode, validate_rejects_body_matchers_for_now, validate_rejects_dual_secret_sources, validate_rejects_invalid_wildcard_path_pattern, validate_rejects_relative_secret_file, validate_requires_mitm_for_hooks, validate_policy_against_constraints); 1 external calls (anyhow!).


##### `compile_mitm_hooks`  (lines 231–242)

```
fn compile_mitm_hooks(config: &NetworkProxyConfig) -> Result<MitmHooksByHost>
```

**Purpose**: Turns validated hook configuration into the runtime lookup table used by the proxy. It also reads real secrets from environment variables or files for headers that will be injected.

**Data flow**: It receives the full proxy configuration → it supplies default secret resolvers that read process environment variables and files from disk → it returns hooks grouped by normalized host, or an error if validation or secret loading fails.

**Call relations**: Higher-level proxy setup calls this when building proxy state. It hands the real work to `compile_mitm_hooks_with_resolvers`, while providing production ways to fetch secrets.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); called by 3 (compile_resolves_file_backed_injected_headers, network_proxy_state_for_policy, build_config_state).


##### `evaluate_mitm_hooks`  (lines 244–263)

```
fn evaluate_mitm_hooks(
    hooks_by_host: &MitmHooksByHost,
    host: &str,
    req: &Request,
) -> HookEvaluation
```

**Purpose**: Checks a live HTTP request against the compiled hooks for its host. It answers whether there are no hooks, a matching hook with actions, or hooks for the host but no match.

**Data flow**: It receives the hook table, a host string, and an HTTP request → it normalizes the host, finds that host’s hooks, and tests them in order → it returns a `HookEvaluation` result, cloning the actions from the first matching hook.

**Call relations**: Request-handling code calls this when deciding whether to rewrite a MITM-inspected request. It delegates the detailed rule checks to `hook_matches`.

*Call graph*: calls 2 internal fn (hook_matches, normalize_host); called by 2 (evaluate_returns_first_matching_hook, evaluate_mitm_hook_request); 1 external calls (get).


##### `compile_mitm_hooks_with_resolvers`  (lines 265–339)

```
fn compile_mitm_hooks_with_resolvers(
    config: &NetworkProxyConfig,
    resolve_env_var: EnvFn,
    read_secret_file: FileFn,
) -> Result<MitmHooksByHost>
```

**Purpose**: Builds the runtime hook table while allowing callers to choose how secrets are resolved. This makes production code read real secrets and tests provide fake ones safely.

**Data flow**: It receives configuration plus two callbacks: one for environment variables and one for secret files → it validates the config, normalizes fields, compiles patterns, parses header names, resolves injected-header secrets, and groups hooks by host → it returns a host-to-hooks map.

**Call relations**: `compile_mitm_hooks` calls this with real environment and file readers. Tests call it with small fake resolvers so they can check behavior without depending on the machine’s environment.

*Call graph*: calls 4 internal fn (compile_path_matchers, normalize_hook_host, normalize_methods, validate_mitm_hook_config); called by 9 (compile_mitm_hooks, compile_resolves_env_backed_injected_headers, evaluate_allows_literal_values_with_reserved_prefixes, evaluate_matches_query_and_header_constraints, evaluate_matches_wildcard_path_query_and_header_constraints, evaluate_path_wildcard_does_not_cross_segment_boundaries, evaluate_returns_first_matching_hook, evaluate_returns_hooked_host_no_match_when_query_constraint_fails, evaluate_treats_glob_metacharacters_as_literal_without_glob_prefix); 1 external calls (new).


##### `compile_injected_header`  (lines 341–381)

```
fn compile_injected_header(
    header: &InjectedHeaderConfig,
    resolve_env_var: &EnvFn,
    read_secret_file: &FileFn,
) -> Result<ResolvedInjectedHeader>
```

**Purpose**: Converts one injected-header rule into a ready-to-use header name and value. It makes sure the header gets its secret from exactly one allowed source.

**Data flow**: It receives an injected-header config and secret resolver callbacks → it parses the header name, reads the secret from either an environment variable or an absolute file path, adds any configured prefix, and checks that the final value is a valid HTTP header value → it returns a resolved injected header with its source recorded.

**Call relations**: Hook compilation calls this for each header that should be added to matching requests. It uses `parse_header_name` and `parse_secret_file` to keep header and file-path rules consistent with validation.

*Call graph*: calls 2 internal fn (parse_header_name, parse_secret_file); 5 external calls (from_str, anyhow!, format!, EnvVar, File).


##### `hook_matches`  (lines 383–404)

```
fn hook_matches(hook: &MitmHook, req: &Request) -> bool
```

**Purpose**: Tests whether one compiled hook applies to one HTTP request. It is the central checklist for method, path, query string, and headers.

**Data flow**: It receives a compiled hook and a request → it compares the request method, then the URI path, then query constraints, then header constraints → it returns true only if every required part matches.

**Call relations**: `evaluate_mitm_hooks` calls this for each hook on the target host. It hands specific checks to `path_matches`, `query_matches`, and `headers_match`.

*Call graph*: calls 3 internal fn (headers_match, path_matches, query_matches); called by 1 (evaluate_mitm_hooks); 2 external calls (method, uri).


##### `query_matches`  (lines 406–430)

```
fn query_matches(query_constraints: &[QueryConstraint], req: &Request) -> bool
```

**Purpose**: Checks whether a request’s query string contains the required query parameters with allowed values. Query parameters are the `?name=value` pieces of a URL.

**Data flow**: It receives query constraints and a request → it parses the request query string into names and values, then checks that each required name exists and at least one value matches an allowed exact or glob matcher → it returns true or false.

**Call relations**: `hook_matches` calls this after the method and path pass. It uses the compiled `ValueMatcher` objects prepared during configuration loading.

*Call graph*: called by 1 (hook_matches); 5 external calls (new, uri, parse, is_empty, iter).


##### `headers_match`  (lines 432–451)

```
fn headers_match(header_constraints: &[HeaderConstraint], req: &Request) -> bool
```

**Purpose**: Checks whether a request has the required headers, and if values are specified, whether at least one value is allowed.

**Data flow**: It receives header constraints and a request → for each required header, it looks up all actual values, rejects missing headers, accepts any value if no allowed values were listed, or tests string values against the allowed matchers → it returns true only if all header constraints pass.

**Call relations**: `hook_matches` calls this as the final gate before a hook is considered matched.

*Call graph*: called by 1 (hook_matches); 1 external calls (iter).


##### `path_matches`  (lines 453–455)

```
fn path_matches(path_prefixes: &[PathMatcher], path: &str) -> bool
```

**Purpose**: Checks whether the request path matches at least one configured path rule. The path is the part of the URL after the host, such as `/repos/openai/codex`.

**Data flow**: It receives a list of path matchers and a path string → it tries each matcher against the path → it returns true as soon as one matcher matches, otherwise false.

**Call relations**: `hook_matches` calls this after the request method matches. It relies on `PathMatcher::matches` for the exact prefix or glob behavior.

*Call graph*: called by 1 (hook_matches); 1 external calls (iter).


##### `PathMatcher::matches`  (lines 458–463)

```
fn matches(&self, candidate: &str) -> bool
```

**Purpose**: Tests one path rule against a candidate path. A rule can be a simple prefix or a glob pattern.

**Data flow**: It receives a path matcher and a candidate path → if the matcher is a prefix, it checks whether the path starts with that text; if it is a glob, it runs the compiled glob matcher → it returns true or false.

**Call relations**: `path_matches` calls this while scanning the hook’s allowed path rules.


##### `ValueMatcher::matches`  (lines 467–472)

```
fn matches(&self, candidate: &str) -> bool
```

**Purpose**: Tests one allowed query or header value against an actual value. It supports either exact text or glob wildcard matching.

**Data flow**: It receives a value matcher and a candidate string → it compares exactly for literal values or runs the compiled glob matcher for patterns → it returns true if the candidate is allowed.

**Call relations**: `query_matches` and `headers_match` use this when checking whether actual request values satisfy compiled constraints.


##### `compile_path_matchers`  (lines 475–493)

```
fn compile_path_matchers(path_prefixes: &[String]) -> Result<Vec<PathMatcher>>
```

**Purpose**: Turns configured path strings into matchers the proxy can use quickly at request time. It also rejects empty path entries.

**Data flow**: It receives configured path prefix strings → each string is interpreted as either a literal prefix or a `pattern:` glob, and glob strings are compiled → it returns a list of path matchers or an error.

**Call relations**: Validation calls this to catch bad path rules early, and hook compilation calls it again to build the runtime matcher objects.

*Call graph*: called by 2 (compile_mitm_hooks_with_resolvers, validate_mitm_hook_config).


##### `compile_value_matchers`  (lines 495–506)

```
fn compile_value_matchers(values: &[String]) -> Result<Vec<ValueMatcher>>
```

**Purpose**: Turns configured allowed values for query parameters or headers into exact or glob matchers.

**Data flow**: It receives value strings → each value is interpreted as a literal, a forced literal with `literal:`, or a glob with `pattern:` → it returns compiled value matchers or an error for invalid patterns.

**Call relations**: Query and header validation call this to ensure value rules are valid before the proxy runs.

*Call graph*: called by 2 (validate_header_constraints, validate_query_constraints).


##### `parse_matcher_pattern`  (lines 508–519)

```
fn parse_matcher_pattern(pattern: &str) -> Result<MatcherPattern<'_>>
```

**Purpose**: Decides whether a configured string means literal text or a wildcard pattern. This avoids surprising behavior by treating wildcard-looking characters as normal text unless `pattern:` is used.

**Data flow**: It receives a pattern string → `literal:` forces the rest to be exact text, `pattern:` makes the rest a glob, and no prefix means exact text → it returns the interpreted pattern type or an error for an empty glob.

**Call relations**: Path and value compilation use this before creating their matchers. It is the small rulebook for the `literal:` and `pattern:` prefixes.

*Call graph*: 3 external calls (anyhow!, Glob, Literal).


##### `compile_glob_matcher`  (lines 521–533)

```
fn compile_glob_matcher(pattern: &str, literal_separator: bool) -> Result<CompiledGlobMatcher>
```

**Purpose**: Compiles a wildcard pattern into an object that can test strings efficiently. For paths, it can be told not to let wildcards cross `/` path segment boundaries.

**Data flow**: It receives a glob pattern and a setting for slash handling → it builds a glob with backslash escaping enabled and the requested separator behavior → it returns a compiled matcher or an error explaining the invalid pattern.

**Call relations**: Path and value matcher compilation call this whenever a config string uses `pattern:`.

*Call graph*: 1 external calls (new).


##### `normalize_hook_host`  (lines 535–546)

```
fn normalize_hook_host(host: &str) -> Result<String>
```

**Purpose**: Cleans and checks the host name used by a hook. MITM hooks must target exact hosts, not wildcard host patterns.

**Data flow**: It receives a host string → it normalizes it using the project’s host normalization logic, rejects empty hosts and hosts containing `*` → it returns the normalized host or an error.

**Call relations**: Validation and compilation both call this so hooks are stored and looked up under the same host spelling that request evaluation uses.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (compile_mitm_hooks_with_resolvers, validate_mitm_hook_config); 1 external calls (anyhow!).


##### `normalize_methods`  (lines 548–559)

```
fn normalize_methods(methods: &[String]) -> Result<Vec<String>>
```

**Purpose**: Cleans HTTP method names such as `post` or ` PUT ` into standard uppercase form. It rejects blank method entries.

**Data flow**: It receives method strings → it trims whitespace, converts each method to uppercase, and checks that none are empty → it returns the normalized list or an error.

**Call relations**: Validation uses this to catch bad configuration, and compilation uses it to prepare method names for fast comparison during request matching.

*Call graph*: called by 2 (compile_mitm_hooks_with_resolvers, validate_mitm_hook_config).


##### `validate_query_constraints`  (lines 561–576)

```
fn validate_query_constraints(query: &BTreeMap<String, Vec<String>>) -> Result<()>
```

**Purpose**: Checks that configured query-parameter rules are meaningful and have valid value matchers.

**Data flow**: It receives a map of query names to allowed values → it verifies each name, requires at least one allowed value for each query key, and compiles the value matchers to catch invalid globs → it returns success or an error.

**Call relations**: `validate_mitm_hook_config` calls this while checking each hook’s match section.

*Call graph*: calls 2 internal fn (compile_value_matchers, normalize_query_name); called by 1 (validate_mitm_hook_config); 1 external calls (anyhow!).


##### `normalize_query_name`  (lines 578–583)

```
fn normalize_query_name(name: &str) -> Result<String>
```

**Purpose**: Checks a query parameter name and returns it in the form used internally. At present it mainly rejects empty names.

**Data flow**: It receives a query name string → it errors if the name is empty, otherwise copies it unchanged → it returns the usable name.

**Call relations**: Query validation and hook compilation call this so configured query keys are consistently accepted or rejected.

*Call graph*: called by 1 (validate_query_constraints); 1 external calls (anyhow!).


##### `validate_header_constraints`  (lines 585–592)

```
fn validate_header_constraints(headers: &BTreeMap<String, Vec<String>>) -> Result<()>
```

**Purpose**: Checks that configured header matching rules use valid HTTP header names and valid allowed-value patterns.

**Data flow**: It receives a map of header names to allowed values → it parses each header name and compiles its value matchers → it returns success or an error with context for the bad header.

**Call relations**: `validate_mitm_hook_config` calls this before hooks are compiled for runtime use.

*Call graph*: calls 2 internal fn (compile_value_matchers, parse_header_name); called by 1 (validate_mitm_hook_config).


##### `validate_strip_request_headers`  (lines 594–599)

```
fn validate_strip_request_headers(header_names: &[String]) -> Result<()>
```

**Purpose**: Checks that headers listed for removal are valid HTTP header names.

**Data flow**: It receives header-name strings → it parses each one as an HTTP header name → it returns success if all names are valid, otherwise an error.

**Call relations**: `validate_mitm_hook_config` calls this for the action that strips request headers.

*Call graph*: calls 1 internal fn (parse_header_name); called by 1 (validate_mitm_hook_config).


##### `validate_injected_headers`  (lines 601–624)

```
fn validate_injected_headers(headers: &[InjectedHeaderConfig]) -> Result<()>
```

**Purpose**: Checks that injected-header actions are well formed before any request is processed. Each injected header must have a valid name and exactly one secret source.

**Data flow**: It receives injected-header configs → it parses each header name, then checks that either `secret_env_var` is a non-empty environment variable name or `secret_file` is a valid absolute path, but not both → it returns success or an error.

**Call relations**: `validate_mitm_hook_config` calls this for the action that adds request headers. Later, compilation resolves the actual secret values.

*Call graph*: calls 2 internal fn (parse_header_name, parse_secret_file); called by 1 (validate_mitm_hook_config); 1 external calls (anyhow!).


##### `parse_header_name`  (lines 626–629)

```
fn parse_header_name(name: &str) -> Result<HeaderName>
```

**Purpose**: Converts a configured string into a typed HTTP header name. This catches invalid characters or malformed names early.

**Data flow**: It receives a header-name string → it asks the HTTP library to parse it from bytes → it returns the parsed header name or a clear error.

**Call relations**: Header validation, strip-header validation, injected-header validation, and injected-header compilation all use this common parser.

*Call graph*: called by 4 (compile_injected_header, validate_header_constraints, validate_injected_headers, validate_strip_request_headers); 1 external calls (from_bytes).


##### `parse_secret_file`  (lines 631–641)

```
fn parse_secret_file(path: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Checks and converts a configured secret-file path. Secret files must be named with an absolute path so the proxy does not depend on an uncertain working directory.

**Data flow**: It receives a path string → it rejects blank strings and relative paths, then converts the path into the project’s absolute-path type → it returns the absolute path or an error.

**Call relations**: Injected-header validation calls this to check configuration, and injected-header compilation calls it before reading a secret from a file.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (compile_injected_header, validate_injected_headers); 2 external calls (new, anyhow!).


##### `tests::base_config`  (lines 653–661)

```
fn base_config() -> NetworkProxyConfig
```

**Purpose**: Creates a small default proxy configuration for tests. It enables MITM so tests can focus on hook behavior unless they intentionally turn MITM off.

**Data flow**: It takes no input → it builds a `NetworkProxyConfig` with limited network mode, MITM enabled, and other settings from defaults → it returns that config.

**Call relations**: Most tests call this as their starting point before adding one or more hook rules.

*Call graph*: calls 1 internal fn (default).


##### `tests::github_hook`  (lines 663–681)

```
fn github_hook() -> MitmHookConfig
```

**Purpose**: Creates a representative test hook for GitHub API requests. It matches write-like repository requests and swaps the authorization header for one based on a token.

**Data flow**: It takes no input → it builds a hook for `api.github.com`, methods `POST` and `PUT`, a repository path prefix, and an injected Authorization header sourced from `CODEX_GITHUB_TOKEN` → it returns the hook config.

**Call relations**: Many tests reuse this fixture and then tweak one field to exercise validation or matching edge cases.

*Call graph*: 2 external calls (default, vec!).


##### `tests::validate_requires_mitm_for_hooks`  (lines 684–694)

```
fn validate_requires_mitm_for_hooks()
```

**Purpose**: Tests that hook configuration is rejected when MITM interception is disabled. Without MITM, the proxy could not inspect and rewrite HTTPS requests safely.

**Data flow**: It creates a base config, disables MITM, adds a hook → it runs validation → it expects an error mentioning that hooks require `network.mitm = true`.

**Call relations**: This test calls `validate_mitm_hook_config` directly to protect the startup validation rule.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 3 external calls (assert!, base_config, vec!).


##### `tests::validate_allows_hooks_in_full_mode`  (lines 697–703)

```
fn validate_allows_hooks_in_full_mode()
```

**Purpose**: Tests that MITM hooks are allowed when the network mode is full, as long as MITM itself is enabled.

**Data flow**: It creates a base config, switches network mode to full, adds a GitHub hook → it validates the config → it expects success.

**Call relations**: This confirms `validate_mitm_hook_config` does not wrongly reject hooks just because the network mode is full.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 2 external calls (base_config, vec!).


##### `tests::validate_rejects_body_matchers_for_now`  (lines 706–716)

```
fn validate_rejects_body_matchers_for_now()
```

**Purpose**: Tests that request-body matching is rejected because it is reserved for a future release. This prevents users from thinking body-based hooks work today.

**Data flow**: It creates a hook with a body matcher → it runs validation → it expects an error saying body matching is reserved.

**Call relations**: This test calls `validate_mitm_hook_config` and documents the current boundary of supported matching.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 5 external calls (assert!, base_config, github_hook, json!, vec!).


##### `tests::validate_rejects_relative_secret_file`  (lines 719–728)

```
fn validate_rejects_relative_secret_file()
```

**Purpose**: Tests that secret files must use absolute paths. This avoids accidentally reading different files depending on where the process starts.

**Data flow**: It changes the injected header to use `token.txt` as a file secret → it validates the config → it expects an error about absolute paths.

**Call relations**: This protects the behavior implemented by `parse_secret_file` and reached through `validate_mitm_hook_config`.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 4 external calls (assert!, base_config, github_hook, vec!).


##### `tests::validate_rejects_dual_secret_sources`  (lines 731–739)

```
fn validate_rejects_dual_secret_sources()
```

**Purpose**: Tests that an injected header cannot specify both an environment variable and a file as its secret source.

**Data flow**: It creates a hook whose injected header has both secret fields set → it runs validation → it expects an error saying exactly one source is required.

**Call relations**: This verifies the secret-source rule in `validate_injected_headers` through the main config validator.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 4 external calls (assert!, base_config, github_hook, vec!).


##### `tests::compile_resolves_env_backed_injected_headers`  (lines 742–763)

```
fn compile_resolves_env_backed_injected_headers()
```

**Purpose**: Tests that compilation can resolve an injected header from an environment-variable-like source. It uses a fake resolver instead of the real process environment.

**Data flow**: It builds a config with the GitHub hook → it compiles hooks with a resolver that returns `ghp-secret` for `CODEX_GITHUB_TOKEN` → it checks that the compiled header records the environment source and has value `Bearer ghp-secret`.

**Call relations**: This calls `compile_mitm_hooks_with_resolvers`, showing why that helper accepts resolver callbacks.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 3 external calls (assert_eq!, base_config, vec!).


##### `tests::compile_resolves_file_backed_injected_headers`  (lines 766–783)

```
fn compile_resolves_file_backed_injected_headers()
```

**Purpose**: Tests that compilation can read an injected-header secret from a file and trim the trailing newline.

**Data flow**: It writes a temporary file containing a token, configures the hook to use that file, and compiles hooks → it checks that the injected header value contains `Bearer ghp-file-secret` → the compiled hook is returned from the host map.

**Call relations**: This uses the production `compile_mitm_hooks` path, including real file reading.

*Call graph*: calls 1 internal fn (compile_mitm_hooks); 6 external calls (new, assert_eq!, base_config, github_hook, write, vec!).


##### `tests::evaluate_returns_first_matching_hook`  (lines 786–816)

```
fn evaluate_returns_first_matching_hook()
```

**Purpose**: Tests that when multiple hooks for the same host match, the first one in configuration order wins.

**Data flow**: It creates two similar hooks with different injected-header prefixes → it compiles them, builds a matching POST request, and evaluates it → it expects the actions from the first hook.

**Call relations**: This checks the ordering behavior in `evaluate_mitm_hooks`, which stops at the first `hook_matches` success.

*Call graph*: calls 2 internal fn (compile_mitm_hooks_with_resolvers, evaluate_mitm_hooks); 7 external calls (assert_eq!, builder, empty, base_config, github_hook, panic!, vec!).


##### `tests::evaluate_matches_query_and_header_constraints`  (lines 819–851)

```
fn evaluate_matches_query_and_header_constraints()
```

**Purpose**: Tests that a hook can require both a query parameter and a header value before it matches.

**Data flow**: It adds query and header constraints to the GitHub hook → it compiles hooks, builds a request containing matching query and header values → it expects `evaluate_mitm_hooks` to return matched actions.

**Call relations**: This exercises `query_matches` and `headers_match` through the public evaluation function.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_matches_wildcard_path_query_and_header_constraints`  (lines 854–885)

```
fn evaluate_matches_wildcard_path_query_and_header_constraints()
```

**Purpose**: Tests that `pattern:` wildcard rules work for paths, query values, and header values.

**Data flow**: It configures glob patterns for the path, query value, and header value → it compiles hooks and builds a request that fits those patterns → it expects the hook to match.

**Call relations**: This covers the flow from `parse_matcher_pattern` and `compile_glob_matcher` through request evaluation.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::validate_rejects_invalid_wildcard_path_pattern`  (lines 888–896)

```
fn validate_rejects_invalid_wildcard_path_pattern()
```

**Purpose**: Tests that a bad path glob is rejected during validation rather than failing later during request handling.

**Data flow**: It sets a malformed `pattern:` path rule → it runs validation → it expects an error mentioning an invalid glob pattern.

**Call relations**: This verifies that `validate_mitm_hook_config` catches errors from `compile_path_matchers`.

*Call graph*: calls 1 internal fn (validate_mitm_hook_config); 4 external calls (assert!, base_config, github_hook, vec!).


##### `tests::evaluate_path_wildcard_does_not_cross_segment_boundaries`  (lines 899–921)

```
fn evaluate_path_wildcard_does_not_cross_segment_boundaries()
```

**Purpose**: Tests an important path-matching detail: wildcard path patterns do not let `*` skip across `/` separators.

**Data flow**: It configures a path glob expecting one path segment between `/repos/` and `/codex/` → it evaluates a nested path with an extra segment → it expects no hook match.

**Call relations**: This protects the `literal_separator` setting used by `compile_glob_matcher` for path patterns.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 6 external calls (assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_treats_glob_metacharacters_as_literal_without_glob_prefix`  (lines 924–964)

```
fn evaluate_treats_glob_metacharacters_as_literal_without_glob_prefix()
```

**Purpose**: Tests that characters like `*` and `[` are treated as normal text unless the config explicitly uses `pattern:`.

**Data flow**: It configures path, query, and header values that look like glob patterns but lack the `pattern:` prefix → it evaluates one exact request and one pattern-like request → only the exact literal request matches.

**Call relations**: This verifies the default behavior of `parse_matcher_pattern` through compiled hook evaluation.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_allows_literal_values_with_reserved_prefixes`  (lines 967–1007)

```
fn evaluate_allows_literal_values_with_reserved_prefixes()
```

**Purpose**: Tests that users can match text beginning with reserved words like `pattern:` by writing `literal:` first.

**Data flow**: It configures query and header values as `literal:pattern:*` → it evaluates a request whose actual values are exactly `pattern:*` and another with different values → only the exact literal request matches.

**Call relations**: This protects the escape-hatch behavior in `parse_matcher_pattern`.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_returns_hooked_host_no_match_when_query_constraint_fails`  (lines 1010–1032)

```
fn evaluate_returns_hooked_host_no_match_when_query_constraint_fails()
```

**Purpose**: Tests that a configured host with a non-matching query value reports “hooked host, no match” rather than “no hooks.”

**Data flow**: It configures a required query value of `open`, then evaluates a request with `state=closed` → it expects the no-match result for a hooked host.

**Call relations**: This checks the distinction made by `evaluate_mitm_hooks` after `hook_matches` fails.

*Call graph*: calls 1 internal fn (compile_mitm_hooks_with_resolvers); 7 external calls (from, assert_eq!, builder, empty, base_config, github_hook, vec!).


##### `tests::evaluate_returns_no_hooks_for_unconfigured_host`  (lines 1035–1046)

```
fn evaluate_returns_no_hooks_for_unconfigured_host()
```

**Purpose**: Tests that evaluating an empty hook table reports that no hooks exist for the host.

**Data flow**: It builds a POST request and passes an empty host-to-hooks map → evaluation finds no entry for the normalized host → it returns `NoHooksForHost`.

**Call relations**: This covers the early lookup branch in `evaluate_mitm_hooks`.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


### Proxy enforcement pipeline
These files provide the certificate, policy, response, upstream, and MITM machinery that implements managed HTTP and HTTPS proxy enforcement.

### `network-proxy/src/certs.rs`

`domain_logic` · `startup and HTTPS request handling`

HTTPS normally prevents a proxy from reading traffic because each site proves its identity with a certificate. This file supports a controlled “MITM” setup, meaning “man in the middle”: the proxy creates a local certificate authority, then uses it to make short-lived certificates for the sites being proxied. In everyday terms, it is like giving the proxy its own trusted notary stamp so it can issue convincing-looking papers for each destination while traffic passes through it.

The file first finds a Codex-owned directory and either loads an existing certificate authority or creates a new one. It treats the private key as a secret: on Unix it rejects unsafe permissions and refuses symlinks, and when writing files it uses careful create-new, atomic-style writes so it does not silently overwrite important material.

For each host, it creates a fresh server certificate signed by the managed authority and turns it into TLS server settings that support HTTP/2 and HTTP/1.1. It can also build a CA bundle: the system’s normal trusted roots plus the Codex managed CA. That bundle is saved under a content-based name and can be pointed to by common environment variables used by curl, Git, Node, Python, npm, and similar tools.

#### Function details

##### `ManagedMitmCa::load_or_create`  (lines 43–49)

```
fn load_or_create() -> Result<Self>
```

**Purpose**: Loads the proxy’s managed certificate authority, creating it first if needed. This gives the proxy the signing identity it needs before it can make per-host HTTPS certificates.

**Data flow**: It reads the stored CA certificate and private key, or causes them to be created. It parses the private key and combines it with the certificate into an issuer object. The result is a ManagedMitmCa value ready to sign host certificates.

**Call relations**: When higher-level proxy setup calls new, this method prepares the certificate authority by delegating storage work to load_or_create_ca and parsing the returned PEM text with the TLS certificate libraries.

*Call graph*: calls 1 internal fn (load_or_create_ca); called by 1 (new); 2 external calls (from_ca_cert_pem, from_pem).


##### `ManagedMitmCa::tls_acceptor_data_for_host`  (lines 51–68)

```
fn tls_acceptor_data_for_host(&self, host: &str) -> Result<TlsAcceptorData>
```

**Purpose**: Builds TLS server settings for one destination host, using a certificate that looks valid for that host. The proxy uses this when it needs to accept an HTTPS connection from a client.

**Data flow**: It takes a host name or IP address and the already-loaded CA issuer. It asks for a freshly signed host certificate and key, parses them into rustls certificate objects, builds a server configuration, and advertises HTTP/2 and HTTP/1.1. It returns TlsAcceptorData that the proxy can use to perform the TLS handshake.

**Call relations**: When the proxy’s TLS path asks for acceptor data for a host, this method calls issue_host_certificate_pem to mint the certificate, then hands the finished rustls configuration to the surrounding networking layer.

*Call graph*: calls 1 internal fn (issue_host_certificate_pem); called by 1 (tls_acceptor_data_for_host); 5 external calls (from_pem_slice, from_pem_slice, from, builder_with_protocol_versions, vec!).


##### `issue_host_certificate_pem`  (lines 71–98)

```
fn issue_host_certificate_pem(
    host: &str,
    issuer: &Issuer<'_, KeyPair>,
) -> Result<(String, String)>
```

**Purpose**: Creates a new certificate and private key for a specific host, signed by the managed CA. This is the core step that lets the proxy impersonate the requested HTTPS server to the local client.

**Data flow**: It receives a host string and a CA issuer. If the host is an IP address, it records it as an IP subject; otherwise it records it as a DNS name. It sets the certificate’s purpose to server authentication, generates a fresh key pair, signs the certificate with the CA, and returns both certificate and key as PEM text.

**Call relations**: ManagedMitmCa::tls_acceptor_data_for_host calls this whenever a TLS configuration is needed for a particular host, then parses the returned PEM strings into runtime TLS objects.

*Call graph*: called by 1 (tls_acceptor_data_for_host); 5 external calls (new, generate_for, IpAddress, new, vec!).


##### `managed_ca_paths`  (lines 127–135)

```
fn managed_ca_paths() -> Result<(PathBuf, PathBuf)>
```

**Purpose**: Decides where the managed CA certificate and private key live on disk. This keeps all code using the same predictable Codex home location.

**Data flow**: It asks for the Codex home directory, appends the proxy subdirectory, and then adds the certificate and key file names. It returns the two full paths.

**Call relations**: The CA loading, trust bundle creation, and trust bundle path checking code all call this so they agree on the same storage location.

*Call graph*: called by 3 (is_managed_mitm_ca_trust_bundle_path, load_or_create_ca, managed_ca_trust_bundle); 1 external calls (find_codex_home).


##### `managed_ca_trust_bundle`  (lines 137–143)

```
fn managed_ca_trust_bundle(
    env: &HashMap<&'static str, String>,
) -> Result<ManagedMitmCaTrustBundle>
```

**Purpose**: Creates or refreshes a certificate trust bundle that includes the managed CA. This lets child programs trust HTTPS certificates generated by the proxy.

**Data flow**: It receives startup environment values. It first ensures the managed CA exists, finds the CA certificate path, and then builds and saves a bundle based on that certificate. It returns the bundle path plus any original CA-related environment values that should be remembered.

**Call relations**: Configuration setup calls this from from_config when it needs to prepare the environment for child tools. It delegates the actual bundle work to managed_ca_trust_bundle_for_cert_path.

*Call graph*: calls 3 internal fn (load_or_create_ca, managed_ca_paths, managed_ca_trust_bundle_for_cert_path); called by 1 (from_config).


##### `managed_ca_trust_bundle_for_cert_path`  (lines 145–164)

```
fn managed_ca_trust_bundle_for_cert_path(
    cert_path: &Path,
    env: &HashMap<&'static str, String>,
) -> Result<ManagedMitmCaTrustBundle>
```

**Purpose**: Builds a trust bundle for a specific managed CA certificate path and records relevant startup environment settings. This is useful both in real setup and in tests with temporary paths.

**Data flow**: It receives a certificate path and a map of environment variables. It keeps only non-empty values from known CA-related variable names, builds the bundle text, writes it to disk, and returns a ManagedMitmCaTrustBundle with the saved path and remembered environment values.

**Call relations**: managed_ca_trust_bundle calls this after locating the real CA file. The test for startup CA environment values also calls it directly so it can check the environment-recording behavior.

*Call graph*: calls 2 internal fn (build_managed_ca_trust_bundle, persist_managed_ca_trust_bundle); called by 2 (managed_ca_trust_bundle, managed_ca_trust_bundle_records_startup_ca_env_values).


##### `build_managed_ca_trust_bundle`  (lines 166–181)

```
fn build_managed_ca_trust_bundle(managed_ca_cert_path: &Path) -> Result<String>
```

**Purpose**: Assembles the actual PEM text for a trust bundle. The bundle combines the computer’s normal trusted certificates with the proxy’s managed CA certificate.

**Data flow**: It starts with an empty string, loads native root certificates from the operating system, converts each one into PEM format, then appends the managed CA PEM file. It returns one combined text block.

**Call relations**: managed_ca_trust_bundle_for_cert_path calls this before saving the bundle. It uses push_certificate_pem for native certificates and append_pem_file for the managed CA file, and warns if some native certificates could not be loaded.

*Call graph*: calls 2 internal fn (append_pem_file, push_certificate_pem); called by 1 (managed_ca_trust_bundle_for_cert_path); 3 external calls (new, load_native_certs, warn!).


##### `is_current_generated_trust_bundle_path`  (lines 183–206)

```
fn is_current_generated_trust_bundle_path(path: &Path, managed_ca_cert_path: &Path) -> bool
```

**Purpose**: Checks whether a path points to a current Codex-generated trust bundle for the managed CA. This helps distinguish Codex’s own bundle from an old or unrelated file.

**Data flow**: It receives a candidate path and the managed CA certificate path. It checks that the file is in the same proxy directory, has the expected bundle name pattern, and contains the current managed CA certificate bytes. It returns true only if all checks pass.

**Call relations**: is_managed_mitm_ca_trust_bundle_path uses this after finding the real managed CA location. The stale-bundle test exercises this check to make sure an old bundle is rejected.

*Call graph*: called by 1 (is_managed_mitm_ca_trust_bundle_path); 3 external calls (file_name, parent, read).


##### `is_managed_mitm_ca_trust_bundle_path`  (lines 209–214)

```
fn is_managed_mitm_ca_trust_bundle_path(path: &str) -> bool
```

**Purpose**: Provides a public yes-or-no check for whether a string path is one of the current managed MITM CA bundles. This is useful when deciding whether an existing environment setting came from Codex itself.

**Data flow**: It receives a path as text. It resolves the managed CA certificate path, converts the input into a filesystem path, and asks the lower-level checker whether it is a current generated bundle. If the CA location cannot be resolved, it returns false.

**Call relations**: This is the externally visible wrapper around is_current_generated_trust_bundle_path. It hides the need for callers to know where Codex stores the managed CA.

*Call graph*: calls 2 internal fn (is_current_generated_trust_bundle_path, managed_ca_paths); 1 external calls (new).


##### `persist_managed_ca_trust_bundle`  (lines 216–241)

```
fn persist_managed_ca_trust_bundle(
    managed_ca_cert_path: &Path,
    trust_bundle: &str,
) -> Result<PathBuf>
```

**Purpose**: Saves a generated trust bundle to disk under a name based on its contents. This avoids rewriting identical bundles and makes the filename change when the bundle changes.

**Data flow**: It receives the managed CA certificate path and the bundle text. It creates the proxy directory if needed, hashes the bundle text with SHA-256, builds a ca-bundle-<hash>.pem filename, writes or reuses that exact file safely, and returns the path.

**Call relations**: managed_ca_trust_bundle_for_cert_path calls this after building the bundle. It relies on write_atomic_create_new_or_reuse to avoid unsafe overwrites or symlink reuse.

*Call graph*: calls 1 internal fn (write_atomic_create_new_or_reuse); called by 1 (managed_ca_trust_bundle_for_cert_path); 4 external calls (parent, digest, format!, create_dir_all).


##### `append_pem_file`  (lines 243–254)

```
fn append_pem_file(bundle: &mut String, path: &Path) -> Result<()>
```

**Purpose**: Adds an existing PEM file to the end of a bundle string. It keeps newline boundaries tidy so certificates do not run together.

**Data flow**: It receives a mutable bundle string and a path. It makes sure the bundle ends with a newline, reads the file as text, appends it, and again ensures there is a final newline. It changes the bundle string in place.

**Call relations**: build_managed_ca_trust_bundle calls this to append the managed CA certificate after adding the operating system’s native certificates.

*Call graph*: called by 1 (build_managed_ca_trust_bundle); 1 external calls (read_to_string).


##### `push_certificate_pem`  (lines 256–264)

```
fn push_certificate_pem(bundle: &mut String, der: &[u8])
```

**Purpose**: Converts one binary certificate into PEM text and appends it to a bundle. PEM is the familiar text format with BEGIN CERTIFICATE and END CERTIFICATE lines.

**Data flow**: It receives a mutable bundle string and raw certificate bytes. It base64-encodes the bytes, wraps the text at 64-character lines, surrounds it with PEM header and footer lines, and appends everything to the bundle.

**Call relations**: build_managed_ca_trust_bundle calls this once for each native root certificate loaded from the system.

*Call graph*: called by 1 (build_managed_ca_trust_bundle); 1 external calls (from_utf8_lossy).


##### `load_or_create_ca`  (lines 266–313)

```
fn load_or_create_ca() -> Result<(String, String)>
```

**Purpose**: Loads the managed CA certificate and key from disk, or creates and saves a new pair if neither exists. It protects against half-created or unsafe CA state.

**Data flow**: It finds the certificate and key paths. If either file exists, it requires both, validates the key file, reads both PEM files, and returns their text. If neither exists, it creates directories, generates a new CA, writes the key privately and the certificate readably, cleans up the key if certificate writing fails, logs success, and returns the new PEM text.

**Call relations**: ManagedMitmCa::load_or_create calls this before parsing the CA into an issuer. managed_ca_trust_bundle also calls it to ensure the CA certificate exists before building a trust bundle.

*Call graph*: calls 4 internal fn (generate_ca, managed_ca_paths, validate_existing_ca_key_file, write_atomic_create_new); called by 2 (load_or_create, managed_ca_trust_bundle); 5 external calls (anyhow!, create_dir_all, read_to_string, remove_file, info!).


##### `generate_ca`  (lines 315–333)

```
fn generate_ca() -> Result<(String, String)>
```

**Purpose**: Creates a brand-new certificate authority for the proxy. This is the one-time source of trust used to sign all later host certificates.

**Data flow**: It builds certificate settings that mark the certificate as a CA, gives it signing-related key usages, sets a readable common name, generates an ECDSA key pair, self-signs the certificate, and returns certificate and key as PEM text.

**Call relations**: load_or_create_ca calls this only when no managed CA files already exist. The generated PEM strings are then written to disk for future runs.

*Call graph*: called by 1 (load_or_create_ca); 5 external calls (default, new, Ca, generate_for, vec!).


##### `write_atomic_create_new`  (lines 335–393)

```
fn write_atomic_create_new(path: &Path, contents: &[u8], mode: u32) -> Result<()>
```

**Purpose**: Writes a new file carefully, refusing to overwrite an existing one. This is important for secrets like private keys, where accidental replacement would break trust and could be unsafe.

**Data flow**: It receives a destination path, bytes, and a file permission mode. It writes the bytes to a uniquely named temporary file, flushes it to disk, then tries to create the final path without overwriting. It removes temporary files where possible, syncs the parent directory, and returns success or an error.

**Call relations**: load_or_create_ca uses this for the CA key and certificate. write_atomic_create_new_or_reuse uses it when it needs to create a bundle file that does not already exist.

*Call graph*: calls 2 internal fn (open_create_new_with_mode, sync_parent_dir); called by 2 (load_or_create_ca, write_atomic_create_new_or_reuse); 10 external calls (exists, file_name, parent, now, anyhow!, format!, hard_link, remove_file, rename, id).


##### `sync_parent_dir`  (lines 404–406)

```
fn sync_parent_dir(_parent: &Path) -> Result<()>
```

**Purpose**: Makes the parent directory’s file listing durable after a new file is created. On Unix this reduces the chance that a crash loses the directory entry even if the file contents were written.

**Data flow**: On Unix, it receives a directory path, opens that directory, and asks the operating system to flush it to storage. On Windows, the equivalent implementation does nothing and reports success.

**Call relations**: write_atomic_create_new calls this after creating the final file so the filesystem state is as durable as practical.

*Call graph*: called by 1 (write_atomic_create_new); 1 external calls (open).


##### `write_atomic_create_new_or_reuse`  (lines 408–429)

```
fn write_atomic_create_new_or_reuse(path: &Path, contents: &[u8], mode: u32) -> Result<()>
```

**Purpose**: Writes a file safely, but reuses it if it already contains exactly the desired bytes. This is used for content-addressed bundle files, where identical content should not be an error.

**Data flow**: It receives a path, bytes, and permissions. It first rejects symlinks, then returns success if the existing file already matches. If a different file exists, it errors. Otherwise it tries to create the file atomically, and if another process created the same matching file at the same time, it accepts that.

**Call relations**: persist_managed_ca_trust_bundle calls this when saving the trust bundle. The symlink rejection test calls it directly to confirm it will not follow a link even when the target has matching contents.

*Call graph*: calls 1 internal fn (write_atomic_create_new); called by 2 (persist_managed_ca_trust_bundle, write_atomic_create_new_or_reuse_rejects_matching_symlink_target); 4 external calls (exists, anyhow!, read, symlink_metadata).


##### `validate_existing_ca_key_file`  (lines 462–464)

```
fn validate_existing_ca_key_file(_path: &Path) -> Result<()>
```

**Purpose**: Checks that an existing CA private key file is safe to use. On Unix it rejects symlinks, non-files, and keys readable by group or world users.

**Data flow**: It receives a key path. On Unix, it reads file metadata without following symlinks, checks the file type and permission bits, and returns an error if the key is exposed or suspicious. On non-Unix systems, it performs no extra checks and returns success.

**Call relations**: load_or_create_ca calls this before trusting an existing key file. The Unix tests call it with unsafe permissions, symlinks, and private permissions to verify the safety rules.

*Call graph*: called by 4 (load_or_create_ca, validate_existing_ca_key_file_allows_private_permissions, validate_existing_ca_key_file_rejects_group_world_permissions, validate_existing_ca_key_file_rejects_symlink); 2 external calls (anyhow!, symlink_metadata).


##### `open_create_new_with_mode`  (lines 479–485)

```
fn open_create_new_with_mode(path: &Path, _mode: u32) -> Result<File>
```

**Purpose**: Opens a new file for writing with create-new behavior, applying requested permissions where the platform supports them. This is the low-level helper used by safe file creation.

**Data flow**: It receives a path and a permission mode. On Unix it opens the file for writing, requires that it not already exist, and sets the given mode at creation time. On other systems it creates the file without the Unix-specific mode setting. It returns an open File object.

**Call relations**: write_atomic_create_new calls this to create its temporary file before writing contents and linking or renaming it into place.

*Call graph*: called by 1 (write_atomic_create_new); 1 external calls (new).


##### `tests::current_generated_trust_bundle_path_rejects_stale_bundle`  (lines 498–508)

```
fn current_generated_trust_bundle_path_rejects_stale_bundle()
```

**Purpose**: Checks that an old-looking trust bundle is not accepted just because its filename matches the expected pattern. The bundle must contain the current managed CA certificate.

**Data flow**: It creates a temporary directory, writes a current CA certificate file and a separate stale bundle file, then asks the checker about the stale bundle. The expected result is false.

**Call relations**: This test exercises is_current_generated_trust_bundle_path directly, protecting the path-identification logic used by is_managed_mitm_ca_trust_bundle_path.

*Call graph*: 3 external calls (assert!, write, tempdir).


##### `tests::managed_ca_trust_bundle_records_startup_ca_env_values`  (lines 511–522)

```
fn managed_ca_trust_bundle_records_startup_ca_env_values()
```

**Purpose**: Checks that the trust bundle setup remembers original CA-related environment values. This matters because Codex may need to know what the user or parent process had configured before Codex changes anything.

**Data flow**: It creates a temporary CA certificate file and a small environment map containing SSL_CERT_FILE. It builds a trust bundle for that path and confirms the returned startup_env_values contains the original value.

**Call relations**: This test calls managed_ca_trust_bundle_for_cert_path directly so it can avoid the real Codex home directory while verifying the environment-recording part of bundle creation.

*Call graph*: calls 1 internal fn (managed_ca_trust_bundle_for_cert_path); 4 external calls (from, assert_eq!, write, tempdir).


##### `tests::validate_existing_ca_key_file_rejects_group_world_permissions`  (lines 526–537)

```
fn validate_existing_ca_key_file_rejects_group_world_permissions()
```

**Purpose**: Checks that a CA private key with loose Unix permissions is rejected. A private key readable by other users would weaken the whole proxy trust model.

**Data flow**: It creates a temporary key file, changes its permissions to be group/world readable, calls validate_existing_ca_key_file, and checks that the error mentions group/world access.

**Call relations**: This test covers the Unix safety rule that load_or_create_ca relies on before accepting an existing CA key.

*Call graph*: calls 1 internal fn (validate_existing_ca_key_file); 5 external calls (assert!, from_mode, set_permissions, write, tempdir).


##### `tests::validate_existing_ca_key_file_rejects_symlink`  (lines 541–555)

```
fn validate_existing_ca_key_file_rejects_symlink()
```

**Purpose**: Checks that the CA private key cannot be a symbolic link, which is a filesystem shortcut that could point somewhere unexpected. Rejecting symlinks avoids a common class of file-substitution attacks.

**Data flow**: It creates a real temporary key file, creates a symlink named like the CA key, calls validate_existing_ca_key_file on the link, and confirms the error mentions a symlink.

**Call relations**: This test protects the symlink rejection used by load_or_create_ca when it validates an existing key.

*Call graph*: calls 1 internal fn (validate_existing_ca_key_file); 3 external calls (assert!, write, tempdir).


##### `tests::validate_existing_ca_key_file_allows_private_permissions`  (lines 559–566)

```
fn validate_existing_ca_key_file_allows_private_permissions()
```

**Purpose**: Checks that a CA private key with safe Unix permissions is accepted. This prevents the safety check from being so strict that normal private keys stop working.

**Data flow**: It creates a temporary key file, sets its permissions to private owner-only access, and calls validate_existing_ca_key_file. The expected result is success.

**Call relations**: This test confirms the positive path for the same validation that load_or_create_ca runs on existing CA keys.

*Call graph*: calls 1 internal fn (validate_existing_ca_key_file); 4 external calls (from_mode, set_permissions, write, tempdir).


##### `tests::write_atomic_create_new_or_reuse_rejects_matching_symlink_target`  (lines 570–585)

```
fn write_atomic_create_new_or_reuse_rejects_matching_symlink_target()
```

**Purpose**: Checks that a trust bundle path is rejected if it is a symlink, even when the symlink target has exactly the desired contents. This avoids treating attacker-controlled shortcuts as safe reusable files.

**Data flow**: It creates a real file containing bundle text, creates a symlink to it, calls write_atomic_create_new_or_reuse with matching contents, and checks for the exact refusal message.

**Call relations**: This test exercises the helper used by persist_managed_ca_trust_bundle, making sure bundle persistence does not follow or reuse symlinks.

*Call graph*: calls 1 internal fn (write_atomic_create_new_or_reuse); 3 external calls (assert_eq!, write, tempdir).


### `network-proxy/src/responses.rs`

`io_transport` · `request handling`

The network proxy sits between a client and the outside network. When it needs to answer the client directly, especially when it refuses a request, this file provides the small response-building tools it uses. Without this file, different parts of the proxy would likely invent their own error messages and headers, making blocked requests harder for people and programs to understand.

The file has helpers for plain text responses, JSON responses, and “blocked” responses. A blocked response always uses HTTP 403 Forbidden, which means “the server understood the request but refuses to allow it.” It also adds an x-proxy-error header. That header is like a short label on a rejected form: it tells software why the request was refused, such as allowlist failure, denylist failure, method policy, or MITM policy. MITM means “man in the middle,” here referring to proxy inspection of HTTPS traffic.

The file also defines PolicyDecisionDetails, a bundle of extra facts about a policy decision, such as the protocol, host, port, and decision source. At the moment, the message-with-policy helper mostly returns the same simple human message, but the shape is ready for richer messages later.

#### Function details

##### `text_response`  (lines 26–32)

```
fn text_response(status: StatusCode, body: &str) -> Response
```

**Purpose**: Builds a simple plain-text HTTP response with the status code and message chosen by the caller. It is useful when the proxy needs to send a direct human-readable answer instead of forwarding the request onward.

**Data flow**: It receives an HTTP status code and a text body. It puts those into a new response, sets the content type to text/plain, and returns the finished response. If the normal response builder fails, it falls back to a simpler response containing the same text.

**Call relations**: This helper is used by MITM-related request paths when they need to return a direct text answer. In that flow, policy or hook logic decides what should be said, and this function packages that decision into an HTTP response the client can receive.

*Call graph*: called by 2 (evaluate_mitm_policy, handle_mitm_request); 2 external calls (builder, from).


##### `json_response`  (lines 34–50)

```
fn json_response(value: &T) -> Response
```

**Purpose**: Builds an HTTP response whose body is JSON, which is structured text that programs can easily read. It is used when the proxy wants to report information in a machine-friendly format rather than plain text.

**Data flow**: It receives any value that can be serialized, meaning converted into JSON text. It tries to turn that value into JSON; if conversion fails, it logs an error and uses an empty JSON object instead. It then returns a 200 OK response with content type application/json, again falling back to an empty JSON object if response construction fails.

**Call relations**: This function is called when building a JSON-form blocked response. The higher-level blocked-response code decides what information should be reported, and this helper takes responsibility for turning that information into a valid HTTP response.

*Call graph*: called by 1 (json_blocked); 4 external calls (builder, error!, from, to_string).


##### `blocked_header_value`  (lines 52–61)

```
fn blocked_header_value(reason: &str) -> &'static str
```

**Purpose**: Translates an internal block reason into a short header value that software can inspect. This makes policy failures easier to classify without reading the full human message.

**Data flow**: It receives a reason string, compares it with the known policy reason constants, and returns a fixed label such as blocked-by-allowlist or blocked-by-denylist. If the reason is unfamiliar, it returns the general label blocked-by-policy.

**Call relations**: Blocked response builders call this function when adding the x-proxy-error header. It is also used by JSON blocked-response code, so both text and JSON error replies use the same reason labels.

*Call graph*: called by 3 (json_blocked, blocked_text_response, blocked_text_response_with_policy).


##### `blocked_message`  (lines 63–74)

```
fn blocked_message(reason: &str) -> &'static str
```

**Purpose**: Turns an internal block reason into a clear sentence for a person. It explains, in ordinary language, why the proxy refused the request.

**Data flow**: It receives a reason string and matches it against the known policy reasons. It returns a fixed human-readable message, such as “Domain not in allowlist.” If the reason is unknown, it returns a general blocked-by-policy message.

**Call relations**: This is the central wording source for blocked text. Simple blocked responses use it directly, while the policy-aware message helper uses it as the current base message.

*Call graph*: called by 2 (blocked_message_with_policy, blocked_text_response).


##### `blocked_text_response`  (lines 76–83)

```
fn blocked_text_response(reason: &str) -> Response
```

**Purpose**: Creates a standard plain-text HTTP 403 Forbidden response for a blocked request. It includes both a human-readable message and a short machine-readable error header.

**Data flow**: It receives a policy reason. It asks blocked_header_value for the x-proxy-error header, asks blocked_message for the response body, builds a text/plain forbidden response, and returns it. If building the response fails, it returns a minimal response containing “blocked.”

**Call relations**: MITM policy evaluation calls this when it decides a request must be refused. The policy code supplies the reason, and this function turns that reason into the actual HTTP response sent back to the client.

*Call graph*: calls 2 internal fn (blocked_header_value, blocked_message); called by 1 (evaluate_mitm_policy); 2 external calls (builder, from).


##### `blocked_message_with_policy`  (lines 84–87)

```
fn blocked_message_with_policy(reason: &str, details: &PolicyDecisionDetails<'_>) -> String
```

**Purpose**: Returns the human-readable blocked message while accepting extra policy details for possible richer explanations. Today it keeps the wording simple and delegates to blocked_message.

**Data flow**: It receives a reason and a PolicyDecisionDetails object containing context such as decision, source, protocol, host, and port. It currently ignores most of that extra context, converts the basic blocked message into an owned string, and returns it.

**Call relations**: This helper is used by several places that already have detailed policy context, such as proxy-disabled responses and policy-denied errors. It gives those callers one shared place to get user-facing wording, and the test in this file checks that it returns the expected simple message.

*Call graph*: calls 1 internal fn (blocked_message); called by 4 (proxy_disabled_response, blocked_text_response_with_policy, blocked_message_with_policy_returns_human_message, policy_denied_error).


##### `blocked_text_response_with_policy`  (lines 89–99)

```
fn blocked_text_response_with_policy(
    reason: &str,
    details: &PolicyDecisionDetails<'_>,
) -> Response
```

**Purpose**: Creates a standard plain-text 403 Forbidden response when the caller has detailed policy information available. It preserves the same response shape as simpler blocked replies while routing the message through the policy-aware helper.

**Data flow**: It receives a reason and policy details. It converts the reason into an x-proxy-error header, converts the reason and details into a response message, builds a text/plain forbidden response, and returns it. If construction fails, it returns a minimal “blocked” response.

**Call relations**: This is used by the path that builds blocked text responses with details. That higher-level code provides the policy context, and this function packages it into the final HTTP response sent to the requester.

*Call graph*: calls 2 internal fn (blocked_header_value, blocked_message_with_policy); called by 1 (blocked_text_with_details); 2 external calls (builder, from).


##### `tests::blocked_message_with_policy_returns_human_message`  (lines 108–120)

```
fn blocked_message_with_policy_returns_human_message()
```

**Purpose**: Checks that the policy-aware blocked-message helper returns the expected plain-language text for an allowlist failure. This protects the user-facing wording from accidental changes.

**Data flow**: It creates sample policy details for a denied HTTPS connection to api.example.com. It passes those details and the not-allowed reason into blocked_message_with_policy, then compares the returned message with the expected sentence.

**Call relations**: This test exercises blocked_message_with_policy directly. It stands as a small safety check for code paths that rely on that helper, including policy-denied and detailed blocked-response flows.

*Call graph*: calls 1 internal fn (blocked_message_with_policy); 1 external calls (assert_eq!).


### `network-proxy/src/connect_policy.rs`

`domain_logic` · `request handling`

A network proxy can be risky if it is allowed to connect anywhere. For example, someone could ask it to reach localhost or a private company network address, turning the proxy into a doorway to places that should not be exposed. This file prevents that by wrapping normal TCP connection creation with a target check.

The main wrapper is `TargetCheckedTcpConnector`. When a request wants a TCP connection, it decides whether to use the normal connector directly or a guarded connector. If the request already contains a `ProxyAddress`, it passes through without this target check. Otherwise, it uses `TargetCheckedStreamConnector`, which looks at the final socket address before dialing it.

The important rule is simple: if local/private targets are not allowed, and the destination IP address is non-public, the connection is refused with a permission error. If the rule allows it, the file opens the real TCP connection.

The rule can come from two places. `TargetPolicy::Config` stores a fixed yes/no setting. `TargetPolicy::State` reads the current proxy state, so the setting can come from live network proxy configuration. In everyday terms, this file is like a security guard at the door: it checks whether the requested destination is allowed before letting the proxy walk through.

#### Function details

##### `TargetCheckedTcpConnector::new`  (lines 24–28)

```
fn new(state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Creates a connector that reads its allow-or-block decision from shared proxy state. Use this when the connector should follow the proxy's current configuration rather than a hard-coded setting.

**Data flow**: It receives shared `NetworkProxyState`, which is the proxy's stored runtime configuration. It wraps that state inside a `TargetPolicy::State` and returns a new `TargetCheckedTcpConnector` that will consult it later before making direct TCP connections.

**Call relations**: This is the usual constructor used by SOCKS and tunnel setup paths, and by tests that want realistic proxy-state behavior. Later, when `TargetCheckedTcpConnector::serve` is asked to open a connection, the policy created here is passed down to the stream connector so the actual dial can be allowed or rejected.

*Call graph*: called by 10 (direct_connector_allows_non_public_target_when_local_binding_enabled, direct_connector_rejects_non_public_target_when_local_binding_disabled, forward_connect_tunnel, run_socks5_with_listener, handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode, handle_socks5_tcp_blocks_limited_mode_without_mitm_state, handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode, handle_socks5_tcp_uses_mitm_in_limited_mode, direct, from_env_proxy); 1 external calls (State).


##### `TargetCheckedTcpConnector::from_allow_local_binding`  (lines 30–36)

```
fn from_allow_local_binding(allow_local_binding: bool) -> Self
```

**Purpose**: Creates a connector with a fixed setting for whether local or private network targets are allowed. This is useful when the caller already has a plain yes/no policy and does not need to read shared proxy state.

**Data flow**: It receives a boolean value, `allow_local_binding`. It stores that value inside `TargetPolicy::Config` and returns a `TargetCheckedTcpConnector` that will use this fixed answer for every checked connection.

**Call relations**: This constructor is used by flows that build connectors directly from configuration, such as direct or environment-proxy setup paths. The connector it creates later feeds the fixed policy into `TargetCheckedStreamConnector::connect` through `TargetCheckedTcpConnector::serve`.

*Call graph*: called by 2 (direct_with_allow_local_binding, from_env_proxy_with_allow_local_binding).


##### `TargetCheckedTcpConnector::serve`  (lines 47–58)

```
async fn serve(&self, input: Input) -> Result<Self::Output, Self::Error>
```

**Purpose**: Starts a TCP connection request, choosing whether to use the ordinary connector or the policy-checking connector. It is the entry point for callers that treat this connector as a service.

**Data flow**: It receives an input request that contains connection details and extension data. If the request already has a `ProxyAddress` extension, it sends the request to the normal TCP connector unchanged. Otherwise, it builds a guarded stream connector using this object's policy, then asks the TCP connector to use that guard while opening the connection. The result is either an established TCP connection or an error.

**Call relations**: This function is called during SOCKS TCP handling. It hands ordinary proxy-address requests to Rama's standard `TcpConnector`, but for direct destination requests it hands off to `TargetCheckedStreamConnector::connect`, where the destination address is inspected before the socket is opened.

*Call graph*: called by 1 (handle_socks5_tcp); 3 external calls (extensions, new, clone).


##### `TargetCheckedStreamConnector::connect`  (lines 69–82)

```
async fn connect(&self, addr: SocketAddr) -> Result<TcpStream, Self::Error>
```

**Purpose**: Checks one concrete socket address against the proxy's target policy before opening a TCP socket to it. This is the final safety check before the program actually dials the network.

**Data flow**: It receives a `SocketAddr`, which is an IP address plus port. It asks `TargetPolicy::allow_local_binding` whether private/local targets are permitted. If they are not permitted and the IP address is non-public, it returns a permission-denied error instead of connecting. Otherwise, it opens a Tokio TCP stream to that address, wraps it in the project's `TcpStream` type, and returns it.

**Call relations**: This function is used by the guarded connector path built in `TargetCheckedTcpConnector::serve`. It relies on `TargetPolicy::allow_local_binding` for the rule and `is_non_public_ip` for deciding whether the target is local/private. Only after both checks pass does it hand off to Tokio's network connection function.

*Call graph*: calls 2 internal fn (allow_local_binding, is_non_public_ip); 3 external calls (ip, new, connect).


##### `TargetPolicy::allow_local_binding`  (lines 92–104)

```
async fn allow_local_binding(&self) -> Result<bool, BoxError>
```

**Purpose**: Answers the policy question: are local or private network destinations allowed right now? It hides whether that answer comes from a fixed setting or from live proxy state.

**Data flow**: It reads the policy variant stored in `TargetPolicy`. If the policy is `Config`, it returns the stored boolean directly. If the policy is `State`, it asks `NetworkProxyState` for the current setting. If reading that state fails, it wraps the error with extra context saying the proxy config could not be read.

**Call relations**: This function is called by `TargetCheckedStreamConnector::connect` every time a concrete destination is about to be dialed. It supplies the yes/no decision that determines whether `connect` may proceed to the real network call or must reject a non-public target.

*Call graph*: called by 1 (connect).


##### `tests::direct_connector_rejects_non_public_target_when_local_binding_disabled`  (lines 117–136)

```
async fn direct_connector_rejects_non_public_target_when_local_binding_disabled()
```

**Purpose**: Checks that the guarded connector blocks a localhost target when local binding is disabled. This protects the main security rule from being accidentally broken.

**Data flow**: The test starts a local TCP listener on localhost, builds default proxy settings where local binding is not allowed, and creates a target-checked connector from that state. It then asks the connector to connect to the local listener. The expected result is an error, and the test confirms the error says the network target was rejected by policy.

**Call relations**: This test exercises `TargetCheckedTcpConnector::new`, then drives the connector through the normal service path. That path reaches the same policy check used in real connection handling, proving that the default configuration refuses non-public direct targets.

*Call graph*: calls 3 internal fn (new, default, new); 6 external calls (new, from, serve, bind, assert!, network_proxy_state_for_policy).


##### `tests::direct_connector_allows_non_public_target_when_local_binding_enabled`  (lines 139–156)

```
async fn direct_connector_allows_non_public_target_when_local_binding_enabled()
```

**Purpose**: Checks that the guarded connector can connect to localhost when configuration explicitly allows it. This proves the safety rule is configurable rather than an unconditional block.

**Data flow**: The test starts a local TCP listener, builds proxy settings with `allow_local_binding` set to true, and creates a target-checked connector from that state. It asks the connector to connect to the local listener. The expected result is success, showing that the policy setting is respected.

**Call relations**: This test also goes through `TargetCheckedTcpConnector::new` and the normal service flow. It complements the rejection test by showing that `TargetPolicy::allow_local_binding` can return true and let `TargetCheckedStreamConnector::connect` continue to the real TCP connection.

*Call graph*: calls 3 internal fn (new, default, new); 6 external calls (new, from, serve, bind, assert!, network_proxy_state_for_policy).


### `network-proxy/src/upstream.rs`

`io_transport` · `request handling`

When this proxy receives an HTTP request, it still has to make a new outgoing connection to the destination server. This file is the outgoing “delivery driver.” It chooses the route, opens the connection safely, sends the request, and returns the response.

The small `ProxyConfig` type reads standard environment variables like `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`. It only accepts HTTP-style proxies, because this connector layer is built for HTTP proxying. For a secure request, it prefers `HTTPS_PROXY`, then `HTTP_PROXY`, then `ALL_PROXY`. For a plain request, it prefers `HTTP_PROXY`, then `ALL_PROXY`.

`UpstreamClient` is the main piece. It is a service: given an HTTP request, it produces an HTTP response. Before sending, it works out the target host, logs whether it will go direct or via a proxy, and if needed attaches the chosen proxy address to the request so the lower connector layer can use it. Then it opens the network connection, copies connection details back onto the request, sends the request over that connection, and logs either success or failure.

The connector stack is assembled in `build_http_connector`. It layers together target checking, optional HTTP proxy support, TLS encryption support, and HTTP protocol handling. In everyday terms, it builds the road, the toll booth option, the secure tunnel, and the vehicle that carries the request.

#### Function details

##### `ProxyConfig::from_env`  (lines 40–45)

```
fn from_env() -> Self
```

**Purpose**: Reads the process environment and builds a proxy configuration from common proxy variables. This lets the proxy respect settings that users or deployment systems already use for outbound traffic.

**Data flow**: It starts with the names of the HTTP, HTTPS, and catch-all proxy environment variables. For each group, it asks `read_proxy_env` to find the first usable value. It returns a `ProxyConfig` containing zero, one, or several proxy addresses.

**Call relations**: Construction paths such as `UpstreamClient::from_env_proxy`, `UpstreamClient::from_env_proxy_with_allow_local_binding`, and `proxy_for_connect` call this when they need proxy settings from the environment. It delegates the careful parsing and validation of each environment variable to `read_proxy_env`.

*Call graph*: calls 1 internal fn (read_proxy_env); called by 3 (from_env_proxy, from_env_proxy_with_allow_local_binding, proxy_for_connect).


##### `ProxyConfig::proxy_for_protocol`  (lines 47–56)

```
fn proxy_for_protocol(&self, is_secure: bool) -> Option<ProxyAddress>
```

**Purpose**: Chooses the best proxy address for one outgoing request, based on whether the request is secure or plain HTTP. This keeps the proxy selection rules in one place.

**Data flow**: It receives a true-or-false value saying whether the target protocol is secure. For secure targets, it tries the HTTPS proxy first, then the HTTP proxy, then the catch-all proxy. For non-secure targets, it tries the HTTP proxy, then the catch-all proxy. It returns either the chosen proxy address or nothing.

**Call relations**: `UpstreamClient::serve` calls this for each request after it has inspected the request target. The returned value decides whether the request is sent directly or marked to go through an upstream HTTP proxy.

*Call graph*: called by 1 (serve).


##### `read_proxy_env`  (lines 59–86)

```
fn read_proxy_env(keys: &[&str]) -> Option<ProxyAddress>
```

**Purpose**: Looks through a list of environment variable names and returns the first valid HTTP proxy address it finds. It also protects the rest of the system from bad or unsupported proxy settings.

**Data flow**: It receives possible environment variable names, such as uppercase and lowercase versions. For each one, it reads the variable, ignores missing or empty values, tries to parse the value as a proxy address, and checks that the proxy protocol is HTTP-compatible. It returns the first acceptable proxy address, or nothing if none work; invalid values are logged as warnings.

**Call relations**: `ProxyConfig::from_env` calls this once for each proxy category. This function is the filter at the edge of the system: it turns messy environment text into a clean proxy address that later request-routing code can trust.

*Call graph*: called by 1 (from_env); 3 external calls (try_from, var, warn!).


##### `proxy_for_connect`  (lines 88–90)

```
fn proxy_for_connect() -> Option<ProxyAddress>
```

**Purpose**: Finds the proxy that should be used for HTTP CONNECT-style tunneling. CONNECT is the HTTP method commonly used to create a tunnel for secure traffic.

**Data flow**: It reads proxy settings from the environment by building a `ProxyConfig`, then asks for the proxy appropriate for a secure protocol. It returns a proxy address if one is configured and valid.

**Call relations**: `http_connect_proxy` calls this when it needs to know whether CONNECT traffic should be sent through another proxy. It reuses `ProxyConfig::from_env` so CONNECT and normal upstream routing follow the same environment rules.

*Call graph*: calls 1 internal fn (from_env); called by 1 (http_connect_proxy).


##### `UpstreamClient::direct`  (lines 103–108)

```
fn direct(state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Creates an upstream client that always connects directly, without using environment proxy settings. It still uses the shared network-proxy state to check whether the target is allowed.

**Data flow**: It receives shared proxy state, creates an empty proxy configuration, creates a target-checking TCP connector from that state, and passes both into `UpstreamClient::new`. The result is an `UpstreamClient` ready to send requests directly.

**Call relations**: `http_plain_proxy` calls this when plain HTTP proxying should avoid upstream environment proxies. It hands construction off to `UpstreamClient::new`, which builds the actual connector stack.

*Call graph*: calls 1 internal fn (new); called by 1 (http_plain_proxy); 2 external calls (new, default).


##### `UpstreamClient::from_env_proxy`  (lines 110–115)

```
fn from_env_proxy(state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Creates an upstream client that may use proxy settings from the environment. This is useful when outbound traffic from this proxy should obey standard `HTTP_PROXY` or similar variables.

**Data flow**: It receives shared proxy state, reads proxy configuration from the environment, creates a target-checking TCP connector from the state, and combines them through `UpstreamClient::new`. The result is an `UpstreamClient` that decides per request whether to go direct or via an upstream proxy.

**Call relations**: `http_plain_proxy` calls this when it wants outgoing plain HTTP requests to honor environment proxy variables. It relies on `ProxyConfig::from_env` for configuration and `UpstreamClient::new` for the connector machinery.

*Call graph*: calls 2 internal fn (new, from_env); called by 1 (http_plain_proxy); 1 external calls (new).


##### `UpstreamClient::direct_with_allow_local_binding`  (lines 117–122)

```
fn direct_with_allow_local_binding(allow_local_binding: bool) -> Self
```

**Purpose**: Creates a direct upstream client while explicitly choosing whether local binding is allowed. Local binding means allowing connections to local or loopback-style addresses, which can be sensitive in a proxy.

**Data flow**: It receives a boolean setting for local binding, creates an empty proxy configuration, builds a target-checking connector using that setting, and returns an `UpstreamClient` built from those pieces.

**Call relations**: The wider construction flow calls this when it needs a direct client but does not have, or does not want to use, the full shared state object. It uses the same internal `UpstreamClient::new` path as the other TCP-based constructors.

*Call graph*: calls 1 internal fn (from_allow_local_binding); called by 1 (new); 2 external calls (new, default).


##### `UpstreamClient::from_env_proxy_with_allow_local_binding`  (lines 124–129)

```
fn from_env_proxy_with_allow_local_binding(allow_local_binding: bool) -> Self
```

**Purpose**: Creates an upstream client that reads proxy settings from the environment and also explicitly controls whether local binding is allowed. It combines environment-based routing with a safety choice about local targets.

**Data flow**: It receives a boolean local-binding setting, reads proxy variables into a `ProxyConfig`, builds a target-checking connector from the local-binding choice, and returns a configured `UpstreamClient`.

**Call relations**: The broader setup path calls this when it needs both environment proxy support and an explicit local-binding policy. It uses `ProxyConfig::from_env` for proxy discovery and the same `UpstreamClient::new` constructor used by the other TCP client builders.

*Call graph*: calls 2 internal fn (from_allow_local_binding, from_env); called by 1 (new); 1 external calls (new).


##### `UpstreamClient::unix_socket`  (lines 132–138)

```
fn unix_socket(path: &str) -> Self
```

**Purpose**: On macOS, creates an upstream client that connects through a fixed Unix socket path instead of a normal TCP network address. A Unix socket is a local file-like communication endpoint used between processes on the same machine.

**Data flow**: It receives a socket path string, builds a Unix-socket-based HTTP connector for that path, and returns an `UpstreamClient` with no proxy configuration. Requests sent through this client go to that local socket route.

**Call relations**: `proxy_via_unix_socket` calls this for the special macOS path where traffic should be forwarded through a local socket. It hands the low-level connector creation to `build_unix_connector`.

*Call graph*: calls 1 internal fn (build_unix_connector); called by 1 (proxy_via_unix_socket); 1 external calls (default).


##### `UpstreamClient::new`  (lines 140–146)

```
fn new(proxy_config: ProxyConfig, transport: TargetCheckedTcpConnector) -> Self
```

**Purpose**: Builds the common TCP-based `UpstreamClient` from two ingredients: proxy rules and a checked transport connector. It centralizes the setup so all TCP constructors get the same HTTP, proxy, and TLS behavior.

**Data flow**: It receives a `ProxyConfig` and a `TargetCheckedTcpConnector`. It turns the transport connector into a full HTTP connector stack with `build_http_connector`, then stores that connector alongside the proxy configuration in a new `UpstreamClient`.

**Call relations**: All normal TCP construction paths feed into this function after deciding their proxy settings and target-checking policy. It then delegates the layered network setup to `build_http_connector`.

*Call graph*: calls 1 internal fn (build_http_connector).


##### `UpstreamClient::serve`  (lines 153–219)

```
async fn serve(&self, mut req: Request<Body>) -> Result<Self::Output, Self::Error>
```

**Purpose**: Sends one HTTP request to its upstream destination and returns the upstream response. This is the heart of the file: it turns an incoming proxy request into an outgoing client request.

**Data flow**: It receives an HTTP request. It reads the target information from the request, chooses a proxy if the configuration says one applies, and stores that proxy choice in the request’s extensions so lower layers can see it. It then asks the connector to establish a client connection. If connection setup fails, it returns an error. If it succeeds, it copies connection metadata into the request, sends the request over the established HTTP connection, and returns the response or an error with added context.

**Call relations**: The proxy’s request-handling path calls this whenever it needs to forward an HTTP request upstream. Inside, it uses `ProxyConfig::proxy_for_protocol` for route choice, then calls the connector service to open the connection, and finally calls the HTTP connection service to send the request and receive response headers.

*Call graph*: calls 1 internal fn (proxy_for_protocol); 9 external calls (serve, now, from_boxed, try_from, extensions_mut, uri, format!, info!, warn!).


##### `build_http_connector`  (lines 222–240)

```
fn build_http_connector(
    transport: TargetCheckedTcpConnector,
) -> BoxService<
    Request<Body>,
    EstablishedClientConnection<HttpClientService<Body>, Request<Body>>,
    BoxError,
>
```

**Purpose**: Assembles the layered connector used for normal outgoing HTTP and HTTPS traffic. It is like building a pipeline where each layer adds one ability: target checking, optional proxying, TLS security, and HTTP client behavior.

**Data flow**: It receives a checked TCP transport connector. It first ensures the Rustls crypto provider is installed, then wraps the transport with optional HTTP proxy support. Next it creates TLS settings with automatic HTTP protocol negotiation, adds a TLS connector layer, adapts request versions, and finally creates and boxes an HTTP connector service. The output is a reusable connector object that can establish upstream HTTP client connections.

**Call relations**: `UpstreamClient::new` calls this during client construction. The connector it returns is later used by `UpstreamClient::serve` each time a request needs an outgoing connection.

*Call graph*: called by 1 (new); 6 external calls (new, optional, new, new, auto, ensure_rustls_crypto_provider).


##### `build_unix_connector`  (lines 243–253)

```
fn build_unix_connector(
    path: &str,
) -> BoxService<
    Request<Body>,
    EstablishedClientConnection<HttpClientService<Body>, Request<Body>>,
    BoxError,
>
```

**Purpose**: On macOS, builds an HTTP connector that talks through a fixed Unix socket path. This supports local process-to-process forwarding without opening a TCP connection.

**Data flow**: It receives a filesystem path to a Unix socket, creates a fixed Unix connector for that path, wraps it in an HTTP connector, and returns the boxed connector service. The result can carry HTTP requests over that local socket.

**Call relations**: `UpstreamClient::unix_socket` calls this when constructing the macOS Unix-socket variant. The returned connector is stored in `UpstreamClient` and later used by its normal `serve` flow.

*Call graph*: called by 1 (unix_socket); 2 external calls (new, fixed).


### `network-proxy/src/mitm.rs`

`io_transport` · `request handling`

HTTPS normally hides request details from a proxy. This file provides the controlled “man in the middle” path: the proxy presents a locally generated certificate for the target host, accepts the client’s encrypted connection, reads the HTTP request inside it, checks policy, then sends the request onward to the real server. Think of it like a security checkpoint that is allowed to open a sealed envelope, inspect the address and contents according to local rules, then reseal and forward it.

The main state is `MitmState`. It owns the local certificate authority used to create per-host certificates, plus an upstream HTTP client used to send approved requests onward. When a tunnel is taken over, `mitm_stream` pulls the target host, proxy state, and mode from the stream’s attached context, builds a TLS server for that host, and runs an HTTP service over it.

Each inner HTTPS request goes through `evaluate_mitm_policy`. That blocks nested CONNECT requests, host mismatches, unsafe local/private rebinding, hook denials, and methods not allowed in limited network mode. If allowed, `forward_request` rewrites the request so it targets the real HTTPS destination, applies any hook-request header edits, forwards it upstream, and returns the response. Optional body inspection is present but disabled by default; when enabled, it only logs body sizes as the data streams through.

#### Function details

##### `MitmState::fmt`  (lines 92–98)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats `MitmState` for debug logs without exposing sensitive internals like certificate authority material or connection objects. It only shows safe summary fields.

**Data flow**: A formatter asks for a printable version of the state → the function writes a small debug structure containing the body-inspection settings → the log output avoids private certificate and connector details.

**Call relations**: This is used implicitly when Rust debug formatting is requested for `MitmState`. It does not drive proxy behavior; it protects logs from leaking sensitive state.

*Call graph*: 1 external calls (debug_struct).


##### `MitmState::new`  (lines 102–123)

```
fn new(config: MitmUpstreamConfig) -> Result<Self>
```

**Purpose**: Creates the shared state needed for HTTPS inspection. It prepares TLS cryptography, loads or creates the local certificate authority, and chooses how outgoing requests will be sent.

**Data flow**: It receives a small upstream configuration saying whether environment proxy settings and local binding are allowed → it ensures the TLS provider is ready, loads or creates the MITM certificate authority, and builds either a direct upstream client or one that may use an upstream proxy → it returns a ready `MitmState` or an error.

**Call relations**: This is called during configuration/state building by `build_config_state`. Later request-handling code depends on the state it creates to generate host certificates and forward approved HTTPS requests.

*Call graph*: calls 3 internal fn (load_or_create, direct_with_allow_local_binding, from_env_proxy_with_allow_local_binding); called by 1 (build_config_state); 1 external calls (ensure_rustls_crypto_provider).


##### `MitmState::tls_acceptor_data_for_host`  (lines 125–127)

```
fn tls_acceptor_data_for_host(&self, host: &str) -> Result<TlsAcceptorData>
```

**Purpose**: Builds the TLS server data needed to impersonate a specific target host using the local managed certificate authority. This is what lets the proxy terminate the client’s HTTPS connection for that host.

**Data flow**: It receives a host name → asks the managed certificate authority for TLS acceptor data for that host → returns that data or an error if certificate creation/loading fails.

**Call relations**: During `mitm_stream`, this function provides the certificate material used by the TLS acceptor before the inner HTTP service starts.

*Call graph*: calls 1 internal fn (tls_acceptor_data_for_host).


##### `MitmState::inspect_enabled`  (lines 129–131)

```
fn inspect_enabled(&self) -> bool
```

**Purpose**: Reports whether request and response body inspection is turned on. In this file’s current constants, it is disabled by default.

**Data flow**: It reads the `inspect` flag from `MitmState` → returns that boolean value unchanged.

**Call relations**: `forward_request` checks this before wrapping request bodies for inspection, and response handling uses the same setting before wrapping response bodies.


##### `MitmState::max_body_bytes`  (lines 133–135)

```
fn max_body_bytes(&self) -> usize
```

**Purpose**: Reports the configured body-size threshold used when body inspection logging is enabled. The threshold is used to mark logged bodies as larger than the intended inspection limit.

**Data flow**: It reads the `max_body_bytes` value from `MitmState` → returns that number unchanged.

**Call relations**: `forward_request` and `respond_with_inspection` pass this value into the body-inspection wrapper when inspection is enabled.


##### `mitm_tunnel`  (lines 139–141)

```
async fn mitm_tunnel(upgraded: Upgraded) -> Result<()>
```

**Purpose**: Starts HTTPS inspection for an already-upgraded CONNECT tunnel. It is a small adapter for the CONNECT path.

**Data flow**: It receives the upgraded tunnel stream from the HTTP CONNECT handler → passes that stream to `mitm_stream` → returns success or the error produced while serving the tunnel.

**Call relations**: `http_connect_proxy` calls this after a CONNECT request has been accepted and upgraded. The real setup and serving work is then handed to `mitm_stream`.

*Call graph*: calls 1 internal fn (mitm_stream); called by 1 (http_connect_proxy).


##### `mitm_stream`  (lines 144–211)

```
async fn mitm_stream(stream: S) -> Result<()>
```

**Purpose**: Turns a raw client stream into a TLS-terminated HTTP service that can inspect and forward the HTTPS requests inside it. This is the main setup point for MITM traffic.

**Data flow**: It receives a stream with attached context such as MITM state, app state, target host and port, network mode, and optional executor → it normalizes the host, creates certificate data for that host, builds a request context, installs header-cleanup layers, wraps the service in TLS, and serves requests from the stream → it returns when serving ends or fails.

**Call relations**: It is reached from `mitm_tunnel` for HTTP CONNECT traffic and from `proxy_socks5_tcp` for SOCKS5 TCP traffic. For every inner request accepted by the TLS HTTP service, it calls into `handle_mitm_request`.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (mitm_tunnel, proxy_socks5_tcp); 7 external calls (new, auto, hop_by_hop, hop_by_hop, extensions, new, service_fn).


##### `handle_mitm_request`  (lines 213–225)

```
async fn handle_mitm_request(
    req: Request,
    request_ctx: Arc<MitmRequestContext>,
) -> Result<Response, std::convert::Infallible>
```

**Purpose**: Handles one decrypted HTTPS request and converts internal failures into a safe HTTP response for the client. It prevents proxy errors from escaping as unstructured service failures.

**Data flow**: It receives an HTTP request and the shared MITM request context → asks `forward_request` to check and forward the request → returns that response, or a 502 Bad Gateway text response if forwarding failed.

**Call relations**: The service built in `mitm_stream` calls this for each inner HTTPS request. It delegates normal work to `forward_request` and logs failures before returning a simple error response.

*Call graph*: calls 2 internal fn (forward_request, text_response); 1 external calls (warn!).


##### `forward_request`  (lines 227–275)

```
async fn forward_request(req: Request, request_ctx: &MitmRequestContext) -> Result<Response>
```

**Purpose**: Checks an inner HTTPS request against policy, rewrites it for the real upstream server, forwards it, and prepares the response for the client. This is the central per-request path.

**Data flow**: It receives the decrypted client request and MITM context → evaluates policy, stops early with a block response if needed, records method and path for logging, applies hook-request header edits, rebuilds the URI and Host header for the target server, optionally wraps the request body for inspection, sends it through the upstream client, optionally wraps the response body for inspection → returns the upstream or block response.

**Call relations**: `handle_mitm_request` calls this for each request. It relies on `evaluate_mitm_policy` for allow/block decisions, `apply_mitm_hook_actions` for header changes, URI helper functions for correct upstream targeting, and `respond_with_inspection` for optional response-body logging.

*Call graph*: calls 8 internal fn (apply_mitm_hook_actions, authority_header_value, build_https_uri, evaluate_mitm_policy, inspect_body, path_and_query, path_for_log, respond_with_inspection); called by 1 (handle_mitm_request); 5 external calls (from_str, from_parts, into_parts, method, uri).


##### `mitm_blocking_response`  (lines 278–286)

```
async fn mitm_blocking_response(
    req: &Request,
    policy: &MitmPolicyContext,
) -> Result<Option<Response>>
```

**Purpose**: Runs the MITM policy check and returns only the blocking response, if the request would be blocked. It is mainly useful for code paths or tests that need the decision without forwarding.

**Data flow**: It receives a request and policy context → calls `evaluate_mitm_policy` → returns `None` if allowed, or `Some(response)` if policy produced a block response.

**Call relations**: It is a thin wrapper around `evaluate_mitm_policy`. The main forwarding path uses `evaluate_mitm_policy` directly through `forward_request`.

*Call graph*: calls 1 internal fn (evaluate_mitm_policy).


##### `evaluate_mitm_policy`  (lines 288–408)

```
async fn evaluate_mitm_policy(
    req: &Request,
    policy: &MitmPolicyContext,
) -> Result<MitmPolicyDecision>
```

**Purpose**: Decides whether a decrypted HTTPS request is allowed to continue. It enforces the safety and policy rules that require seeing inside the HTTPS request.

**Data flow**: It receives a request and policy context → rejects nested CONNECT requests, extracts method/path/client details, checks that the request host still matches the original tunnel target, re-checks local/private target blocking to defend against DNS rebinding, evaluates host-specific MITM hooks, and checks whether the network mode permits the HTTP method → returns either an allow decision with optional hook actions or a block response.

**Call relations**: `forward_request` calls this before forwarding anything, and `mitm_blocking_response` uses it for decision-only checks. It talks to the shared application state to check host blocking, record blocked requests, and evaluate MITM hook rules.

*Call graph*: calls 6 internal fn (extract_request_host, path_for_log, normalize_host, blocked_text_response, text_response, new); called by 2 (forward_request, mitm_blocking_response); 6 external calls (extensions, method, uri, matches!, Block, warn!).


##### `apply_mitm_hook_actions`  (lines 410–421)

```
fn apply_mitm_hook_actions(headers: &mut HeaderMap, actions: Option<&MitmHookActions>)
```

**Purpose**: Applies header changes requested by a matching MITM hook. Hooks can remove selected request headers and inject replacement or additional headers before the request goes upstream.

**Data flow**: It receives mutable request headers and optional hook actions → if there are actions, it removes each listed header and inserts each configured injected header → the same header map is changed in place and nothing is returned.

**Call relations**: `forward_request` calls this after policy allows the request and before sending it upstream. The actions come from `evaluate_mitm_policy` when a host hook matches.

*Call graph*: called by 1 (forward_request); 2 external calls (insert, remove).


##### `respond_with_inspection`  (lines 423–447)

```
fn respond_with_inspection(
    resp: Response,
    inspect: bool,
    max_body_bytes: usize,
    method: &str,
    log_path: &str,
    authority: &str,
) -> Result<Response>
```

**Purpose**: Optionally wraps an upstream response body so its streamed size can be logged. If inspection is disabled, it leaves the response untouched.

**Data flow**: It receives an upstream response plus inspection settings and log labels → if inspection is off, it returns the original response; if on, it splits the response into metadata and body, wraps the body with `inspect_body`, then rebuilds and returns the response.

**Call relations**: `forward_request` calls this after receiving the upstream response. It hands body-stream wrapping to `inspect_body` using a `ResponseLogContext`.

*Call graph*: calls 1 internal fn (inspect_body); called by 1 (forward_request); 2 external calls (from_parts, into_parts).


##### `inspect_body`  (lines 449–460)

```
fn inspect_body(
    body: Body,
    max_body_bytes: usize,
    ctx: T,
) -> Body
```

**Purpose**: Wraps a request or response body in a stream that counts bytes while the data passes through. It does not buffer the whole body; it observes the stream as it is read.

**Data flow**: It receives a body, a maximum byte threshold, and a logging context → converts the body into a data stream and places it inside `InspectStream` with a byte counter → returns a new body that yields the same bytes while logging at the end.

**Call relations**: `forward_request` uses this for request bodies when inspection is enabled, and `respond_with_inspection` uses it for response bodies. The actual counting happens later in `InspectStream::poll_next` as the body is consumed.

*Call graph*: called by 2 (forward_request, respond_with_inspection); 4 external calls (new, pin, from_stream, into_data_stream).


##### `InspectStream::poll_next`  (lines 472–488)

```
fn poll_next(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Feeds the next chunk of body data to the caller while counting how many bytes have passed. When the stream ends, it logs the final body size once.

**Data flow**: A consumer asks for the next body chunk → the function polls the inner body stream; successful chunks are counted and passed through, errors are passed through, pending reads remain pending, and end-of-stream triggers one log call with the total length and whether it exceeded the threshold → the caller receives the next stream state.

**Call relations**: Bodies returned by `inspect_body` use this method whenever the HTTP stack reads them. At the end, it calls the `log` method from either `RequestLogContext` or `ResponseLogContext`.

*Call graph*: 1 external calls (Ready).


##### `RequestLogContext::log`  (lines 509–516)

```
fn log(self, len: usize, truncated: bool)
```

**Purpose**: Writes a log entry summarizing an inspected request body. It records where the request was going and how large the body was.

**Data flow**: It receives the completed byte count and a flag saying whether the count exceeded the configured threshold → combines those with the stored host, method, and path → emits an informational log message.

**Call relations**: `InspectStream::poll_next` calls this when an inspected request body finishes streaming. The context is created in `forward_request` before the request is sent upstream.

*Call graph*: 1 external calls (info!).


##### `ResponseLogContext::log`  (lines 520–528)

```
fn log(self, len: usize, truncated: bool)
```

**Purpose**: Writes a log entry summarizing an inspected response body. It includes the response status along with the request labels and body size.

**Data flow**: It receives the completed byte count and threshold flag → combines them with stored host, method, path, and status code → emits an informational log message.

**Call relations**: `InspectStream::poll_next` calls this when an inspected response body finishes streaming. The context is created in `respond_with_inspection` after the upstream response arrives.

*Call graph*: 1 external calls (info!).


##### `extract_request_host`  (lines 531–537)

```
fn extract_request_host(req: &Request) -> Option<String>
```

**Purpose**: Finds the host claimed by an inner HTTPS request. This is used to make sure the request is still for the same host as the original tunnel.

**Data flow**: It receives a request → first tries to read the Host header as text; if that is missing, it looks at the URI authority part → returns the host string if one is found.

**Call relations**: `evaluate_mitm_policy` calls this during host-mismatch checks. If the extracted host does not match the tunnel target after normalization, the request is blocked.

*Call graph*: called by 1 (evaluate_mitm_policy); 1 external calls (headers).


##### `authority_header_value`  (lines 539–552)

```
fn authority_header_value(host: &str, port: u16) -> String
```

**Purpose**: Formats the host and port in the way HTTP expects for a Host header or URI authority. It also handles IPv6 addresses, which need square brackets in this position.

**Data flow**: It receives a host and port → omits the port when it is the normal HTTPS port 443, includes it otherwise, and brackets IPv6-style hosts → returns the formatted authority string.

**Call relations**: `forward_request` calls this before rebuilding the upstream URI and Host header. The returned value is then used by `build_https_uri` and inserted into the request headers.

*Call graph*: called by 1 (forward_request); 1 external calls (format!).


##### `build_https_uri`  (lines 554–557)

```
fn build_https_uri(authority: &str, path: &str) -> Result<Uri>
```

**Purpose**: Builds a full HTTPS URI for the upstream request. The inner request may have arrived with only a path, but the upstream client needs a complete destination.

**Data flow**: It receives a formatted authority and path → combines them into a string like `https://host/path` → parses that string into a URI and returns it or an error.

**Call relations**: `forward_request` calls this while rewriting the client request for the real server. If URI parsing fails, forwarding fails and the caller returns an upstream error response.

*Call graph*: called by 1 (forward_request); 1 external calls (format!).


##### `path_and_query`  (lines 559–564)

```
fn path_and_query(uri: &Uri) -> String
```

**Purpose**: Extracts the path plus query string from a URI, using `/` when the URI has none. This preserves details such as `?page=2` when forwarding.

**Data flow**: It receives a URI → reads its path-and-query portion if present, otherwise uses `/` → returns that as a string.

**Call relations**: `forward_request` uses this value to build the upstream HTTPS URI, so the real server receives the same path and query the client requested.

*Call graph*: called by 1 (forward_request); 1 external calls (path_and_query).


##### `path_for_log`  (lines 566–568)

```
fn path_for_log(uri: &Uri) -> String
```

**Purpose**: Extracts just the path part of a URI for log messages. It intentionally leaves out the query string.

**Data flow**: It receives a URI → reads only its path component → returns that path as a string.

**Call relations**: `evaluate_mitm_policy` uses this in warning logs for blocked requests, and `forward_request` uses it as a label for optional body-inspection logs.

*Call graph*: called by 2 (evaluate_mitm_policy, forward_request); 1 external calls (path).


### Local socket substrates
These files supply the reusable local IPC transports used by sandbox bridges, shell escalation, and higher-level local communication channels.

### `uds/src/lib.rs`

`io_transport` · `cross-cutting local socket setup and request handling`

A Unix domain socket is a local communication channel addressed by a path on disk, rather than by an internet address. This file is the project’s small adapter layer for that kind of local connection. Without it, every caller would need separate Unix and Windows code, and Windows would be especially awkward because Unix domain socket support there comes through a compatibility crate.

The public surface is intentionally small. First, it can prepare a private directory for socket files, so other users on the machine cannot easily interfere with the control socket. It can also check whether an old socket path is still sitting around and may need cleanup. Then it offers two main types: `UnixListener`, which waits for incoming local connections, and `UnixStream`, which is the connected two-way pipe.

Internally, the file is like a travel plug adapter. Callers use the same plug shape everywhere, while the `platform` module converts it to the right wall socket for the current operating system. On Unix, it mostly forwards to Tokio’s built-in async Unix socket types. On Windows, it wraps `uds_windows` sockets in async-friendly layers, and moves blocking connect/bind work onto a background thread so the async runtime is not stalled.

#### Function details

##### `prepare_private_socket_directory`  (lines 15–17)

```
async fn prepare_private_socket_directory(socket_dir: impl AsRef<Path>) -> IoResult<()>
```

**Purpose**: Creates the directory that will hold socket paths and, where the operating system supports it, makes it private to the current user. This is used before opening a control socket so other users cannot casually reach or tamper with it.

**Data flow**: It receives a directory path from the caller, turns it into a standard path reference, and passes it to the platform-specific implementation. The result is either success, meaning the directory exists with suitable access rules, or an input/output error explaining why that could not be done.

**Call relations**: This is the public doorway. It immediately hands the real work to `platform::prepare_private_socket_directory`, because the rules for directory privacy differ between Unix and Windows.

*Call graph*: 2 external calls (as_ref, prepare_private_socket_directory).


##### `is_stale_socket_path`  (lines 24–26)

```
async fn is_stale_socket_path(socket_path: impl AsRef<Path>) -> IoResult<bool>
```

**Purpose**: Checks whether a socket rendezvous path looks like leftover socket state from an earlier run. This helps the program decide whether it may need to remove an old path before creating a new socket.

**Data flow**: It receives a path, converts it to a path reference, and asks the platform layer how to interpret that path. It returns `true` when the path is considered stale socket state, `false` when it is not, or an error if the path could not be inspected.

**Call relations**: This public helper delegates to `platform::is_stale_socket_path`. On Unix the platform code can inspect the file type; on Windows it has less information and mainly checks whether the path exists.

*Call graph*: 2 external calls (as_ref, is_stale_socket_path).


##### `UnixListener::bind`  (lines 35–39)

```
async fn bind(socket_path: impl AsRef<Path>) -> IoResult<Self>
```

**Purpose**: Starts listening for local socket connections at a given path. Callers use this when they want to create a local service endpoint, such as a control socket.

**Data flow**: It takes a socket path, sends it to the platform-specific bind function, and wraps the returned low-level listener in the project’s `UnixListener` type. On success the caller gets a listener; on failure they get an input/output error such as an unusable path or permission problem.

**Call relations**: This is called by higher-level features that start or test local control sockets, remote-control scenarios, host bridges, and similar flows. It relies on `platform::bind_listener` so those callers do not need separate Unix and Windows code.

*Call graph*: called by 12 (remote_unix_socket_typed_request_roundtrip_works, disable_remote_control_retries_without_params_for_older_servers, run_enable_remote_control_scenario, start_control_socket_acceptor, run_host_bridge, pipes_stdin_and_stdout_through_socket, fetch_ide_context_uses_unregistered_request_route, validate_unix_socket_path_rejects_unsafe_parent_directory, default_daemon_auto_connect_probes_socket_only, bound_listener_path_is_stale_socket_path (+2 more)); 2 external calls (as_ref, bind_listener).


##### `UnixListener::accept`  (lines 42–44)

```
async fn accept(&mut self) -> IoResult<UnixStream>
```

**Purpose**: Waits for the next client to connect to an existing listener. It turns an incoming local connection into a `UnixStream`, which can then be read from and written to.

**Data flow**: It uses the listener stored inside `UnixListener`, waits asynchronously for an incoming connection, and wraps the platform stream in the public `UnixStream` type. The listener remains available for later accepts, while the new stream is returned to the caller.

**Call relations**: This is used when server-side code, such as an initialized client accept flow, is ready to receive a connection. It passes the wait down to the platform listener’s `accept` method and then hands the resulting stream back to the application layer.

*Call graph*: called by 1 (accept_initialized_client); 1 external calls (accept).


##### `UnixStream::connect`  (lines 54–58)

```
async fn connect(socket_path: impl AsRef<Path>) -> IoResult<Self>
```

**Purpose**: Opens a client connection to a local socket path. Callers use it when they want to talk to a local service that is already listening.

**Data flow**: It takes the desired socket path, gives it to the platform connection function, and wraps the resulting low-level stream as a `UnixStream`. The output is a connected two-way pipe or an input/output error if no connection could be made.

**Call relations**: This is called by many higher-level connection paths, including endpoint connection, daemon probing, socket preparation, and tests that check round trips. It delegates to `platform::connect_stream` so connection behavior stays portable.

*Call graph*: called by 8 (connect_unix_socket_endpoint, connect, prepare_control_socket_path, connect_to_socket, run, maybe_probe_default_daemon_socket, stream_round_trips_data_between_listener_and_client, connect_stream); 2 external calls (as_ref, connect_stream).


##### `UnixStream::poll_read`  (lines 62–68)

```
fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<IoResult<()>>
```

**Purpose**: Lets Tokio, the async runtime, read bytes from a `UnixStream` without blocking the whole program. Most callers do not call this directly; it is what makes `UnixStream` usable wherever an async reader is expected.

**Data flow**: Tokio provides a pinned stream, a wake-up context, and a buffer to fill. The function forwards the read request to the inner platform stream, which either adds bytes to the buffer, reports that it is not ready yet, or returns an error.

**Call relations**: This function is part of the `AsyncRead` implementation for `UnixStream`. It is invoked by async reading utilities and simply passes the work through to the wrapped platform stream.

*Call graph*: 1 external calls (new).


##### `UnixStream::poll_write`  (lines 72–74)

```
fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<IoResult<usize>>
```

**Purpose**: Lets Tokio write bytes to a `UnixStream` without blocking the async runtime. This is what allows the stream to be used as an async writer.

**Data flow**: It receives a byte slice to send and forwards that slice to the inner platform stream. The result tells Tokio how many bytes were accepted, whether it should try again later, or whether an error occurred.

**Call relations**: This is part of the `AsyncWrite` implementation for `UnixStream`. Higher-level code writes normally through Tokio traits, and this method forwards the write to the operating-system-specific stream.

*Call graph*: 1 external calls (new).


##### `UnixStream::poll_flush`  (lines 76–78)

```
fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Pushes out any buffered outgoing data on a `UnixStream`. This matters when code wants to make sure data has actually been handed off before continuing.

**Data flow**: Tokio supplies the stream and wake-up context. The function forwards the flush request to the inner platform stream and returns whether flushing is complete, still pending, or failed.

**Call relations**: This is another part of `UnixStream`’s async writing behavior. It is called by Tokio write helpers and delegates directly to the platform stream.

*Call graph*: 1 external calls (new).


##### `UnixStream::poll_shutdown`  (lines 80–82)

```
fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Closes the writing side of a `UnixStream` in async code. This tells the other side that no more bytes will be sent.

**Data flow**: It receives the stream and async context, then asks the inner platform stream to shut down its outgoing side. The result is a completed shutdown, a pending state, or an error.

**Call relations**: Tokio calls this through the `AsyncWrite` trait when higher-level code closes or finishes a stream. The public stream does not implement shutdown itself; it forwards to the platform stream, whose Windows version has special shutdown behavior.

*Call graph*: 1 external calls (new).


##### `platform::prepare_private_socket_directory`  (lines 187–189)

```
async fn prepare_private_socket_directory(socket_dir: &Path) -> IoResult<()>
```

**Purpose**: Performs the operating-system-specific work needed to make the socket directory exist. On Unix it also enforces owner-only permissions; on Windows it creates the directory tree because Unix-style permission bits are not available in the same way.

**Data flow**: It receives a concrete path. On Unix, it tries to create the directory with mode `0700`, checks that an existing path is really a directory, and fixes permissions if needed. On Windows, it creates all missing parent directories. It returns success or an input/output error.

**Call relations**: The public `prepare_private_socket_directory` function calls this helper. It is kept inside the platform module so the rest of the crate can ask for a private socket directory without knowing how each operating system represents privacy.

*Call graph*: 7 external calls (new, from_mode, format!, new, set_permissions, symlink_metadata, create_dir_all).


##### `platform::bind_listener`  (lines 193–198)

```
async fn bind_listener(socket_path: &Path) -> IoResult<Listener>
```

**Purpose**: Creates the actual low-level listener for the current operating system. It is the platform-specific half of `UnixListener::bind`.

**Data flow**: It receives a socket path. On Unix it binds Tokio’s Unix listener directly. On Windows it copies the path, performs the `uds_windows` bind operation on a blocking worker thread, wraps the result for async use, and returns a platform listener.

**Call relations**: `UnixListener::bind` calls this whenever the application starts listening on a local socket. It may use `platform::spawn_blocking_io` on Windows so a slow or blocking socket operation does not freeze the async runtime.

*Call graph*: calls 1 internal fn (bind); 4 external calls (new, to_path_buf, from, spawn_blocking_io).


##### `platform::Listener::accept`  (lines 201–206)

```
async fn accept(&mut self) -> IoResult<Stream>
```

**Purpose**: Waits for one incoming connection on the platform listener and returns the connected platform stream. It hides small differences in how each operating system reports accepted connections.

**Data flow**: It uses the stored listener, waits for a client, discards the peer address information that this crate does not need, and returns only the stream. On Windows it also wraps the accepted socket in async compatibility layers.

**Call relations**: The public `UnixListener::accept` method calls this. It is the point where a listening socket turns into a stream that higher-level protocol code can read from and write to.

*Call graph*: 2 external calls (new, from).


##### `platform::connect_stream`  (lines 209–216)

```
async fn connect_stream(socket_path: &Path) -> IoResult<Stream>
```

**Purpose**: Creates the actual outgoing local socket connection for the current operating system. It is the platform-specific half of `UnixStream::connect`.

**Data flow**: It receives a socket path. On Unix it connects using Tokio’s Unix stream support. On Windows it copies the path, connects through `uds_windows` on a blocking worker thread, wraps the socket for async reading and writing, and returns the platform stream.

**Call relations**: `UnixStream::connect` calls this whenever client-side code wants to reach a local socket. On Windows it relies on `platform::spawn_blocking_io` to keep blocking connection work away from the async runtime.

*Call graph*: calls 1 internal fn (connect); 4 external calls (new, to_path_buf, from, spawn_blocking_io).


##### `platform::is_stale_socket_path`  (lines 218–220)

```
async fn is_stale_socket_path(socket_path: &Path) -> IoResult<bool>
```

**Purpose**: Interprets a path as possible leftover socket state using the rules available on the current operating system. This supports safe cleanup decisions before binding a new listener.

**Data flow**: It receives a path. On Unix it reads file metadata and checks whether the path is a socket. On Windows it checks whether the path exists, because the Windows compatibility layer represents the rendezvous path differently. It returns a boolean or an inspection error.

**Call relations**: The public `is_stale_socket_path` helper calls this. Keeping this logic here prevents callers from making Unix-only assumptions about what a socket path looks like.

*Call graph*: 2 external calls (symlink_metadata, try_exists).


##### `platform::spawn_blocking_io`  (lines 222–231)

```
async fn spawn_blocking_io(
        operation: impl FnOnce() -> IoResult<T> + Send + 'static,
    ) -> IoResult<T>
```

**Purpose**: Runs a blocking input/output operation on a background worker thread and turns its result back into a normal input/output result. This protects the async runtime from being stalled by Windows socket operations that are not naturally async.

**Data flow**: It receives a one-time operation that returns an input/output result. It sends that operation to Tokio’s blocking thread pool, waits for it to finish, converts any task failure into an input/output error, and returns the operation’s original success value or error.

**Call relations**: Windows binding and connecting call this helper before wrapping sockets for async use. It is a small bridge between blocking library calls and the rest of this file’s async interface.

*Call graph*: 1 external calls (spawn_blocking).


##### `platform::WindowsUnixListener::from`  (lines 236–238)

```
fn from(listener: uds_windows::UnixListener) -> Self
```

**Purpose**: Wraps a `uds_windows` listener in this crate’s local wrapper type. The wrapper exists so the listener can be made compatible with async helper traits used later.

**Data flow**: It receives a raw `uds_windows::UnixListener` value and stores it inside `WindowsUnixListener`. The output is the same listener, but in a wrapper type this module controls.

**Call relations**: Windows listener binding uses this after creating a `uds_windows` listener. The wrapped listener is then passed into async compatibility code.


##### `platform::WindowsUnixListener::deref`  (lines 244–246)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Allows code to treat the wrapper like the underlying `uds_windows` listener when it only needs a shared reference. This keeps wrapper code lightweight instead of re-exposing every listener method manually.

**Data flow**: It receives a reference to the wrapper and returns a reference to the listener stored inside it. Nothing is copied or changed.

**Call relations**: Async wrapper code and socket access helpers rely on this kind of forwarding. It supports the Windows-only path used by `platform::bind_listener` and `platform::Listener::accept`.


##### `platform::WindowsUnixListener::as_socket`  (lines 250–252)

```
fn as_socket(&self) -> BorrowedSocket<'_>
```

**Purpose**: Exposes the Windows listener as a borrowed Windows socket handle. Async libraries need this handle so they can wait for readiness on the socket.

**Data flow**: It reads the raw socket handle from the wrapped listener and turns it into a borrowed socket object. The listener still owns the real socket; the returned value is only a temporary view of it.

**Call relations**: This is part of making `WindowsUnixListener` acceptable to `async_io::Async`. It is used indirectly when Windows binding wraps the listener for async accept operations.

*Call graph*: 1 external calls (borrow_raw).


##### `platform::WindowsUnixStream::from`  (lines 258–260)

```
fn from(stream: uds_windows::UnixStream) -> Self
```

**Purpose**: Wraps a `uds_windows` stream in this crate’s local wrapper type. The wrapper lets this file provide the traits needed for async reading, writing, and socket readiness.

**Data flow**: It receives a raw `uds_windows::UnixStream` and stores it inside `WindowsUnixStream`. The output is a controlled wrapper around the same connection.

**Call relations**: Windows accept and connect paths use this before adapting a stream into the async type returned by the platform layer.


##### `platform::WindowsUnixStream::deref`  (lines 266–268)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Allows the stream wrapper to be viewed as the underlying `uds_windows` stream. This avoids needless forwarding methods for read-only access.

**Data flow**: It receives a reference to `WindowsUnixStream` and returns a reference to the stream inside. It does not move, copy, or change the connection.

**Call relations**: This supports the Windows async wrapping code, including access to low-level socket operations needed during shutdown.


##### `platform::WindowsUnixStream::as_socket`  (lines 272–274)

```
fn as_socket(&self) -> BorrowedSocket<'_>
```

**Purpose**: Exposes the Windows stream as a borrowed Windows socket handle. This lets async infrastructure watch the socket for readability and writability.

**Data flow**: It gets the raw socket handle from the wrapped stream and creates a temporary borrowed socket reference. Ownership stays with the wrapped stream.

**Call relations**: This is used indirectly by `async_io::Async` when Windows streams are converted into async-compatible streams in accept and connect flows.

*Call graph*: 1 external calls (borrow_raw).


##### `platform::WindowsUnixStream::read`  (lines 278–280)

```
fn read(&mut self, buf: &mut [u8]) -> IoResult<usize>
```

**Purpose**: Provides standard blocking-style reading for the wrapped Windows Unix stream. This is needed because the async adapter builds on ordinary read behavior.

**Data flow**: It receives a mutable byte buffer, passes that buffer to the underlying `uds_windows` stream, and returns how many bytes were read or what error occurred.

**Call relations**: The Windows async compatibility layer calls this through standard read traits. It is one of the pieces that lets `platform::Stream::poll_read` eventually behave like Tokio async reading.

*Call graph*: 1 external calls (read).


##### `platform::WindowsUnixStream::write`  (lines 284–286)

```
fn write(&mut self, buf: &[u8]) -> IoResult<usize>
```

**Purpose**: Provides standard blocking-style writing for the wrapped Windows Unix stream. The async adapter uses this as the basic way to send bytes.

**Data flow**: It receives bytes from the caller, forwards them to the underlying `uds_windows` stream, and returns the number of bytes written or an error.

**Call relations**: The Windows async compatibility layer calls this through standard write traits. It supports the async write path exposed as `UnixStream::poll_write`.

*Call graph*: 1 external calls (write).


##### `platform::WindowsUnixStream::flush`  (lines 288–290)

```
fn flush(&mut self) -> IoResult<()>
```

**Purpose**: Flushes any buffered writes on the wrapped Windows Unix stream. This supports the usual writer promise that data can be pushed out before shutdown or before waiting for a response.

**Data flow**: It asks the underlying `uds_windows` stream to flush its outgoing data. It returns success if flushing completed, or an input/output error if it failed.

**Call relations**: The async write adapter uses this when higher-level code flushes a stream. It also matters before the Windows-specific shutdown path closes the write side.

*Call graph*: 1 external calls (flush).


##### `platform::Stream::poll_read`  (lines 294–300)

```
fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<IoResult<()>>
```

**Purpose**: Implements async reading for the Windows platform stream. It lets the public `UnixStream` read from Windows-compatible Unix sockets in the same way it reads on Unix.

**Data flow**: Tokio supplies a pinned platform stream, a wake-up context, and a read buffer. The function forwards the request to the compatibility wrapper, which fills the buffer when data is ready or reports that the task should be woken later.

**Call relations**: The public `UnixStream::poll_read` forwards to this on Windows. It is the final adapter between Tokio’s async read interface and the Windows socket wrapper.

*Call graph*: 1 external calls (new).


##### `platform::Stream::poll_write`  (lines 304–310)

```
fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<IoResult<usize>>
```

**Purpose**: Implements async writing for the Windows platform stream. It lets callers send bytes through the same public `UnixStream` API on Windows as on Unix.

**Data flow**: It receives bytes to send and forwards them into the compatibility-wrapped Windows stream. The result tells Tokio how much was written, whether the socket is not ready yet, or whether an error occurred.

**Call relations**: The public `UnixStream::poll_write` reaches this method on Windows. It depends on the wrapped `WindowsUnixStream` write behavior underneath.

*Call graph*: 1 external calls (new).


##### `platform::Stream::poll_flush`  (lines 312–314)

```
fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Implements async flushing for the Windows platform stream. It makes sure buffered outgoing data is pushed through the compatibility wrapper.

**Data flow**: It receives the stream and async context, forwards the flush request to the wrapped stream, and returns ready, pending, or error status to Tokio.

**Call relations**: The public `UnixStream::poll_flush` reaches this on Windows. It is also part of the preparation done before shutting down the write side.

*Call graph*: 1 external calls (new).


##### `platform::Stream::poll_shutdown`  (lines 316–323)

```
fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<IoResult<()>>
```

**Purpose**: Shuts down the writing side of a Windows platform stream correctly. This is special because the generic compatibility wrapper would only flush, not actually signal end-of-writing to the socket peer.

**Data flow**: It first waits until any pending outgoing data is flushed. Then it reaches through the wrappers to the underlying socket and directly shuts down the write side. It returns success once that signal has been sent, or an error if flushing or shutdown fails.

**Call relations**: The public `UnixStream::poll_shutdown` forwards here on Windows. This function deliberately goes beyond the default compatibility behavior so the other side of the connection can reliably observe that writing has ended.

*Call graph*: 2 external calls (Ready, ready!).


### `shell-escalation/src/unix/socket.rs`

`io_transport` · `cross-cutting IPC during session setup and request handling`

Unix sockets are like private pipes between processes on the same machine. This file builds a safer, easier layer on top of them. Its main job is to send two kinds of things: ordinary message bytes, and file descriptors, which are operating-system handles for open files, sockets, or other resources. Passing a file descriptor is like handing someone an already-open door instead of telling them where the door is.

For stream sockets, where bytes arrive as one continuous flow, the file creates its own message format: a small length number first, then the JSON message body. This prevents the receiver from guessing where one message ends and the next begins. Any file descriptors are attached to the first part of the message using Unix control messages, specifically `SCM_RIGHTS`, the standard way to transfer file descriptors between local processes.

For datagram sockets, where each send is already one packet-like message, the file sends the bytes directly and optionally attaches file descriptors.

The two public wrappers, `AsyncSocket` and `AsyncDatagramSocket`, make the sockets non-blocking and plug them into Tokio, the async runtime. Without this file, higher-level shell escalation code would need to repeat fragile, unsafe, platform-specific socket work, and mistakes could lose messages, block the runtime, or leak file descriptors.

#### Function details

##### `assume_init`  (lines 26–28)

```
fn assume_init(buf: &[MaybeUninit<T>]) -> &[T]
```

**Purpose**: Treats a buffer of possibly-uninitialized values as a normal initialized slice. It exists so the socket-reading code can safely convert only the bytes it knows the operating system has filled in.

**Data flow**: It receives a slice whose elements are marked as maybe not yet initialized. The caller promises every element in that slice is actually filled. It returns a normal slice over the same memory, without copying anything.

**Call relations**: The receive paths call this after the operating system has written bytes into a buffer. `read_frame_header` uses it for the stream header and control data, and `receive_datagram_bytes` uses it for datagram payloads and attached control data.

*Call graph*: called by 2 (read_frame_header, receive_datagram_bytes); 3 external calls (as_ptr, len, from_raw_parts).


##### `assume_init_slice`  (lines 30–32)

```
fn assume_init_slice(buf: &[MaybeUninit<T>; N]) -> &[T; N]
```

**Purpose**: Converts a fixed-size array of possibly-uninitialized values into a fixed-size initialized array reference. Here it is used for the four-byte stream message length header after all four bytes have arrived.

**Data flow**: It takes a fixed array that the caller says is fully filled. It returns a fixed array view of the same bytes, ready to be interpreted as real data.

**Call relations**: `read_frame_header` calls this once the length prefix has been completely read, so it can turn those bytes into the payload size.

*Call graph*: called by 1 (read_frame_header).


##### `assume_init_vec`  (lines 34–42)

```
fn assume_init_vec(mut buf: Vec<MaybeUninit<T>>) -> Vec<T>
```

**Purpose**: Turns a vector of maybe-uninitialized values into a normal vector after the caller has filled every slot. This avoids extra copying when reading a message payload of known size.

**Data flow**: It receives a vector reserved for incoming data. After the caller has filled all positions, this function re-labels the same allocation as a normal vector and returns it.

**Call relations**: `read_frame_payload` calls this at the end of a successful read, handing the completed message body to the higher-level frame reader.

*Call graph*: called by 1 (read_frame_payload); 2 external calls (from_raw_parts, forget).


##### `control_space_for_fds`  (lines 44–46)

```
fn control_space_for_fds(count: usize) -> usize
```

**Purpose**: Calculates how much extra socket control-message space is needed to carry a given number of file descriptors. This matters because file descriptors travel beside the data, not inside the ordinary byte payload.

**Data flow**: It takes a count of file descriptors. It asks the C socket macros how many bytes are needed for the control message and returns that size.

**Call relations**: The send and receive helpers use this sizing logic when preparing buffers for `SCM_RIGHTS` file-descriptor passing.

*Call graph*: 1 external calls (CMSG_SPACE).


##### `extract_fds`  (lines 49–79)

```
fn extract_fds(control: &[u8]) -> Vec<OwnedFd>
```

**Purpose**: Pulls received file descriptors out of a Unix socket control message. It turns raw operating-system descriptor numbers into owned Rust objects so they will be closed automatically when no longer needed.

**Data flow**: It receives the raw control-message bytes attached to a socket receive. It walks through each control message, looks for `SCM_RIGHTS`, reads each descriptor number, wraps each one as an `OwnedFd`, and returns the list.

**Call relations**: `read_frame_header` uses this for stream sockets, where file descriptors are attached to the frame header. `receive_datagram_bytes` uses it for datagram sockets, where descriptors arrive with the datagram.

*Call graph*: called by 2 (read_frame_header, receive_datagram_bytes); 8 external calls (from_raw_fd, new, CMSG_DATA, CMSG_FIRSTHDR, CMSG_LEN, CMSG_NXTHDR, zeroed, try_from).


##### `read_frame`  (lines 85–89)

```
async fn read_frame(async_socket: &AsyncFd<Socket>) -> std::io::Result<(Vec<u8>, Vec<OwnedFd>)>
```

**Purpose**: Reads one complete framed message from a stream socket. A frame means a length prefix, then exactly that many payload bytes, plus any attached file descriptors.

**Data flow**: It receives an async stream socket. First it reads the header to learn the payload size and collect file descriptors, then it reads the payload bytes, and finally returns both together.

**Call relations**: `AsyncSocket::receive_with_fds` calls this whenever higher-level code wants the next structured message from a stream socket.

*Call graph*: calls 2 internal fn (read_frame_header, read_frame_payload); called by 1 (receive_with_fds).


##### `read_frame_header`  (lines 92–145)

```
async fn read_frame_header(
    async_socket: &AsyncFd<Socket>,
) -> std::io::Result<(usize, Vec<OwnedFd>)>
```

**Purpose**: Reads the first four bytes of a stream frame, which say how large the message body is, and captures any file descriptors attached to that first receive. It protects the stream protocol from losing the special side-channel data.

**Data flow**: It waits until the socket is readable, fills a four-byte header buffer, and on the first read also collects socket control data. Once all header bytes are present, it converts them from little-endian bytes into a payload length and extracts any file descriptors.

**Call relations**: `read_frame` calls this before reading the body. It hands `read_frame` the exact body length and any descriptors that were sent with the message.

*Call graph*: calls 3 internal fn (assume_init, assume_init_slice, extract_fds); called by 1 (read_frame); 7 external calls (readable, uninit, assert!, new, from_le_bytes, unreachable!, vec!).


##### `read_frame_payload`  (lines 148–177)

```
async fn read_frame_payload(
    async_socket: &AsyncFd<Socket>,
    message_len: usize,
) -> std::io::Result<Vec<u8>>
```

**Purpose**: Reads the body of a stream message after the header has said how long it should be. It keeps reading until the full body has arrived or reports an error if the peer closes early.

**Data flow**: It receives the async socket and the expected byte count. It allocates a buffer of that size, repeatedly fills it as the socket becomes readable, and returns the completed byte vector.

**Call relations**: `read_frame` calls this after `read_frame_header`. Together they turn the continuous byte stream back into one complete message.

*Call graph*: calls 1 internal fn (assume_init_vec); called by 1 (read_frame); 6 external calls (readable, new, assert!, new, unreachable!, vec!).


##### `send_datagram_bytes`  (lines 179–198)

```
fn send_datagram_bytes(socket: &Socket, data: &[u8], fds: &[OwnedFd]) -> std::io::Result<()>
```

**Purpose**: Sends one datagram message, optionally with file descriptors attached. It checks that the entire datagram payload was written, because partial datagram sends would mean the message was not delivered as intended.

**Data flow**: It receives a raw socket, a byte slice, and a list of file descriptors. It builds any needed control message, sends the bytes with that control data, and returns success only if all payload bytes were sent.

**Call relations**: The datagram send path uses this low-level helper to do the actual Unix `sendmsg` call. The tests call it directly to confirm it rejects too many file descriptors.

*Call graph*: calls 1 internal fn (make_control_message); called by 1 (send_datagram_bytes_rejects_excessive_fd_counts); 5 external calls (new, new, sendmsg, new, format!).


##### `encode_length`  (lines 200–208)

```
fn encode_length(len: usize) -> std::io::Result<[u8; LENGTH_PREFIX_SIZE]>
```

**Purpose**: Turns a message size into the four-byte length prefix used by stream messages. It rejects messages too large to fit in that prefix.

**Data flow**: It receives a byte length as a machine-sized number. If it fits in a 32-bit unsigned integer, it returns the little-endian four-byte encoding; otherwise it returns an invalid-input error.

**Call relations**: `AsyncSocket::send_with_fds` calls this before sending a stream message. A test calls it with an oversized value to verify the error path.

*Call graph*: called by 2 (send_with_fds, encode_length_errors_for_oversized_messages); 1 external calls (try_from).


##### `make_control_message`  (lines 210–233)

```
fn make_control_message(fds: &[OwnedFd]) -> std::io::Result<Vec<u8>>
```

**Purpose**: Builds the special Unix socket control message used to pass file descriptors. It also enforces the file’s limit of 16 descriptors per message.

**Data flow**: It receives a list of owned file descriptors. If the list is empty, it returns no control data. If there are too many, it returns an error. Otherwise it creates a correctly shaped `SCM_RIGHTS` control buffer containing the raw descriptor numbers.

**Call relations**: `send_datagram_bytes` and `send_stream_chunk` call this right before sending data, so ordinary message bytes and transferred descriptors leave together.

*Call graph*: called by 2 (send_datagram_bytes, send_stream_chunk); 9 external calls (is_empty, iter, len, new, new, format!, CMSG_DATA, CMSG_LEN, vec!).


##### `receive_datagram_bytes`  (lines 235–249)

```
fn receive_datagram_bytes(socket: &Socket) -> std::io::Result<(Vec<u8>, Vec<OwnedFd>)>
```

**Purpose**: Receives one datagram message and any file descriptors that came with it. Datagram messages are already message-sized, so no length prefix is needed.

**Data flow**: It prepares a payload buffer and a control-data buffer, receives one datagram into them, trims both to the actual received sizes, extracts file descriptors, and returns the bytes plus descriptors.

**Call relations**: `AsyncDatagramSocket::receive_with_fds` uses this as the actual readable-socket operation when waiting for a datagram.

*Call graph*: calls 2 internal fn (assume_init, extract_fds); 4 external calls (new, new, recvmsg, vec!).


##### `AsyncSocket::new`  (lines 256–262)

```
fn new(socket: Socket) -> std::io::Result<AsyncSocket>
```

**Purpose**: Wraps a Unix stream socket so it can be used with Tokio async code. It also switches the socket to non-blocking mode, which is required for async waiting.

**Data flow**: It receives a socket, marks it non-blocking, wraps it in Tokio’s `AsyncFd`, and returns an `AsyncSocket` containing that wrapper.

**Call relations**: `AsyncSocket::from_fd` and `AsyncSocket::pair` both call this after obtaining a socket endpoint, making all stream sockets in this wrapper behave consistently.

*Call graph*: called by 2 (from_fd, pair); 2 external calls (new, set_nonblocking).


##### `AsyncSocket::from_fd`  (lines 264–266)

```
fn from_fd(fd: OwnedFd) -> std::io::Result<AsyncSocket>
```

**Purpose**: Creates an async stream socket wrapper from an already-open file descriptor. This is useful when another part of the program or another process has handed over a socket endpoint.

**Data flow**: It receives an owned file descriptor, converts it into a socket object, passes it through `AsyncSocket::new`, and returns the async wrapper.

**Call relations**: `escalate_task` calls this when it needs to communicate through a socket supplied from outside this file.

*Call graph*: calls 1 internal fn (new); called by 1 (escalate_task); 1 external calls (from).


##### `AsyncSocket::pair`  (lines 268–277)

```
fn pair() -> std::io::Result<(AsyncSocket, AsyncSocket)>
```

**Purpose**: Creates two connected async Unix stream sockets. This is a convenient way for two tasks or processes to talk to each other privately.

**Data flow**: It asks the operating system for a connected stream socket pair, marks both descriptors close-on-exec so they do not accidentally leak into new programs, wraps both in `AsyncSocket`, and returns the pair.

**Call relations**: Higher-level shell-escalation setup and many tests call this when they need a fresh connected channel. It feeds both endpoints into the stream-message send and receive methods.

*Call graph*: calls 1 internal fn (new); called by 10 (run_shell_escalation_execve_wrapper, dropping_session_aborts_intercept_workers_and_kills_spawned_child, handle_escalate_session_accepts_received_fds_that_overlap_destinations, handle_escalate_session_executes_escalated_command, handle_escalate_session_passes_permissions_to_executor, handle_escalate_session_resolves_relative_file_against_request_workdir, handle_escalate_session_respects_run_in_sandbox_decision, async_socket_handles_large_payload, async_socket_round_trips_payload_and_fds, receive_fails_when_peer_closes_before_header); 1 external calls (pair_raw).


##### `AsyncSocket::send_with_fds`  (lines 279–289)

```
async fn send_with_fds(
        &self,
        msg: T,
        fds: &[OwnedFd],
    ) -> std::io::Result<()>
```

**Purpose**: Sends a structured JSON message over a stream socket, optionally carrying file descriptors beside it. This is the main stream-socket send method when descriptor passing is needed.

**Data flow**: It receives any serializable message and a list of file descriptors. It converts the message to JSON bytes, prefixes those bytes with their length, and asks `send_stream_frame` to write the complete frame with the descriptors attached to the first send.

**Call relations**: `AsyncSocket::send` calls this for ordinary messages with no file descriptors. Higher-level code can call it directly when it must transfer open resources.

*Call graph*: calls 2 internal fn (encode_length, send_stream_frame); called by 1 (send); 2 external calls (with_capacity, to_vec).


##### `AsyncSocket::receive_with_fds`  (lines 291–297)

```
async fn receive_with_fds(
        &self,
    ) -> std::io::Result<(T, Vec<OwnedFd>)>
```

**Purpose**: Receives one structured JSON message from a stream socket and returns any file descriptors sent with it. This is the matching receive method for `send_with_fds`.

**Data flow**: It waits for `read_frame` to return raw payload bytes and descriptors. It then deserializes the JSON payload into the requested Rust type and returns that value together with the descriptors.

**Call relations**: `AsyncSocket::receive` calls this and discards the descriptor list after warning if any arrived unexpectedly. Descriptor-aware callers use it directly.

*Call graph*: calls 1 internal fn (read_frame); called by 1 (receive); 1 external calls (from_slice).


##### `AsyncSocket::send`  (lines 299–304)

```
async fn send(&self, msg: T) -> std::io::Result<()>
```

**Purpose**: Sends a structured JSON message over a stream socket without file descriptors. It is the simpler send method for ordinary control messages.

**Data flow**: It receives a serializable message, borrows it, supplies an empty descriptor list, and delegates to `send_with_fds`.

**Call relations**: Higher-level policy/session code calls this when it only needs to send data. It reuses the same framing and JSON machinery as descriptor-carrying sends.

*Call graph*: calls 1 internal fn (send_with_fds); called by 1 (handle_escalate_session_with_policy).


##### `AsyncSocket::receive`  (lines 306–312)

```
async fn receive(&self) -> std::io::Result<T>
```

**Purpose**: Receives a structured JSON message over a stream socket when no file descriptors are expected. If descriptors do arrive, it logs a warning rather than silently pretending that was normal.

**Data flow**: It calls `receive_with_fds`, checks the returned descriptor list, warns if the list is not empty, and returns just the decoded message.

**Call relations**: Callers use this simpler method for normal messages. Internally it still goes through the descriptor-aware receive path so the framing stays shared.

*Call graph*: calls 1 internal fn (receive_with_fds); 1 external calls (warn!).


##### `AsyncSocket::into_inner`  (lines 314–316)

```
fn into_inner(self) -> Socket
```

**Purpose**: Gives back the underlying socket object from an `AsyncSocket`. This is useful when code needs to leave the async wrapper and work with the raw socket layer.

**Data flow**: It consumes the wrapper and returns the contained socket, transferring ownership to the caller.

**Call relations**: This is an escape hatch from the wrapper. It does not take part in normal send or receive flow, but allows integration with code that needs the original socket.

*Call graph*: 1 external calls (into_inner).


##### `send_stream_frame`  (lines 319–344)

```
async fn send_stream_frame(
    socket: &AsyncFd<Socket>,
    frame: &[u8],
    fds: &[OwnedFd],
) -> std::io::Result<()>
```

**Purpose**: Writes an entire framed stream message without blocking the async runtime. It also makes sure file descriptors are attached only once, on the first write attempt that actually sends data.

**Data flow**: It receives an async socket, the already-built frame bytes, and file descriptors. It waits for writability, sends chunks until the whole frame is written, and returns an error if the socket closes or cannot make progress.

**Call relations**: `AsyncSocket::send_with_fds` calls this after JSON encoding and length-prefix construction. It delegates each actual write attempt to `send_stream_chunk`.

*Call graph*: called by 1 (send_with_fds); 3 external calls (writable, is_empty, new).


##### `send_stream_chunk`  (lines 346–364)

```
fn send_stream_chunk(
    socket: &Socket,
    frame: &[u8],
    fds: &[OwnedFd],
    include_fds: bool,
) -> std::io::Result<usize>
```

**Purpose**: Performs one low-level send operation for a stream frame, optionally including file descriptors. It is separated out so the async loop can retry cleanly when the socket would block.

**Data flow**: It receives a socket, the remaining frame bytes, the descriptor list, and a flag saying whether descriptors should be included. It builds control data only when requested, sends the bytes with `sendmsg`, and returns how many payload bytes were written.

**Call relations**: `send_stream_frame` uses this inside its writable loop. A test also calls it directly to confirm excessive descriptor counts are rejected.

*Call graph*: calls 1 internal fn (make_control_message); called by 1 (send_stream_chunk_rejects_excessive_fd_counts); 4 external calls (new, new, sendmsg, new).


##### `AsyncDatagramSocket::new`  (lines 371–376)

```
fn new(socket: Socket) -> std::io::Result<Self>
```

**Purpose**: Wraps a Unix datagram socket for Tokio async use. Like the stream wrapper, it switches the socket to non-blocking mode first.

**Data flow**: It receives a socket, marks it non-blocking, wraps it in `AsyncFd`, and returns an `AsyncDatagramSocket`.

**Call relations**: `AsyncDatagramSocket::from_raw_fd` and `AsyncDatagramSocket::pair` use this to create datagram wrappers from externally supplied or newly created sockets.

*Call graph*: 2 external calls (new, set_nonblocking).


##### `AsyncDatagramSocket::from_raw_fd`  (lines 378–380)

```
fn from_raw_fd(fd: RawFd) -> std::io::Result<Self>
```

**Purpose**: Creates an async datagram socket wrapper from a raw file descriptor. Because raw descriptors can be misused, the function is marked unsafe: the caller must guarantee the descriptor is valid and uniquely owned.

**Data flow**: It receives a raw descriptor number, turns it into a socket object, makes that socket non-blocking through `new`, and returns the async wrapper.

**Call relations**: `get_escalate_client` and related session cleanup tests call this when a datagram socket endpoint comes from outside the wrapper.

*Call graph*: called by 2 (get_escalate_client, dropping_session_aborts_intercept_workers_and_kills_spawned_child); 2 external calls (new, from_raw_fd).


##### `AsyncDatagramSocket::pair`  (lines 382–391)

```
fn pair() -> std::io::Result<(Self, Self)>
```

**Purpose**: Creates two connected async Unix datagram sockets. Datagram sockets preserve message boundaries, so each send corresponds to one receive.

**Data flow**: It creates a connected datagram socket pair, marks both endpoints close-on-exec to prevent accidental inheritance by child programs, wraps both in `AsyncDatagramSocket`, and returns them.

**Call relations**: Session startup and datagram round-trip tests call this when they need a local packet-style communication channel.

*Call graph*: called by 2 (start_session, async_datagram_sockets_round_trip_messages); 2 external calls (new, pair_raw).


##### `AsyncDatagramSocket::send_with_fds`  (lines 393–399)

```
async fn send_with_fds(&self, data: &[u8], fds: &[OwnedFd]) -> std::io::Result<()>
```

**Purpose**: Sends one datagram payload, optionally with file descriptors, without blocking the async runtime.

**Data flow**: It receives byte data and file descriptors. It waits until the socket is writable through Tokio, then sends the datagram bytes and descriptor control data as one operation.

**Call relations**: Callers use this to send packet-like messages. It relies on the lower-level datagram send helper inside Tokio’s async I/O wrapper.

*Call graph*: 1 external calls (async_io).


##### `AsyncDatagramSocket::receive_with_fds`  (lines 401–405)

```
async fn receive_with_fds(&self) -> std::io::Result<(Vec<u8>, Vec<OwnedFd>)>
```

**Purpose**: Receives one datagram payload and any file descriptors attached to it, without blocking other async work.

**Data flow**: It waits until the socket is readable, receives one datagram, extracts file descriptors from the control data, and returns the payload bytes plus descriptors.

**Call relations**: Callers use this as the datagram counterpart to `send_with_fds`. Internally it runs `receive_datagram_bytes` when Tokio reports the socket is ready.

*Call graph*: 1 external calls (async_io).


##### `AsyncDatagramSocket::into_inner`  (lines 407–409)

```
fn into_inner(self) -> Socket
```

**Purpose**: Returns the underlying socket from an `AsyncDatagramSocket`. This lets code stop using the async wrapper and take direct ownership of the socket.

**Data flow**: It consumes the wrapper and returns its inner socket object.

**Call relations**: This is an escape hatch for integration or teardown code, separate from the normal datagram send and receive methods.

*Call graph*: 1 external calls (into_inner).


##### `tests::fd_list`  (lines 428–435)

```
fn fd_list(count: usize) -> std::io::Result<Vec<OwnedFd>>
```

**Purpose**: Creates a test list of duplicated file descriptors. Tests use it to check that descriptor passing really transfers valid open handles.

**Data flow**: It creates a temporary file, duplicates that file’s descriptor the requested number of times, stores the owned duplicates in a vector, and returns them.

**Call relations**: Several tests call this before sending messages with file descriptors, giving the socket code realistic descriptors to pass around.

*Call graph*: 2 external calls (new, new).


##### `tests::async_socket_round_trips_payload_and_fds`  (lines 438–460)

```
async fn async_socket_round_trips_payload_and_fds() -> std::io::Result<()>
```

**Purpose**: Checks that the stream socket wrapper can send both a JSON payload and a file descriptor, and receive both correctly on the other side.

**Data flow**: It creates a connected stream socket pair, builds a test payload and one file descriptor, receives on one task while sending from the other, then verifies the payload matches and the received descriptor is valid.

**Call relations**: This test exercises `AsyncSocket::pair`, `send_with_fds`, and `receive_with_fds` together as the real stream transport would use them.

*Call graph*: calls 1 internal fn (pair); 5 external calls (assert!, assert_eq!, fcntl, fd_list, spawn).


##### `tests::async_socket_handles_large_payload`  (lines 463–471)

```
async fn async_socket_handles_large_payload() -> std::io::Result<()>
```

**Purpose**: Checks that stream messages larger than a single small read or write still arrive intact. This protects the framing loop from only working for tiny messages.

**Data flow**: It creates a stream socket pair, sends a 10,000-byte vector, receives it on the other endpoint, and compares the full received data with the original.

**Call relations**: This test drives `AsyncSocket::pair`, `send`, and `receive`, which in turn exercise the frame-writing and frame-reading loops.

*Call graph*: calls 1 internal fn (pair); 3 external calls (assert_eq!, spawn, vec!).


##### `tests::async_datagram_sockets_round_trip_messages`  (lines 474–487)

```
async fn async_datagram_sockets_round_trip_messages() -> std::io::Result<()>
```

**Purpose**: Checks that datagram sockets can send one byte message plus a file descriptor and receive both correctly.

**Data flow**: It creates a datagram socket pair, prepares payload bytes and one duplicated file descriptor, sends them from one endpoint, receives from the other, and verifies both payload and descriptor count.

**Call relations**: This test exercises `AsyncDatagramSocket::pair`, `send_with_fds`, and `receive_with_fds` as a complete datagram transport path.

*Call graph*: calls 1 internal fn (pair); 3 external calls (assert_eq!, fd_list, spawn).


##### `tests::send_datagram_bytes_rejects_excessive_fd_counts`  (lines 490–496)

```
fn send_datagram_bytes_rejects_excessive_fd_counts() -> std::io::Result<()>
```

**Purpose**: Verifies that datagram sending refuses to attach more file descriptors than the file’s configured limit. This prevents oversized or malformed control messages.

**Data flow**: It creates a raw datagram socket pair, builds one more descriptor than allowed, tries to send them, and checks that the result is an invalid-input error.

**Call relations**: This test calls `send_datagram_bytes` directly so the limit check in `make_control_message` is tested without the async wrapper around it.

*Call graph*: calls 1 internal fn (send_datagram_bytes); 3 external calls (pair_raw, assert_eq!, fd_list).


##### `tests::send_stream_chunk_rejects_excessive_fd_counts`  (lines 499–505)

```
fn send_stream_chunk_rejects_excessive_fd_counts() -> std::io::Result<()>
```

**Purpose**: Verifies that stream sending also refuses too many file descriptors. The same safety limit should apply to both transport styles.

**Data flow**: It creates a raw stream socket pair, prepares too many descriptors, calls `send_stream_chunk` with descriptor inclusion enabled, and checks for an invalid-input error.

**Call relations**: This test calls the stream chunk sender directly, covering the descriptor control-message creation path used by `send_stream_frame`.

*Call graph*: calls 1 internal fn (send_stream_chunk); 3 external calls (pair_raw, assert_eq!, fd_list).


##### `tests::encode_length_errors_for_oversized_messages`  (lines 508–511)

```
fn encode_length_errors_for_oversized_messages()
```

**Purpose**: Checks that messages too large for the four-byte stream length prefix are rejected. Without this, a huge length could wrap or be misread by the receiver.

**Data flow**: It gives `encode_length` the largest possible `usize` value and checks that the function returns an invalid-input error.

**Call relations**: This test protects the stream send path because `AsyncSocket::send_with_fds` depends on `encode_length` before writing any framed message.

*Call graph*: calls 1 internal fn (encode_length); 1 external calls (assert_eq!).


##### `tests::receive_fails_when_peer_closes_before_header`  (lines 514–522)

```
async fn receive_fails_when_peer_closes_before_header()
```

**Purpose**: Checks that receiving from a stream socket reports a clear end-of-file error if the other side closes before even the message header arrives.

**Data flow**: It creates a stream socket pair, drops the client endpoint, tries to receive on the server endpoint, and verifies the error kind is `UnexpectedEof`.

**Call relations**: This test drives `AsyncSocket::receive`, which reaches the header-reading code and confirms early peer closure is treated as a failed receive.

*Call graph*: calls 1 internal fn (pair); 1 external calls (assert_eq!).


### Sandbox and IDE IPC channels
These files apply the local transport substrates to sandbox proxy routing and IDE-context request/response communication across platforms.

### `linux-sandbox/src/proxy_routing.rs`

`io_transport` · `startup and runtime bridge processes`

Proxy settings often say “use the proxy at 127.0.0.1:PORT.” Outside a sandbox, that means “connect to a proxy running on this same machine.” Inside a separate Linux network namespace, however, 127.0.0.1 means the sandbox itself, not the host. Without this file, tools running in the sandbox could lose access to a corporate or local proxy even though the proxy is correctly configured on the host.

The file solves that by building a two-part relay, like passing messages through two mail slots. On the host side, it reads known proxy environment variables, keeps only the ones that point to loopback addresses, creates private Unix domain socket files (local socket files used for communication on one machine), and starts “host bridge” child processes. Each host bridge listens on one socket file and forwards traffic to the original host proxy port.

Inside the sandbox network namespace, it starts “local bridge” child processes. Each local bridge listens on 127.0.0.1 with a fresh port, connects back through the Unix socket to the host bridge, and copies bytes both ways. The sandbox’s proxy environment variables are then rewritten to point at these new local ports. The file also creates and cleans temporary socket directories, checks process liveness, hardens child bridge processes, and brings up the loopback network interface if needed.

#### Function details

##### `prepare_host_proxy_route_spec`  (lines 73–122)

```
fn prepare_host_proxy_route_spec() -> io::Result<String>
```

**Purpose**: Prepares the host side of proxy routing before the sandboxed command runs. It finds usable proxy environment variables, creates socket files, starts host-side bridge processes, and returns a small JSON description that the sandbox side can use later.

**Data flow**: It reads the current process environment, turns proxy variables into a routing plan, creates a private temporary directory, assigns each unique proxy endpoint to a Unix socket path, and starts one host bridge per endpoint. It outputs a serialized proxy route specification containing only environment variable names and socket paths, not the original proxy URLs.

**Call relations**: run_main calls this when managed proxy routing is requested. It relies on planning, socket-directory setup, stale cleanup, host bridge spawning, and cleanup-worker spawning; the JSON it returns is later handed to activate_proxy_routes_in_netns on the sandbox side.

*Call graph*: calls 6 internal fn (cleanup_stale_proxy_socket_dirs_in, create_proxy_socket_dir, plan_proxy_routes, proxy_socket_parent_dir, spawn_host_bridge, spawn_proxy_socket_dir_cleanup_worker); called by 1 (run_main); 7 external calls (new, with_capacity, new, other, format!, to_string, vars).


##### `activate_proxy_routes_in_netns`  (lines 124–170)

```
fn activate_proxy_routes_in_netns(serialized_spec: &str) -> io::Result<()>
```

**Purpose**: Activates proxy routing inside the sandbox network namespace. It starts local loopback listeners and rewrites proxy environment variables so sandboxed programs connect to those listeners.

**Data flow**: It takes the JSON route specification from the host setup, parses it, starts one local bridge for each unique Unix socket path, then reads each original proxy environment variable and rewrites its host and port to 127.0.0.1 and the assigned local port. It changes the process environment before the user command is executed.

**Call relations**: run_main calls this after entering the network namespace. It uses spawn_local_bridge to create the sandbox-side relays and rewrite_proxy_env_value to produce the new proxy values.

*Call graph*: calls 2 internal fn (rewrite_proxy_env_value, spawn_local_bridge); called by 1 (run_main); 7 external calls (new, new, other, format!, from_str, set_var, var).


##### `plan_proxy_routes`  (lines 172–201)

```
fn plan_proxy_routes(env: &HashMap<String, String>) -> ProxyRoutePlan
```

**Purpose**: Builds a clean list of proxy routes from environment variables. It keeps only recognized proxy variable names whose values point to loopback proxy endpoints.

**Data flow**: It receives a map of environment variables, skips unrelated or empty entries, notes whether any proxy-like setting existed, parses loopback endpoints, and returns a sorted plan with variable names and socket addresses.

**Call relations**: prepare_host_proxy_route_spec calls this first to decide whether proxy routing can be set up. Its behavior is also checked by tests that ensure non-loopback proxies are ignored.

*Call graph*: calls 2 internal fn (is_proxy_env_key, parse_loopback_proxy_endpoint); called by 2 (prepare_host_proxy_route_spec, plan_proxy_routes_only_includes_valid_loopback_endpoints); 1 external calls (new).


##### `is_proxy_env_key`  (lines 203–206)

```
fn is_proxy_env_key(key: &str) -> bool
```

**Purpose**: Checks whether an environment variable name is one of the proxy-related names this system knows how to route. The check is case-insensitive.

**Data flow**: It receives a variable name, converts it to uppercase, compares it with the built-in proxy key list, and returns true or false.

**Call relations**: plan_proxy_routes uses this as its first filter before looking at a variable’s value.

*Call graph*: called by 1 (plan_proxy_routes).


##### `parse_loopback_proxy_endpoint`  (lines 208–239)

```
fn parse_loopback_proxy_endpoint(proxy_url: &str) -> Option<SocketAddr>
```

**Purpose**: Turns a proxy URL or host:port string into a socket address, but only if it points to loopback. Loopback means the local machine, such as localhost or 127.0.0.1.

**Data flow**: It receives a proxy value, adds an http scheme if one is missing, parses it as a URL, checks that the host is loopback, chooses an explicit or default port, and returns an IP address plus port. If anything is not safe or parseable, it returns nothing.

**Call relations**: plan_proxy_routes calls this to decide which proxy variables can be bridged. Tests call it directly to verify both accepted loopback URLs and rejected remote URLs.

*Call graph*: calls 1 internal fn (is_loopback_host); called by 2 (plan_proxy_routes, parses_loopback_proxy_endpoint); 4 external calls (V4, new, parse, format!).


##### `is_loopback_host`  (lines 241–243)

```
fn is_loopback_host(host: &str) -> bool
```

**Purpose**: Recognizes the loopback host names and addresses that this file accepts. It is deliberately narrow: localhost, 127.0.0.1, and ::1.

**Data flow**: It receives a host string, compares it with the accepted loopback forms, and returns true or false.

**Call relations**: parse_loopback_proxy_endpoint uses this before converting the host into an IP address.

*Call graph*: called by 1 (parse_loopback_proxy_endpoint).


##### `default_proxy_port`  (lines 245–251)

```
fn default_proxy_port(scheme: &str) -> u16
```

**Purpose**: Provides the usual port number for proxy URLs that do not include a port. This keeps common proxy forms working even when users omit the port.

**Data flow**: It receives a URL scheme such as http, https, or socks5h and returns the conventional port for that scheme: for example 80 for http or 1080 for SOCKS.

**Call relations**: parse_loopback_proxy_endpoint uses this when a proxy URL has no explicit port. Tests check that the expected scheme-to-port mapping stays stable.


##### `rewrite_proxy_env_value`  (lines 253–279)

```
fn rewrite_proxy_env_value(proxy_url: &str, local_port: u16) -> Option<String>
```

**Purpose**: Rewrites a proxy setting so it points to the sandbox’s local bridge instead of the original host-side proxy address. It preserves the rest of the URL as much as possible.

**Data flow**: It receives the original proxy string and a local port, parses the string, replaces the host with 127.0.0.1, replaces the port with the local bridge port, and returns the rewritten string. If the original had no URL scheme, it removes the temporary scheme again before returning.

**Call relations**: activate_proxy_routes_in_netns calls this for each routed environment variable. A test calls it directly to confirm SOCKS-style proxy URLs are rewritten correctly.

*Call graph*: called by 2 (activate_proxy_routes_in_netns, rewrites_proxy_url_to_local_loopback_port); 2 external calls (parse, format!).


##### `create_proxy_socket_dir`  (lines 281–304)

```
fn create_proxy_socket_dir() -> io::Result<PathBuf>
```

**Purpose**: Creates a private temporary directory to hold the Unix socket files used by the host bridges. The directory permissions block other users from browsing through it.

**Data flow**: It chooses a parent directory, combines the current process ID, user ID, and an attempt number into a unique directory name, and tries to create that directory with private permissions. It returns the new directory path or an error if it cannot find a free name.

**Call relations**: prepare_host_proxy_route_spec calls this before starting host bridges, because each bridge needs a socket path to listen on.

*Call graph*: calls 1 internal fn (proxy_socket_parent_dir); called by 1 (prepare_host_proxy_route_spec); 5 external calls (new, new, format!, geteuid, id).


##### `proxy_socket_parent_dir`  (lines 306–321)

```
fn proxy_socket_parent_dir() -> PathBuf
```

**Purpose**: Chooses where proxy socket directories should live. It prefers CODEX_HOME/tmp when safe and usable, then falls back to the system temporary directory or /tmp.

**Data flow**: It checks the CODEX_HOME environment variable, tests whether socket paths under that location would fit Linux’s short Unix-socket path limit, and tries to create the directory privately. If that does not work, it picks a safe fallback.

**Call relations**: prepare_host_proxy_route_spec uses it for stale cleanup, and create_proxy_socket_dir uses it when allocating the new per-run socket directory.

*Call graph*: calls 2 internal fn (ensure_private_proxy_socket_parent_dir, proxy_socket_paths_fit); called by 2 (create_proxy_socket_dir, prepare_host_proxy_route_spec); 3 external calls (from, temp_dir, var_os).


##### `proxy_socket_paths_fit`  (lines 323–332)

```
fn proxy_socket_paths_fit(parent: &Path) -> bool
```

**Purpose**: Checks whether socket file paths under a given parent directory can fit within Linux’s Unix socket path length limit. Unix socket paths have a small fixed maximum, so long temp paths can break binding.

**Data flow**: It builds a worst-case socket path under the proposed parent directory, measures its byte length, and returns whether it fits within the allowed limit.

**Call relations**: proxy_socket_parent_dir calls this before choosing a directory, so later bridge setup does not fail because the socket path is too long.

*Call graph*: called by 1 (proxy_socket_parent_dir); 2 external calls (join, format!).


##### `ensure_private_proxy_socket_parent_dir`  (lines 334–344)

```
fn ensure_private_proxy_socket_parent_dir(path: &Path) -> io::Result<()>
```

**Purpose**: Creates or fixes the parent directory used for proxy sockets so only the current user can access it. This matters because socket paths are communication endpoints.

**Data flow**: It receives a path, creates it and any missing parents if needed, then sets its permissions to owner-only access. It returns success or the filesystem error.

**Call relations**: proxy_socket_parent_dir calls this when considering CODEX_HOME/tmp as the preferred socket parent.

*Call graph*: called by 1 (proxy_socket_parent_dir); 3 external calls (new, from_mode, set_permissions).


##### `cleanup_stale_proxy_socket_dirs_in`  (lines 346–373)

```
fn cleanup_stale_proxy_socket_dirs_in(temp_dir: &Path) -> io::Result<()>
```

**Purpose**: Removes old proxy socket directories left behind by dead sandbox setup processes. This prevents temporary files from piling up over time.

**Data flow**: It scans a temporary directory, looks for subdirectories with this file’s proxy-directory naming pattern, extracts the owner process ID, checks whether that process is still alive, and deletes the directory if the owner is gone.

**Call relations**: prepare_host_proxy_route_spec runs this opportunistically before creating a new socket directory. A test builds fake alive, dead, and unrelated directories to verify the cleanup rules.

*Call graph*: calls 3 internal fn (cleanup_proxy_socket_dir, is_pid_alive, parse_proxy_socket_dir_owner_pid); called by 2 (prepare_host_proxy_route_spec, cleanup_stale_proxy_socket_dirs_removes_dead_pid_directories); 1 external calls (read_dir).


##### `parse_proxy_socket_dir_owner_pid`  (lines 375–379)

```
fn parse_proxy_socket_dir_owner_pid(file_name: &str) -> Option<u32>
```

**Purpose**: Extracts the process ID embedded in a proxy socket directory name. This lets cleanup code decide whether the directory’s owner is still running.

**Data flow**: It receives a directory name, checks for the expected prefix, reads the first number after that prefix, and returns it if it is a nonzero process ID.

**Call relations**: cleanup_stale_proxy_socket_dirs_in calls this while scanning temporary directories. Tests call it directly with valid and invalid names.

*Call graph*: called by 1 (cleanup_stale_proxy_socket_dirs_in).


##### `is_pid_alive`  (lines 381–386)

```
fn is_pid_alive(pid: u32) -> bool
```

**Purpose**: Checks whether a process ID is likely still alive. It first converts the stored number into the operating system’s process ID type.

**Data flow**: It receives a u32 process ID, rejects it if it cannot fit the system type, then asks is_pid_alive_raw to perform the actual operating-system check.

**Call relations**: cleanup_stale_proxy_socket_dirs_in uses this before deleting a socket directory, so it avoids removing files that belong to a running process.

*Call graph*: calls 1 internal fn (is_pid_alive_raw); called by 1 (cleanup_stale_proxy_socket_dirs_in); 1 external calls (try_from).


##### `is_pid_alive_raw`  (lines 388–395)

```
fn is_pid_alive_raw(pid: libc::pid_t) -> bool
```

**Purpose**: Asks Linux whether a process exists without sending it a real signal. This is a common use of kill(pid, 0), where signal 0 means “check only.”

**Data flow**: It receives a process ID, calls the operating system, and returns true if the process exists or if permission prevents certainty. It returns false only when Linux says there is no such process.

**Call relations**: is_pid_alive uses this for stale directory cleanup. The cleanup worker also uses it to wait until bridge child processes have exited.

*Call graph*: called by 1 (is_pid_alive); 3 external calls (last_os_error, kill, matches!).


##### `spawn_proxy_socket_dir_cleanup_worker`  (lines 397–423)

```
fn spawn_proxy_socket_dir_cleanup_worker(
    socket_dir: PathBuf,
    host_bridge_pids: Vec<libc::pid_t>,
) -> io::Result<()>
```

**Purpose**: Starts a small child process whose only job is to delete the proxy socket directory after all host bridge processes are gone. This is a safety net for cleanup.

**Data flow**: It receives the socket directory path and the host bridge process IDs, forks a child, and in the child repeatedly checks whether all bridge processes have exited. Once they have, it removes the directory and exits.

**Call relations**: prepare_host_proxy_route_spec starts this after launching host bridges. It calls cleanup_proxy_socket_dir when the bridges are no longer alive.

*Call graph*: calls 1 internal fn (cleanup_proxy_socket_dir); called by 1 (prepare_host_proxy_route_spec); 6 external calls (from_millis, as_path, last_os_error, _exit, fork, sleep).


##### `cleanup_proxy_socket_dir`  (lines 425–439)

```
fn cleanup_proxy_socket_dir(socket_dir: &Path) -> io::Result<()>
```

**Purpose**: Deletes a proxy socket directory and everything inside it, retrying briefly if removal fails. This helps clean up sockets even if the filesystem is momentarily busy.

**Data flow**: It receives a directory path, repeatedly tries to remove it, treats “not found” as success, sleeps between failed attempts, and finally returns success or the last error.

**Call relations**: cleanup_stale_proxy_socket_dirs_in uses it for old directories, spawn_proxy_socket_dir_cleanup_worker uses it after bridges exit, and a test verifies that it removes bridge artifacts.

*Call graph*: called by 3 (cleanup_stale_proxy_socket_dirs_in, spawn_proxy_socket_dir_cleanup_worker, cleanup_proxy_socket_dir_removes_bridge_artifacts); 3 external calls (from_millis, remove_dir_all, sleep).


##### `spawn_host_bridge`  (lines 441–472)

```
fn spawn_host_bridge(endpoint: SocketAddr, uds_path: &Path) -> io::Result<libc::pid_t>
```

**Purpose**: Forks a host-side bridge process and waits until it is ready. The host bridge listens on a Unix socket and forwards connections to the real host proxy endpoint.

**Data flow**: It receives a proxy endpoint and a Unix socket path, creates a small readiness pipe, forks, and has the child run_host_bridge. The parent waits for a one-byte ready signal and then returns the child process ID.

**Call relations**: prepare_host_proxy_route_spec calls this once per unique proxy endpoint. It delegates the long-running bridge loop to run_host_bridge and uses create_ready_pipe and close_fd around the fork.

*Call graph*: calls 3 internal fn (close_fd, create_ready_pipe, run_host_bridge); called by 1 (prepare_host_proxy_route_spec); 5 external calls (from_raw_fd, last_os_error, other, _exit, fork).


##### `run_host_bridge`  (lines 474–495)

```
fn run_host_bridge(endpoint: SocketAddr, uds_path: &Path, ready_fd: libc::c_int) -> io::Result<()>
```

**Purpose**: Runs the actual host-side relay loop. It accepts local Unix-socket connections and opens matching TCP connections to the original host proxy.

**Data flow**: It receives the target proxy endpoint, socket path, and readiness file descriptor. It hardens the process, binds the Unix socket, signals readiness, then for every accepted Unix connection starts a thread that connects to the TCP proxy and copies traffic both ways.

**Call relations**: spawn_host_bridge runs this in the forked child. It calls harden_bridge_process before serving and uses proxy_bidirectional inside per-connection threads.

*Call graph*: calls 2 internal fn (harden_bridge_process, bind); called by 1 (spawn_host_bridge); 4 external calls (from_raw_fd, exists, remove_file, spawn).


##### `spawn_local_bridge`  (lines 497–523)

```
fn spawn_local_bridge(uds_path: &Path) -> io::Result<u16>
```

**Purpose**: Forks a sandbox-side bridge process and learns which local port it chose. This bridge gives sandboxed programs a normal 127.0.0.1:PORT proxy address to connect to.

**Data flow**: It receives a Unix socket path, creates a readiness pipe, forks, and has the child run_local_bridge. The parent reads the two-byte port number from the pipe and returns it.

**Call relations**: activate_proxy_routes_in_netns calls this for each unique host socket path. It delegates the long-running listener to run_local_bridge.

*Call graph*: calls 3 internal fn (close_fd, create_ready_pipe, run_local_bridge); called by 1 (activate_proxy_routes_in_netns); 5 external calls (from_raw_fd, last_os_error, _exit, fork, from_be_bytes).


##### `run_local_bridge`  (lines 525–546)

```
fn run_local_bridge(uds_path: &Path, ready_fd: libc::c_int) -> io::Result<()>
```

**Purpose**: Runs the sandbox-side relay loop. It listens on the sandbox’s 127.0.0.1 and forwards each connection through the Unix socket to the host bridge.

**Data flow**: It receives the host bridge socket path and readiness file descriptor, hardens the process, binds a loopback TCP listener on an available port, writes that port back to the parent, then accepts TCP connections and connects each one to the Unix socket.

**Call relations**: spawn_local_bridge runs this in the forked child. It calls bind_local_loopback_listener to get a usable port and uses proxy_bidirectional in per-connection threads.

*Call graph*: calls 2 internal fn (bind_local_loopback_listener, harden_bridge_process); called by 1 (spawn_local_bridge); 4 external calls (from_raw_fd, clone, to_path_buf, spawn).


##### `bind_local_loopback_listener`  (lines 548–564)

```
fn bind_local_loopback_listener() -> io::Result<TcpListener>
```

**Purpose**: Creates a TCP listener on 127.0.0.1 with an automatically chosen free port. If loopback networking is not ready inside the namespace, it tries to bring it up and then retries.

**Data flow**: It first tries to bind to 127.0.0.1:0, where port 0 means “choose any free port.” If Linux says the address or network is unavailable, it calls ensure_loopback_interface_up and tries binding again.

**Call relations**: run_local_bridge calls this during startup so it can tell the parent which local port to write into proxy environment variables.

*Call graph*: calls 1 internal fn (ensure_loopback_interface_up); called by 1 (run_local_bridge); 2 external calls (bind, matches!).


##### `ensure_loopback_interface_up`  (lines 566–626)

```
fn ensure_loopback_interface_up() -> io::Result<()>
```

**Purpose**: Makes sure the sandbox network namespace has a working loopback interface. Without this, 127.0.0.1 connections inside the sandbox may fail.

**Data flow**: It opens a low-level network control socket, asks Linux for the flags on the lo interface, sets the interface up if needed, and assigns the 127.0.0.1 address when possible. It closes the control file descriptor before returning.

**Call relations**: bind_local_loopback_listener calls this only after an initial bind fails in a way that suggests loopback is unavailable. It uses close_fd for cleanup.

*Call graph*: calls 1 internal fn (close_fd); called by 1 (bind_local_loopback_listener); 5 external calls (last_os_error, htonl, ioctl, socket, matches!).


##### `set_parent_death_signal`  (lines 628–637)

```
fn set_parent_death_signal() -> io::Result<()>
```

**Purpose**: Tells Linux to send SIGTERM to a bridge child process if its parent dies. This keeps bridge helpers from living forever after the main sandbox setup exits.

**Data flow**: It asks the operating system to set a parent-death signal, then checks whether the process has already been orphaned. It returns success if the child is still tied to a live parent.

**Call relations**: harden_bridge_process calls this before a bridge starts accepting connections.

*Call graph*: called by 1 (harden_bridge_process); 4 external calls (last_os_error, other, getppid, prctl).


##### `harden_bridge_process`  (lines 639–642)

```
fn harden_bridge_process() -> io::Result<()>
```

**Purpose**: Applies safety settings to bridge child processes. It ties their lifetime to the parent and disables process dumping, which reduces accidental exposure of memory in crash dumps.

**Data flow**: It calls set_parent_death_signal, then calls the project’s process-hardening helper to disable dumping. It returns the first error if either step fails.

**Call relations**: run_host_bridge and run_local_bridge both call this before opening their listeners.

*Call graph*: calls 1 internal fn (set_parent_death_signal); called by 2 (run_host_bridge, run_local_bridge); 1 external calls (disable_process_dumping).


##### `proxy_bidirectional`  (lines 644–655)

```
fn proxy_bidirectional(mut tcp_stream: TcpStream, mut unix_stream: UnixStream) -> io::Result<()>
```

**Purpose**: Copies bytes in both directions between a TCP stream and a Unix stream. This is the core “pipe” that makes the proxy bridges transparent to clients.

**Data flow**: It receives an open TCP connection and an open Unix-socket connection, clones the streams so one thread can copy TCP to Unix while the current thread copies Unix to TCP, waits for both directions to finish, and returns any copy error.

**Call relations**: The bridge loops in run_host_bridge and run_local_bridge use this inside connection-handling threads to relay each accepted connection.

*Call graph*: 4 external calls (try_clone, copy, spawn, try_clone).


##### `create_ready_pipe`  (lines 657–664)

```
fn create_ready_pipe() -> io::Result<(libc::c_int, libc::c_int)>
```

**Purpose**: Creates a small pipe used by parent and child processes to signal readiness after a fork. This prevents the parent from continuing before a bridge is actually listening.

**Data flow**: It asks Linux for a pipe with close-on-exec behavior, then returns the read and write file descriptors. On failure it returns the operating-system error.

**Call relations**: spawn_host_bridge uses it to wait for a ready byte, and spawn_local_bridge uses it to receive the chosen port.

*Call graph*: called by 2 (spawn_host_bridge, spawn_local_bridge); 2 external calls (last_os_error, pipe2).


##### `close_fd`  (lines 666–672)

```
fn close_fd(fd: libc::c_int) -> io::Result<()>
```

**Purpose**: Closes a raw Unix file descriptor and reports any operating-system error. It is a small helper for careful cleanup around low-level system calls.

**Data flow**: It receives a file descriptor number, calls close on it, and returns success or the last OS error.

**Call relations**: spawn_host_bridge, spawn_local_bridge, and ensure_loopback_interface_up call this when they need to close pipe or socket descriptors.

*Call graph*: called by 3 (ensure_loopback_interface_up, spawn_host_bridge, spawn_local_bridge); 2 external calls (last_os_error, close).


##### `tests::recognizes_proxy_env_keys_case_insensitively`  (lines 694–698)

```
fn recognizes_proxy_env_keys_case_insensitively()
```

**Purpose**: Checks that proxy environment variable names are recognized regardless of letter case, and that unrelated names are ignored.

**Data flow**: It passes sample names into is_proxy_env_key and compares the returned booleans with expected results.

**Call relations**: This test protects the filtering step used by plan_proxy_routes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_loopback_proxy_endpoint`  (lines 701–711)

```
fn parses_loopback_proxy_endpoint()
```

**Purpose**: Verifies that a normal loopback proxy URL is accepted and converted into the expected socket address.

**Data flow**: It gives parse_loopback_proxy_endpoint a 127.0.0.1 URL with a port and checks that the output is the same address and port.

**Call relations**: This test protects the parsing used by plan_proxy_routes during host setup.

*Call graph*: calls 1 internal fn (parse_loopback_proxy_endpoint); 1 external calls (assert_eq!).


##### `tests::ignores_non_loopback_proxy_endpoint`  (lines 714–719)

```
fn ignores_non_loopback_proxy_endpoint()
```

**Purpose**: Verifies that proxy URLs pointing at remote hosts are not selected for managed loopback routing.

**Data flow**: It checks that parsing an example.com proxy URL returns no endpoint.

**Call relations**: This test supports the safety rule enforced by parse_loopback_proxy_endpoint.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plan_proxy_routes_only_includes_valid_loopback_endpoints`  (lines 722–744)

```
fn plan_proxy_routes_only_includes_valid_loopback_endpoints()
```

**Purpose**: Checks that route planning keeps valid loopback proxies, ignores remote proxies, and ignores unrelated environment variables.

**Data flow**: It builds a fake environment map with one loopback proxy, one remote proxy, and PATH, then checks that the resulting plan contains only the loopback route while still noting that proxy configuration existed.

**Call relations**: This test exercises plan_proxy_routes as prepare_host_proxy_route_spec would use it.

*Call graph*: calls 1 internal fn (plan_proxy_routes); 2 external calls (new, assert_eq!).


##### `tests::rewrites_proxy_url_to_local_loopback_port`  (lines 747–752)

```
fn rewrites_proxy_url_to_local_loopback_port()
```

**Purpose**: Checks that proxy URLs are rewritten to use the sandbox local bridge port while keeping the original scheme.

**Data flow**: It passes a SOCKS proxy URL and a replacement port into rewrite_proxy_env_value, then compares the returned URL with the expected 127.0.0.1 address and new port.

**Call relations**: This test protects the environment rewriting done by activate_proxy_routes_in_netns.

*Call graph*: calls 1 internal fn (rewrite_proxy_env_value); 1 external calls (assert_eq!).


##### `tests::default_proxy_ports_match_expected_schemes`  (lines 755–759)

```
fn default_proxy_ports_match_expected_schemes()
```

**Purpose**: Verifies the default port choices for common proxy schemes. This catches accidental changes to expected proxy behavior.

**Data flow**: It calls default_proxy_port for http, https, and socks5h and compares the numbers with the expected conventional ports.

**Call relations**: This test supports parse_loopback_proxy_endpoint, which uses default ports when a URL omits one.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::proxy_socket_paths_enforce_linux_path_limit`  (lines 762–771)

```
fn proxy_socket_paths_enforce_linux_path_limit()
```

**Purpose**: Checks that socket path length validation accepts normal paths and rejects paths that would be too long for Linux Unix sockets.

**Data flow**: It calls proxy_socket_paths_fit with /tmp and with an artificially long path, then checks true for the first and false for the second.

**Call relations**: This test protects proxy_socket_parent_dir’s choice of a usable socket parent directory.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::cleanup_proxy_socket_dir_removes_bridge_artifacts`  (lines 774–784)

```
fn cleanup_proxy_socket_dir_removes_bridge_artifacts()
```

**Purpose**: Verifies that a proxy socket directory and files inside it are removed during cleanup.

**Data flow**: It creates a temporary directory, creates a fake socket directory and marker file, calls cleanup_proxy_socket_dir, and checks that the directory no longer exists.

**Call relations**: This test protects cleanup used both for stale directories and by the cleanup worker.

*Call graph*: calls 1 internal fn (cleanup_proxy_socket_dir); 4 external calls (assert_eq!, create_dir, write, tempdir).


##### `tests::proxy_route_spec_serialization_omits_proxy_urls`  (lines 787–800)

```
fn proxy_route_spec_serialization_omits_proxy_urls()
```

**Purpose**: Checks that serialized proxy route specifications contain only environment variable names and Unix socket paths, not original proxy URL values.

**Data flow**: It builds a ProxyRouteSpec with one route, serializes it to JSON, and compares the exact JSON text with the expected output.

**Call relations**: This test protects the handoff format produced by prepare_host_proxy_route_spec and consumed by activate_proxy_routes_in_netns.

*Call graph*: 3 external calls (assert_eq!, to_string, vec!).


##### `tests::parse_proxy_socket_dir_owner_pid_reads_owner_pid`  (lines 803–817)

```
fn parse_proxy_socket_dir_owner_pid_reads_owner_pid()
```

**Purpose**: Verifies that process IDs are correctly read from proxy socket directory names, and invalid names are rejected.

**Data flow**: It passes several directory-name strings into parse_proxy_socket_dir_owner_pid and checks for the expected process ID or no result.

**Call relations**: This test protects stale directory cleanup, which depends on extracting the owner process ID from directory names.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::cleanup_stale_proxy_socket_dirs_removes_dead_pid_directories`  (lines 820–840)

```
fn cleanup_stale_proxy_socket_dirs_removes_dead_pid_directories()
```

**Purpose**: Checks that stale cleanup removes directories whose owner process is gone while preserving live and unrelated directories.

**Data flow**: It creates fake dead, alive, and unrelated directories under a temporary root, runs cleanup_stale_proxy_socket_dirs_in, and checks which directories remain.

**Call relations**: This test exercises the cleanup path that prepare_host_proxy_route_spec runs before creating new bridge sockets.

*Call graph*: calls 1 internal fn (cleanup_stale_proxy_socket_dirs_in); 4 external calls (assert_eq!, format!, create_dir, tempdir).


### `tui/src/ide_context/windows_pipe.rs`

`io_transport` · `IPC connection and request handling on Windows`

This file is the Windows transport layer for the IDE context client. A named pipe is like a private local phone line between two programs on the same machine. The app opens that line, sends and receives bytes, and turns Windows-specific errors into normal Rust input/output errors.

The main type, WindowsPipeStream, acts like a regular readable and writable stream. When it connects, it opens the pipe path using Windows APIs, then verifies that the program on the other end is owned by the current Windows user. That check matters because named pipe paths can be spoofed; without it, the app might accidentally send IDE context information to a different user's or malicious process.

Reads and writes use Windows “overlapped I/O,” which means the operating system can do the work in the background while this code waits on an event. The OverlappedOperation helper creates that event, waits only until the configured deadline, and cancels the operation if time runs out. This is the safety valve that prevents a stuck IDE provider from freezing the client.

Small helper types keep raw Windows handles safe. OwnedHandle closes handles automatically when they are no longer needed, like returning borrowed keys when leaving a building. TokenUserBuffer stores Windows security token data and extracts the user identity from it for the ownership check.

#### Function details

##### `WindowsPipeStream::connect`  (lines 56–82)

```
fn connect(pipe_path: PathBuf, deadline: Instant) -> io::Result<Self>
```

**Purpose**: Opens a Windows named pipe and turns it into a WindowsPipeStream that can be read from and written to. It also confirms that the pipe server is owned by the same Windows user before allowing communication.

**Data flow**: It receives a pipe path and a deadline. The path is converted into the wide-character form Windows expects, then CreateFileW opens the pipe for reading and writing with overlapped, deadline-friendly I/O. If opening succeeds, the raw Windows handle is wrapped in OwnedHandle and passed through the server-owner validation check. The result is either a ready stream with its deadline saved, or an input/output error.

**Call relations**: The higher-level connect_stream code calls this when it needs the Windows version of the IDE context connection. Before handing the stream back, this function calls validate_pipe_server_owner so the rest of the system only talks to a trusted local provider.

*Call graph*: calls 1 internal fn (validate_pipe_server_owner); called by 1 (connect_stream); 5 external calls (as_os_str, last_os_error, null, once, CreateFileW).


##### `WindowsPipeStream::set_deadline`  (lines 84–86)

```
fn set_deadline(&mut self, deadline: Instant)
```

**Purpose**: Updates the time limit used by later reads and writes. This lets callers tighten or extend how long communication with the IDE context provider may wait.

**Data flow**: It receives a new Instant value and replaces the stream's stored deadline with it. It returns nothing and does not touch the pipe itself.

**Call relations**: This is used by code that already has a WindowsPipeStream and wants future read or write operations to follow a new timeout. The stored deadline is later read by WindowsPipeStream::read and WindowsPipeStream::write when they wait for Windows I/O to finish.


##### `WindowsPipeStream::read`  (lines 90–108)

```
fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>
```

**Purpose**: Reads bytes from the named pipe into a caller-provided buffer. It respects the stream's deadline so a slow or stuck provider cannot block the app forever.

**Data flow**: It receives a mutable byte buffer. If the buffer is empty, it immediately reports that zero bytes were read. Otherwise it creates an OverlappedOperation, asks Windows to read from the pipe handle into the buffer, and then waits for completion through OverlappedOperation::complete. The output is the number of bytes actually read, or an error such as timeout or Windows failure.

**Call relations**: This is the standard Rust Read implementation for WindowsPipeStream, so any code treating the stream like a normal input source will come here. It creates an OverlappedOperation for the single read and relies on OwnedHandle::raw to give Windows the underlying handle.

*Call graph*: calls 2 internal fn (new, raw); 3 external calls (null_mut, try_from, ReadFile).


##### `WindowsPipeStream::write`  (lines 112–130)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Writes bytes to the named pipe. Like reading, it uses the stored deadline so sending data cannot hang indefinitely.

**Data flow**: It receives a byte slice to send. If there is nothing to send, it immediately reports that zero bytes were written. Otherwise it creates an OverlappedOperation, asks Windows to write those bytes to the pipe handle, and lets OverlappedOperation::complete wait for the result. It returns the number of bytes Windows accepted, or an error.

**Call relations**: This is the standard Rust Write implementation for WindowsPipeStream, so higher-level message-sending code can use ordinary writing APIs. It hands the low-level waiting, timeout, and cancellation work to OverlappedOperation::complete.

*Call graph*: calls 2 internal fn (new, raw); 3 external calls (null_mut, try_from, WriteFile).


##### `WindowsPipeStream::flush`  (lines 132–134)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Satisfies Rust's Write interface by providing a flush operation. For this pipe stream there is no extra user-space buffer to push out, so flushing is a no-op.

**Data flow**: It receives the stream by mutable reference, makes no changes, and returns success. No data is sent and no Windows API call is needed.

**Call relations**: Code that uses generic Write behavior may call flush after writing. This function lets that code work normally even though WindowsPipeStream does not need a separate flush step.


##### `OverlappedOperation::new`  (lines 143–155)

```
fn new() -> io::Result<Self>
```

**Purpose**: Creates the small bundle of Windows state needed for one background-style read or write operation. In particular, it creates an event that Windows can signal when the operation is finished.

**Data flow**: It asks Windows to create an event object. If that fails, it returns the operating system error. If it succeeds, it builds a zeroed OVERLAPPED structure, stores the event in it, wraps the event handle in OwnedHandle, and returns the new OverlappedOperation.

**Call relations**: WindowsPipeStream::read and WindowsPipeStream::write call this before starting each pipe operation. The returned object is then passed to Windows and later completed by OverlappedOperation::complete.

*Call graph*: called by 2 (read, write); 3 external calls (last_os_error, null, CreateEventW).


##### `OverlappedOperation::as_mut_ptr`  (lines 157–159)

```
fn as_mut_ptr(&mut self) -> *mut OVERLAPPED
```

**Purpose**: Gives Windows APIs a raw pointer to the operation's OVERLAPPED structure. This is needed because the Windows functions work with low-level pointers rather than Rust references.

**Data flow**: It receives the operation, takes the address of its internal OVERLAPPED value, and returns that pointer. It does not allocate memory or finish any I/O by itself.

**Call relations**: OverlappedOperation::complete uses this pointer when asking Windows how many bytes transferred. OverlappedOperation::cancel_and_timeout uses it when canceling or draining the same pending operation.

*Call graph*: called by 2 (cancel_and_timeout, complete).


##### `OverlappedOperation::complete`  (lines 161–196)

```
fn complete(
        &mut self,
        handle: HANDLE,
        initial_result: BOOL,
        deadline: Instant,
    ) -> io::Result<usize>
```

**Purpose**: Waits for a read or write operation to finish, but only until the given deadline. It turns Windows completion details into a simple byte count or an ordinary Rust I/O error.

**Data flow**: It receives the pipe handle, the immediate result from ReadFile or WriteFile, and the deadline. If Windows says the operation already failed for a reason other than 'still pending,' it returns that error. If the operation is pending, it waits on the event for the remaining time. A signal means it can collect the final byte count; a timeout means it cancels the operation and returns a timeout error; a wait failure becomes an OS error. On success it returns the number of bytes transferred.

**Call relations**: WindowsPipeStream::read and WindowsPipeStream::write call this right after starting their Windows I/O. If time runs out, it hands control to OverlappedOperation::cancel_and_timeout so the low-level operation is not left dangling while Rust moves on.

*Call graph*: calls 4 internal fn (as_mut_ptr, cancel_and_timeout, raw, remaining_timeout_ms); 5 external calls (last_os_error, other, format!, GetOverlappedResult, WaitForSingleObject).


##### `OverlappedOperation::cancel_and_timeout`  (lines 198–220)

```
fn cancel_and_timeout(&mut self, handle: HANDLE) -> io::Error
```

**Purpose**: Stops a pending Windows I/O operation after the deadline has passed and returns a timeout error. It also carefully cleans up the operation so Windows is no longer using the memory owned by this Rust object.

**Data flow**: It receives the pipe handle and uses the operation's OVERLAPPED pointer to request cancellation. If Windows says the operation was not found, that means it likely completed just before cancellation; the function drains the final result without waiting and still reports timeout. If cancellation starts successfully, it waits for Windows to finish canceling, then returns a timeout error. In unusual cancellation failures, it returns the Windows error instead.

**Call relations**: OverlappedOperation::complete calls this only when waiting reaches the deadline. This function calls timeout_io_error to produce the consistent timeout message used by the pipe transport.

*Call graph*: calls 2 internal fn (as_mut_ptr, timeout_io_error); called by 1 (complete); 3 external calls (last_os_error, CancelIoEx, GetOverlappedResult).


##### `OwnedHandle::raw`  (lines 226–228)

```
fn raw(&self) -> HANDLE
```

**Purpose**: Returns the underlying Windows handle so low-level Windows API calls can use it. This keeps most code working with the safer OwnedHandle wrapper while still allowing the necessary system calls.

**Data flow**: It receives an OwnedHandle by reference and returns the raw HANDLE value stored inside it. It does not close, duplicate, or change the handle.

**Call relations**: Read, write, and completion paths call this when passing handles to Windows APIs. It is the small bridge between Rust's ownership wrapper and Windows' raw handle-based interface.

*Call graph*: called by 3 (complete, read, write).


##### `OwnedHandle::drop`  (lines 232–238)

```
fn drop(&mut self)
```

**Purpose**: Automatically closes a Windows handle when its OwnedHandle wrapper goes out of scope. This prevents handle leaks, which are like leaving files or connections open after the program is done with them.

**Data flow**: When Rust is destroying an OwnedHandle, this function checks whether the stored handle is nonzero and not the special invalid value. If it is a real handle, it calls CloseHandle. It returns nothing, but it releases the operating system resource.

**Call relations**: This runs automatically for pipe handles, event handles, process handles, and token handles wrapped in OwnedHandle. Other functions do not need to remember to close those handles manually.

*Call graph*: 1 external calls (CloseHandle).


##### `TokenUserBuffer::sid`  (lines 246–260)

```
fn sid(&self) -> io::Result<windows_sys::Win32::Foundation::PSID>
```

**Purpose**: Extracts the Windows user identity, called a SID or security identifier, from token data. A SID is Windows' stable internal label for a user account.

**Data flow**: It reads the byte buffer filled by Windows token APIs. First it checks the buffer is large enough to contain the fixed TOKEN_USER header. Then it safely copies that header even though the byte buffer may not have the alignment Windows structs usually expect, and returns the SID pointer found inside it. If the buffer is too small, it returns an invalid-data error.

**Call relations**: validate_pipe_server_owner calls this for both the server process token and the current process token. The two SID values are then compared to decide whether the pipe server belongs to the same user.

*Call graph*: 2 external calls (new, read_unaligned).


##### `validate_pipe_server_owner`  (lines 263–289)

```
fn validate_pipe_server_owner(pipe_handle: HANDLE) -> io::Result<()>
```

**Purpose**: Checks that the process serving the named pipe is owned by the same Windows user as the current process. This is a security check that helps prevent connecting to an impostor pipe server.

**Data flow**: It receives an open pipe handle. It asks Windows for the server process ID behind that pipe, opens that process for limited information, opens security tokens for both the server process and the current process, and reads each token's user data. It compares the two user SIDs. If they match, it returns success; if they differ, it returns a permission-denied error; if any Windows step fails, it returns that OS error.

**Call relations**: WindowsPipeStream::connect calls this immediately after opening the pipe and before returning a usable stream. This function depends on open_process_token and token_user to gather the identity information it needs for the comparison.

*Call graph*: calls 2 internal fn (open_process_token, token_user); called by 1 (connect); 6 external calls (last_os_error, new, EqualSid, GetNamedPipeServerProcessId, GetCurrentProcess, OpenProcess).


##### `open_process_token`  (lines 291–299)

```
fn open_process_token(process: HANDLE) -> io::Result<OwnedHandle>
```

**Purpose**: Opens the Windows security token for a process so the code can inspect which user owns that process. A token is Windows' record of a process's security identity and permissions.

**Data flow**: It receives a process handle, asks Windows to open that process's token with query permission, and stores the resulting token handle in OwnedHandle. On success it returns the owned token handle; on failure it returns the last Windows error.

**Call relations**: validate_pipe_server_owner calls this for the pipe server process and for the current process. The returned token handles are then passed to token_user to read the user identity.

*Call graph*: called by 1 (validate_pipe_server_owner); 2 external calls (last_os_error, OpenProcessToken).


##### `token_user`  (lines 301–325)

```
fn token_user(token: HANDLE) -> io::Result<TokenUserBuffer>
```

**Purpose**: Reads the user section from a Windows security token. It packages the raw bytes so TokenUserBuffer::sid can later extract the user SID.

**Data flow**: It receives a token handle. First it calls GetTokenInformation with no output buffer so Windows tells it how large the buffer must be. It allocates a byte vector of that size, calls GetTokenInformation again to fill it, and returns a TokenUserBuffer containing the bytes. If Windows cannot provide the size or data, it returns an OS error.

**Call relations**: validate_pipe_server_owner calls this after opening process tokens. The returned TokenUserBuffer values are used to compare the server's user with the current user's identity.

*Call graph*: called by 1 (validate_pipe_server_owner); 4 external calls (last_os_error, null_mut, vec!, GetTokenInformation).


##### `remaining_timeout_ms`  (lines 327–335)

```
fn remaining_timeout_ms(deadline: Instant) -> u32
```

**Purpose**: Calculates how many milliseconds are left until a deadline, in the form Windows wait functions expect. It returns zero if the deadline has already passed.

**Data flow**: It reads the current time and compares it with the deadline. If now is at or after the deadline, it returns 0. Otherwise it converts the remaining duration to milliseconds, uses at least 1 millisecond for any positive remaining time, and caps the value if it is too large for a Windows 32-bit timeout number.

**Call relations**: OverlappedOperation::complete calls this before waiting on the Windows event. Its result controls how long the read or write operation is allowed to keep the caller waiting.

*Call graph*: called by 1 (complete); 3 external calls (duration_since, now, try_from).


##### `timeout_io_error`  (lines 337–339)

```
fn timeout_io_error() -> io::Error
```

**Purpose**: Creates the standard timeout error used when the IDE context pipe does not respond before the deadline. Keeping this in one helper gives the transport a consistent error kind and message.

**Data flow**: It takes no input. It constructs and returns an io::Error with the TimedOut kind and the message 'timed out waiting for IDE context'.

**Call relations**: OverlappedOperation::cancel_and_timeout calls this after canceling or draining a timed-out operation. That timeout error then travels back through OverlappedOperation::complete to the read or write caller.

*Call graph*: called by 1 (cancel_and_timeout); 1 external calls (new).


### `tui/src/ide_context/ipc.rs`

`io_transport` · `request handling for `/ide` and prompt-time IDE context fetches`

When a user types `/ide`, Codex needs to fetch context from the editor without hanging the terminal or trusting the wrong local process. This file is the messenger for that job. It finds the local IPC endpoint, opens a short-lived connection, sends a JSON request asking for IDE context, waits up to five seconds, and turns the reply into an `IdeContext` value the rest of the TUI can use.

IPC means “inter-process communication”: two programs on the same machine talking to each other. On Unix this uses a Unix socket, which is like a private local phone line. On Windows it uses a named pipe. The file also defines careful safety checks for Unix: the socket directory and socket must belong to the current user, and on supported systems the connected peer is checked too. This helps prevent another user on the same machine from impersonating the IDE extension.

Messages are sent as length-prefixed JSON: first four bytes say how long the message is, then the JSON body follows. The code enforces a maximum response size and a single deadline across connecting, writing, and reading. It also politely answers unrelated incoming requests with “I cannot handle this,” while ignoring broadcasts until the matching response arrives.

#### Function details

##### `IdeContextError::user_facing_hint`  (lines 120–122)

```
fn user_facing_hint(&self) -> String
```

**Purpose**: Turns an internal IDE context error into a short message a user can act on. It chooses different advice depending on whether the problem is connection, timeout, oversized context, bad response, or unsupported platform.

**Data flow**: It starts with one `IdeContextError` value. It inspects which kind of failure happened and produces a plain text hint, such as opening the project in the IDE or clearing a large selection.

**Call relations**: This is used when the UI needs to explain a failed `/ide` request directly to the user. It does not fix the error; it translates the technical failure into practical next steps.

*Call graph*: 1 external calls (format!).


##### `IdeContextError::prompt_skip_hint`  (lines 125–127)

```
fn prompt_skip_hint(&self) -> String
```

**Purpose**: Explains why Codex skipped IDE context during a prompt, usually in a way that reassures the user Codex will try again later. It is tuned for background failures that should not stop the whole prompt.

**Data flow**: It receives an `IdeContextError`, checks the specific cause, and returns a text hint. For retryable problems it adds a message saying Codex will keep trying on future messages.

**Call relations**: When prompt-time IDE context fetching fails, this function gives the UI a concise reason. It delegates the common “and I will retry” wording to `hint_with_retry`.

*Call graph*: calls 1 internal fn (hint_with_retry).


##### `hint_with_retry`  (lines 131–133)

```
fn hint_with_retry(message: &str) -> String
```

**Purpose**: Adds the standard retry reassurance to an error message. This keeps several prompt-skip messages consistent.

**Data flow**: It takes a short message string, appends the shared “Codex will keep trying on future messages” text, and returns the combined string.

**Call relations**: `IdeContextError::prompt_skip_hint` calls this whenever a failure should be shown as temporary or retryable.

*Call graph*: called by 1 (prompt_skip_hint); 1 external calls (format!).


##### `fetch_ide_context`  (lines 151–153)

```
fn fetch_ide_context(_workspace_root: &Path) -> Result<IdeContext, IdeContextError>
```

**Purpose**: This is the main public doorway in this file for getting IDE context for a workspace. On supported platforms it connects to the default local IPC endpoint and asks the IDE extension for context.

**Data flow**: It receives the workspace root path. It builds the default socket or pipe path, uses the standard five-second timeout, and returns either an `IdeContext` or an `IdeContextError`.

**Call relations**: Higher-level TUI code calls this when it needs IDE context. It hands the real work to `fetch_ide_context_from_socket` after asking `default_ipc_socket_path` where to connect.

*Call graph*: calls 2 internal fn (default_ipc_socket_path, fetch_ide_context_from_socket).


##### `default_ipc_socket_path`  (lines 169–171)

```
fn default_ipc_socket_path() -> PathBuf
```

**Purpose**: Chooses the default local address where the IDE context provider should be listening. The exact address differs by operating system.

**Data flow**: It reads platform information, such as the current user ID on Unix, and produces a `PathBuf` pointing to the expected Unix socket or Windows named pipe.

**Call relations**: `fetch_ide_context` calls this before opening a connection. It is the map lookup that tells the client where the local IDE communication line should be.

*Call graph*: called by 1 (fetch_ide_context); 5 external calls (from, new, format!, getuid, temp_dir).


##### `fetch_ide_context_from_socket`  (lines 174–182)

```
fn fetch_ide_context_from_socket(
    socket_path: PathBuf,
    workspace_root: &Path,
    timeout: Duration,
) -> Result<IdeContext, IdeContextError>
```

**Purpose**: Connects to a specific IPC endpoint and performs one complete IDE context request within a deadline. This is useful both for the default path and for tests that use a temporary socket.

**Data flow**: It receives a socket or pipe path, a workspace root, and a timeout. It calculates an absolute deadline, opens the stream, sends the request, reads the response, and returns the parsed `IdeContext` or an error.

**Call relations**: `fetch_ide_context` uses this for normal operation, and a test uses it with a temporary socket. It first calls `connect_stream`, then passes the connected stream to `fetch_ide_context_from_stream`.

*Call graph*: calls 2 internal fn (connect_stream, fetch_ide_context_from_stream); called by 2 (fetch_ide_context, fetch_ide_context_uses_unregistered_request_route); 1 external calls (now).


##### `UnixDeadlineStream::connect`  (lines 200–204)

```
fn connect(socket_path: PathBuf, deadline: Instant) -> std::io::Result<Self>
```

**Purpose**: Opens a Unix socket connection that respects a fixed deadline and verifies the peer is safe to talk to. It is a guarded version of a normal local socket connect.

**Data flow**: It receives the socket path and deadline. It connects before time runs out, checks that the process on the other end belongs to the current user where possible, and returns a `UnixDeadlineStream`.

**Call relations**: The Unix version of `connect_stream` calls this. Internally it relies on `connect_unix_stream_before_deadline`, `validate_unix_peer_owner`, and then constructs the stream wrapper.

*Call graph*: calls 2 internal fn (connect_unix_stream_before_deadline, validate_unix_peer_owner); called by 1 (connect_stream); 1 external calls (new).


##### `UnixDeadlineStream::new`  (lines 206–208)

```
fn new(stream: std::os::unix::net::UnixStream, deadline: Instant) -> Self
```

**Purpose**: Wraps an existing Unix socket with a deadline-aware helper object. Tests also use it directly to check timeout behavior.

**Data flow**: It takes a `UnixStream` and an `Instant` deadline, stores both together, and returns a `UnixDeadlineStream`.

**Call relations**: `UnixDeadlineStream::connect` uses this after a successful connection. The timeout test also calls it with one side of a socket pair.

*Call graph*: called by 1 (unix_deadline_stream_uses_remaining_deadline_for_blocking_reads).


##### `UnixDeadlineStream::set_deadline`  (lines 210–212)

```
fn set_deadline(&mut self, deadline: Instant)
```

**Purpose**: Updates the deadline used by future reads and writes on the Unix stream. This lets the response-reading loop keep the same overall request budget.

**Data flow**: It receives a new deadline and replaces the stream wrapper’s stored deadline. It does not read or write any network data.

**Call relations**: `read_response_frame` sets the stream deadline before reading each frame, so lower-level blocking reads still obey the overall IDE request timeout.


##### `UnixDeadlineStream::wait_for_ready`  (lines 214–218)

```
fn wait_for_ready(&self, events: libc::c_short) -> std::io::Result<()>
```

**Purpose**: Waits until the Unix socket is ready for reading or writing, but only until the stored deadline. This prevents the terminal from getting stuck forever.

**Data flow**: It receives the kind of event to wait for, such as readable or writable. It asks the operating system to wait on the socket file descriptor and returns success or an I/O error.

**Call relations**: The Unix stream’s `read`, `write`, and `flush` methods call this before touching the socket. It delegates the operating-system wait to `wait_for_fd_ready`.

*Call graph*: calls 1 internal fn (wait_for_fd_ready); called by 3 (flush, read, write); 1 external calls (as_raw_fd).


##### `connect_unix_stream_before_deadline`  (lines 222–262)

```
fn connect_unix_stream_before_deadline(
    socket_path: &Path,
    deadline: Instant,
) -> std::io::Result<std::os::unix::net::UnixStream>
```

**Purpose**: Creates and connects a low-level Unix socket without blocking past the deadline. It also prepares the socket so it behaves safely in this process.

**Data flow**: It receives a socket path and deadline. It validates the path, builds the Unix socket address, creates a non-blocking socket, marks it close-on-exec, starts the connection, waits if the connection is still in progress, checks the final socket error, and returns a connected `UnixStream`.

**Call relations**: `UnixDeadlineStream::connect` calls this as the core Unix connection step. It coordinates helpers such as `validate_unix_socket_path`, `unix_socket_addr`, `set_fd_close_on_exec`, `set_fd_nonblocking`, `wait_for_fd_ready`, and `socket_error`.

*Call graph*: calls 7 internal fn (is_in_progress_connect_error, set_fd_close_on_exec, set_fd_nonblocking, socket_error, unix_socket_addr, validate_unix_socket_path, wait_for_fd_ready); called by 1 (connect); 6 external calls (from_raw_fd, from_raw_os_error, last_os_error, connect, socket, from_raw_fd).


##### `unix_socket_addr`  (lines 265–314)

```
fn unix_socket_addr(socket_path: &Path) -> std::io::Result<(libc::sockaddr_un, libc::socklen_t)>
```

**Purpose**: Converts a filesystem path into the operating-system structure needed to connect to a Unix socket. It rejects paths that cannot safely fit in that structure.

**Data flow**: It receives a `Path`, reads its raw bytes, rejects embedded nul bytes and overly long paths, fills a `sockaddr_un`, and returns that address plus its length.

**Call relations**: `connect_unix_stream_before_deadline` calls this before making the low-level `connect` system call. It is the adapter between Rust path values and Unix socket APIs.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 4 external calls (as_os_str, new, try_from, try_from).


##### `set_fd_close_on_exec`  (lines 317–328)

```
fn set_fd_close_on_exec(fd: libc::c_int) -> std::io::Result<()>
```

**Purpose**: Marks a file descriptor so child processes will not accidentally inherit it. This is a safety and cleanliness measure for the local IPC connection.

**Data flow**: It receives a file descriptor number, reads its current flags, adds the close-on-exec flag, and returns success or the operating-system error.

**Call relations**: `connect_unix_stream_before_deadline` calls this right after creating the socket, before the socket is used.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 2 external calls (last_os_error, fcntl).


##### `set_fd_nonblocking`  (lines 331–342)

```
fn set_fd_nonblocking(fd: libc::c_int) -> std::io::Result<()>
```

**Purpose**: Puts the socket into non-blocking mode so this file can enforce its own deadline. Without this, a connect or read could wait longer than intended.

**Data flow**: It receives a file descriptor number, reads its current status flags, adds the non-blocking flag, and returns success or an error.

**Call relations**: `connect_unix_stream_before_deadline` calls this before starting the connection. Later reads and writes use readiness checks rather than relying on blocking socket calls.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 2 external calls (last_os_error, fcntl).


##### `is_in_progress_connect_error`  (lines 345–354)

```
fn is_in_progress_connect_error(error: &std::io::Error) -> bool
```

**Purpose**: Recognizes operating-system errors that mean a non-blocking connection is still underway rather than truly failed. This lets the code wait for completion instead of giving up too early.

**Data flow**: It receives an I/O error, checks its raw Unix error code, and returns true for expected “still connecting” cases.

**Call relations**: `connect_unix_stream_before_deadline` uses this immediately after a non-blocking connect attempt reports an error.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 1 external calls (matches!).


##### `socket_error`  (lines 357–380)

```
fn socket_error(fd: libc::c_int) -> std::io::Result<libc::c_int>
```

**Purpose**: Asks the operating system whether a non-blocking socket connection ultimately succeeded or failed. This is the final check after waiting for the socket to become writable.

**Data flow**: It receives a file descriptor, calls the socket option that stores the pending connection error, and returns the error code, where zero means success.

**Call relations**: `connect_unix_stream_before_deadline` calls this after `wait_for_fd_ready` says the connect attempt has finished.

*Call graph*: called by 1 (connect_unix_stream_before_deadline); 3 external calls (last_os_error, getsockopt, try_from).


##### `remaining_timeout`  (lines 383–388)

```
fn remaining_timeout(deadline: Instant) -> std::io::Result<Duration>
```

**Purpose**: Calculates how much time is left before a deadline. If the deadline has already passed, it returns a timeout error.

**Data flow**: It receives a deadline `Instant`, compares it with the current time, and returns the remaining `Duration` or an I/O timeout error.

**Call relations**: `remaining_timeout_ms` calls this before passing a timeout value to the operating system’s polling function.

*Call graph*: called by 1 (remaining_timeout_ms); 2 external calls (checked_duration_since, now).


##### `remaining_timeout_ms`  (lines 391–394)

```
fn remaining_timeout_ms(deadline: Instant) -> std::io::Result<libc::c_int>
```

**Purpose**: Turns the remaining time before a deadline into milliseconds for Unix `poll`, the system call used to wait for socket readiness. It ensures very small positive durations still wait at least one millisecond.

**Data flow**: It receives a deadline, gets the remaining duration, converts it to milliseconds, caps it if too large for the C integer type, and returns that number.

**Call relations**: `wait_for_fd_ready` calls this every time it waits on the socket.

*Call graph*: calls 1 internal fn (remaining_timeout); called by 1 (wait_for_fd_ready); 1 external calls (try_from).


##### `wait_for_fd_ready`  (lines 397–431)

```
fn wait_for_fd_ready(
    fd: libc::c_int,
    events: libc::c_short,
    deadline: Instant,
) -> std::io::Result<()>
```

**Purpose**: Waits for a Unix file descriptor to become ready for the requested activity, such as reading or writing, without passing the deadline. It is the low-level timeout engine for Unix IPC.

**Data flow**: It receives a file descriptor, desired events, and a deadline. It repeatedly calls `poll`, handles interruptions, reports invalid descriptors, times out when needed, and returns once the socket is ready or has an error/hangup to observe.

**Call relations**: `UnixDeadlineStream::wait_for_ready` uses this for normal reads and writes, and `connect_unix_stream_before_deadline` uses it while a non-blocking connection is finishing.

*Call graph*: calls 2 internal fn (deadline_timeout_io_error, remaining_timeout_ms); called by 2 (wait_for_ready, connect_unix_stream_before_deadline); 3 external calls (last_os_error, new, poll).


##### `UnixDeadlineStream::read`  (lines 435–448)

```
fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize>
```

**Purpose**: Reads bytes from the Unix socket while respecting the stream deadline. It retries harmless temporary conditions but returns real errors and completed reads.

**Data flow**: It receives a buffer to fill. If the buffer is not empty, it waits until the socket is readable, attempts a read, retries on temporary “would block” or interruption errors, and returns the number of bytes read or an error.

**Call relations**: Generic frame-reading code calls this through Rust’s `Read` trait. It depends on `UnixDeadlineStream::wait_for_ready` to avoid blocking past the deadline.

*Call graph*: calls 1 internal fn (wait_for_ready); 1 external calls (read).


##### `UnixDeadlineStream::write`  (lines 453–466)

```
fn write(&mut self, buf: &[u8]) -> std::io::Result<usize>
```

**Purpose**: Writes bytes to the Unix socket while respecting the stream deadline. It makes sending data fit inside the same timeout model as receiving data.

**Data flow**: It receives a byte slice. If the slice is not empty, it waits until the socket is writable, tries to write, retries temporary cases, and returns how many bytes were written or an error.

**Call relations**: Generic frame-writing code calls this through Rust’s `Write` trait. It uses `UnixDeadlineStream::wait_for_ready` before each write attempt.

*Call graph*: calls 1 internal fn (wait_for_ready); 1 external calls (write).


##### `UnixDeadlineStream::flush`  (lines 468–471)

```
fn flush(&mut self) -> std::io::Result<()>
```

**Purpose**: Flushes any buffered output to the Unix socket after first making sure writing is possible before the deadline. This helps ensure a request actually leaves the process.

**Data flow**: It waits for writable readiness, then calls the underlying stream’s flush operation and returns its result.

**Call relations**: `write_frame` eventually triggers this through the `Write` trait after sending a frame.

*Call graph*: calls 1 internal fn (wait_for_ready); 1 external calls (flush).


##### `validate_unix_socket_path`  (lines 475–507)

```
fn validate_unix_socket_path(socket_path: &Path) -> std::io::Result<()>
```

**Purpose**: Checks that the Unix socket path is safe before connecting. It prevents Codex from talking to a socket in a directory or file controlled by another user.

**Data flow**: It receives a socket path, finds its parent directory, checks ownership and permissions, then checks that the target is really a socket owned by the current user. It returns success or a permission-style I/O error.

**Call relations**: `connect_unix_stream_before_deadline` calls this before opening the connection. A test calls it directly to confirm unsafe directory permissions are rejected.

*Call graph*: calls 1 internal fn (permission_denied_io_error); called by 2 (connect_unix_stream_before_deadline, validate_unix_socket_path_rejects_unsafe_parent_directory); 3 external calls (parent, getuid, symlink_metadata).


##### `validate_unix_peer_owner`  (lines 569–571)

```
fn validate_unix_peer_owner(_stream: &std::os::unix::net::UnixStream) -> std::io::Result<()>
```

**Purpose**: Checks who owns the process on the other end of the Unix socket, on platforms that support that check. This adds protection even if the socket file itself looks correct.

**Data flow**: It receives a connected Unix stream, asks the operating system for the peer user ID, and returns success only if that user matches the current user.

**Call relations**: `UnixDeadlineStream::connect` calls this after connecting and before accepting the stream as trusted. It passes the discovered user ID to `ensure_peer_uid_matches_current_user`.

*Call graph*: calls 1 internal fn (ensure_peer_uid_matches_current_user); called by 1 (connect); 4 external calls (last_os_error, getpeereid, getsockopt, as_raw_fd).


##### `ensure_peer_uid_matches_current_user`  (lines 574–582)

```
fn ensure_peer_uid_matches_current_user(peer_uid: libc::uid_t) -> std::io::Result<()>
```

**Purpose**: Verifies that a peer user ID is the same as the current user. It turns a mismatch into a permission-denied error.

**Data flow**: It receives a user ID from the connected peer, compares it with the current process’s user ID, and returns success or an error explaining that the provider is not owned by the current user.

**Call relations**: Platform-specific versions of `validate_unix_peer_owner` call this after they obtain peer credentials from the operating system.

*Call graph*: calls 1 internal fn (permission_denied_io_error); called by 1 (validate_unix_peer_owner); 1 external calls (getuid).


##### `connect_stream`  (lines 585–591)

```
fn connect_stream(
    socket_path: PathBuf,
    deadline: Instant,
) -> Result<IdeContextStream, IdeContextError>
```

**Purpose**: Opens the platform-specific stream used for IDE IPC. On Unix this means a deadline-aware Unix socket; on Windows this means a named pipe stream.

**Data flow**: It receives a path and deadline, asks the appropriate platform stream type to connect, and converts connection failures into `IdeContextError::Connect`.

**Call relations**: `fetch_ide_context_from_socket` calls this before sending the IDE request. It hides the Unix-versus-Windows difference from the rest of the request code.

*Call graph*: calls 2 internal fn (connect, connect); called by 1 (fetch_ide_context_from_socket).


##### `answer_unsupported_request`  (lines 594–608)

```
fn answer_unsupported_request(
    stream: &mut T,
    message: &Value,
) -> Result<(), IdeContextError>
```

**Purpose**: Replies to incoming requests that this TUI client does not know how to handle. This keeps the shared IPC channel polite instead of leaving the other side waiting.

**Data flow**: It receives the stream and an incoming JSON message. If the message has a request ID, it writes a JSON error response saying there is no handler for the request; otherwise it does nothing.

**Call relations**: `read_response_frame` calls this when an unrelated `request` message arrives while Codex is waiting for the IDE context response.

*Call graph*: calls 1 internal fn (write_frame); called by 1 (read_response_frame); 2 external calls (get, json!).


##### `fetch_ide_context_from_stream`  (lines 611–621)

```
fn fetch_ide_context_from_stream(
    stream: &mut IdeContextStream,
    workspace_root: &Path,
    deadline: Instant,
) -> Result<IdeContext, IdeContextError>
```

**Purpose**: Performs the request-and-response exchange over an already connected stream. It is the heart of fetching IDE context once transport is ready.

**Data flow**: It receives a mutable stream, workspace root, and deadline. It creates a unique request ID, writes the IDE context request, waits for the matching response frame, extracts the IDE context, and returns it.

**Call relations**: `fetch_ide_context_from_socket` calls this after connecting. It coordinates `write_ide_context_request`, `read_response_frame`, and `extract_ide_context`.

*Call graph*: calls 3 internal fn (extract_ide_context, read_response_frame, write_ide_context_request); called by 1 (fetch_ide_context_from_socket); 1 external calls (new_v4).


##### `write_ide_context_request`  (lines 624–640)

```
fn write_ide_context_request(
    stream: &mut T,
    request_id: &str,
    workspace_root: &Path,
) -> std::io::Result<()>
```

**Purpose**: Builds and sends the JSON request asking the IDE extension for context for a specific workspace. It labels the request as coming from the TUI client.

**Data flow**: It receives a writable stream, request ID, and workspace root. It creates a JSON object with method `ide-context`, the source client ID, protocol version, and workspace path, then writes it as a framed message.

**Call relations**: `fetch_ide_context_from_stream` calls this at the start of the exchange. It uses `write_frame` to apply the length-prefixed wire format.

*Call graph*: calls 1 internal fn (write_frame); called by 1 (fetch_ide_context_from_stream); 1 external calls (json!).


##### `write_frame`  (lines 643–659)

```
fn write_frame(stream: &mut T, message: &Value) -> std::io::Result<()>
```

**Purpose**: Sends one JSON message using this IPC protocol’s frame format. A frame is like putting a label on an envelope saying how many bytes are inside.

**Data flow**: It receives a writable stream and JSON value. It serializes the JSON to bytes, checks the length fits in four bytes, writes the little-endian length prefix, writes the payload, flushes the stream, and returns success or an I/O error.

**Call relations**: `write_ide_context_request`, `answer_unsupported_request`, `read_response_frame`, and test helpers all use this to send protocol messages consistently.

*Call graph*: called by 4 (answer_unsupported_request, read_response_frame, write_ide_context_response, write_ide_context_request); 4 external calls (flush, write_all, to_vec, try_from).


##### `read_frame`  (lines 662–677)

```
fn read_frame(
    stream: &mut T,
    deadline: Instant,
) -> Result<Value, IdeContextError>
```

**Purpose**: Reads one length-prefixed JSON message from the IPC stream. It also protects memory use by rejecting frames larger than the allowed maximum.

**Data flow**: It receives a readable stream and deadline. It reads four length bytes, converts them to a payload size, rejects oversized payloads, reads exactly that many bytes before the deadline, parses the bytes as JSON, and returns the JSON value.

**Call relations**: `read_response_frame` calls this repeatedly while waiting for the matching IDE context response.

*Call graph*: calls 1 internal fn (read_exact_before_deadline); called by 1 (read_response_frame); 3 external calls (from_slice, from_le_bytes, vec!).


##### `read_exact_before_deadline`  (lines 680–706)

```
fn read_exact_before_deadline(
    stream: &mut T,
    buf: &mut [u8],
    deadline: Instant,
) -> Result<(), IdeContextError>
```

**Purpose**: Fills a buffer from a stream while checking the overall deadline between partial reads. This avoids a hidden problem where a normal exact read can block too long.

**Data flow**: It receives a stream, a mutable byte buffer, and a deadline. It loops until the buffer is full, checking the deadline before each read, counting bytes as they arrive, and returning a read error on end-of-file or other failure.

**Call relations**: `read_frame` uses this for both the frame header and the JSON payload, so the entire frame read shares the request’s time budget.

*Call graph*: calls 1 internal fn (ensure_deadline_not_expired); called by 1 (read_frame); 3 external calls (read, new, Read).


##### `read_response_frame`  (lines 709–754)

```
fn read_response_frame(
    stream: &mut IdeContextStream,
    request_id: &str,
    deadline: Instant,
) -> Result<Value, IdeContextError>
```

**Purpose**: Waits for the response that matches the IDE context request, while dealing with other messages that may arrive on the same channel. It acts like a receptionist sorting mail until the right letter appears.

**Data flow**: It receives the stream, expected request ID, and deadline. It repeatedly reads frames, checks their `type`, returns the matching `response`, ignores broadcasts and discovery responses, answers discovery requests with “cannot handle,” rejects unknown message types, and times out if needed.

**Call relations**: `fetch_ide_context_from_stream` calls this after sending the request. It uses `read_frame` for incoming messages, `write_frame` for discovery replies, and `answer_unsupported_request` for unrelated requests.

*Call graph*: calls 4 internal fn (answer_unsupported_request, ensure_deadline_not_expired, read_frame, write_frame); called by 1 (fetch_ide_context_from_stream); 4 external calls (set_deadline, format!, json!, InvalidResponse).


##### `ensure_deadline_not_expired`  (lines 757–763)

```
fn ensure_deadline_not_expired(deadline: Instant) -> Result<(), IdeContextError>
```

**Purpose**: Checks whether the request deadline has passed. It turns an expired deadline into the same timeout error used elsewhere in this file.

**Data flow**: It receives a deadline, compares it to the current time, and returns either success or an `IdeContextError` timeout.

**Call relations**: `read_exact_before_deadline` and `read_response_frame` call this before work that might otherwise wait too long.

*Call graph*: calls 1 internal fn (timeout_error); called by 2 (read_exact_before_deadline, read_response_frame); 1 external calls (now).


##### `timeout_error`  (lines 766–768)

```
fn timeout_error() -> IdeContextError
```

**Purpose**: Builds the IDE context error used when waiting runs out of time. It packages a timeout I/O error as a read failure.

**Data flow**: It creates a timeout-style `std::io::Error` and wraps it in `IdeContextError::Read`.

**Call relations**: `ensure_deadline_not_expired` calls this whenever the deadline has already passed.

*Call graph*: calls 1 internal fn (deadline_timeout_io_error); called by 1 (ensure_deadline_not_expired); 1 external calls (Read).


##### `deadline_timeout_io_error`  (lines 771–776)

```
fn deadline_timeout_io_error() -> std::io::Error
```

**Purpose**: Creates the standard I/O timeout error message for this file. Keeping it in one helper makes timeout reporting consistent.

**Data flow**: It produces a new `std::io::Error` with kind `TimedOut` and the message “timed out waiting for IDE context.”

**Call relations**: `timeout_error` uses it for higher-level IDE errors, and `wait_for_fd_ready` uses it when Unix polling reaches the deadline.

*Call graph*: called by 2 (timeout_error, wait_for_fd_ready); 1 external calls (new).


##### `permission_denied_io_error`  (lines 779–781)

```
fn permission_denied_io_error(message: &'static str) -> std::io::Error
```

**Purpose**: Creates a permission-denied I/O error with a supplied explanation. It is used for local socket safety failures.

**Data flow**: It receives a static message string and returns a `std::io::Error` whose kind is `PermissionDenied`.

**Call relations**: `validate_unix_socket_path` and `ensure_peer_uid_matches_current_user` call this when ownership or permissions are unsafe.

*Call graph*: called by 2 (ensure_peer_uid_matches_current_user, validate_unix_socket_path); 1 external calls (new).


##### `extract_ide_context`  (lines 784–797)

```
fn extract_ide_context(response: Value) -> Result<IdeContext, IdeContextError>
```

**Purpose**: Turns a successful JSON response from the IDE extension into the strongly typed `IdeContext` used by the TUI. It also rejects responses that are missing the expected context data.

**Data flow**: It receives a JSON response, first verifies the response says success, then looks for `result.ideContext`, clones that JSON value, deserializes it into `IdeContext`, and returns either the context or an invalid-response error.

**Call relations**: `fetch_ide_context_from_stream` calls this after receiving the matching response frame. It relies on `ensure_success_response` before reading the result body.

*Call graph*: calls 1 internal fn (ensure_success_response); called by 1 (fetch_ide_context_from_stream); 2 external calls (get, from_value).


##### `ensure_success_response`  (lines 800–814)

```
fn ensure_success_response(response: &Value) -> Result<(), IdeContextError>
```

**Purpose**: Checks whether an IDE response says the request succeeded or failed. It turns protocol-level errors from the IDE extension into `IdeContextError::RequestFailed`.

**Data flow**: It receives a JSON response, reads its `resultType`, returns success for `success`, extracts the error string for `error`, and rejects anything else as an invalid response.

**Call relations**: `extract_ide_context` calls this before trying to deserialize the `ideContext` field.

*Call graph*: called by 1 (extract_ide_context); 3 external calls (get, InvalidResponse, RequestFailed).


##### `tests::test_deadline`  (lines 823–825)

```
fn test_deadline() -> Instant
```

**Purpose**: Provides a short future deadline for tests. This keeps test reads and writes from hanging indefinitely.

**Data flow**: It reads the current time, adds one second, and returns the resulting `Instant`.

**Call relations**: The IPC tests use this helper when reading frames from test sockets.

*Call graph*: 2 external calls (from_secs, now).


##### `tests::write_ide_context_response`  (lines 828–862)

```
fn write_ide_context_response(
        stream: &mut impl std::io::Write,
        request_id: &str,
        active_selection_content: &str,
    )
```

**Purpose**: Writes a realistic successful IDE context response in tests. It lets tests focus on protocol behavior without repeating a large JSON response each time.

**Data flow**: It receives a writable stream, request ID, and selected text content. It builds a success JSON response containing an active file and active selection content, writes it as a frame, and panics if writing fails.

**Call relations**: The end-to-end Unix IPC test calls this after it has observed and checked the incoming IDE context request.

*Call graph*: calls 1 internal fn (write_frame); 2 external calls (json!, panic!).


##### `tests::unix_deadline_stream_uses_remaining_deadline_for_blocking_reads`  (lines 866–880)

```
fn unix_deadline_stream_uses_remaining_deadline_for_blocking_reads()
```

**Purpose**: Tests that a `UnixDeadlineStream` read times out promptly when no data arrives. This guards against regressions where the TUI could hang while waiting for IDE context.

**Data flow**: It creates a connected Unix socket pair, wraps one side with a deadline about 50 milliseconds away, tries to read one byte, and checks that the result is a timeout and happens quickly.

**Call relations**: This test directly exercises `UnixDeadlineStream::new` and the stream’s `read` implementation.

*Call graph*: calls 1 internal fn (new); 6 external calls (from_millis, now, assert!, assert_eq!, read, pair).


##### `tests::validate_unix_socket_path_rejects_unsafe_parent_directory`  (lines 884–898)

```
fn validate_unix_socket_path_rejects_unsafe_parent_directory()
```

**Purpose**: Tests that Unix socket validation rejects a socket whose parent directory is writable by other users. This confirms the security check catches an unsafe setup.

**Data flow**: It creates a temporary directory, makes it world-writable, binds a Unix socket inside it, calls `validate_unix_socket_path`, and checks for a permission-denied error.

**Call relations**: This test covers the safety gate used by `connect_unix_stream_before_deadline` before normal Unix connections.

*Call graph*: calls 2 internal fn (validate_unix_socket_path, bind); 4 external calls (assert_eq!, from_mode, set_permissions, tempdir).


##### `tests::fetch_ide_context_uses_unregistered_request_route`  (lines 902–1008)

```
fn fetch_ide_context_uses_unregistered_request_route()
```

**Purpose**: Tests a full Unix IPC exchange, including unrelated messages arriving before the real IDE context response. It proves the client can stay focused on the matching response while answering protocol housekeeping messages correctly.

**Data flow**: It starts a temporary Unix socket server in another thread. The server reads the client’s IDE context request, verifies its fields, sends an unsupported inbound request and a discovery request, checks the client’s replies, sends a broadcast, then sends the final successful IDE context response. The test calls `fetch_ide_context_from_socket` and checks that the returned context contains the expected selected text.

**Call relations**: This is the broad integration test for the request flow. It exercises `fetch_ide_context_from_socket`, frame reading and writing, unsupported request replies, discovery replies, broadcast ignoring, and final context extraction.

*Call graph*: calls 2 internal fn (fetch_ide_context_from_socket, bind); 5 external calls (from_secs, new, assert_eq!, tempdir, spawn).
