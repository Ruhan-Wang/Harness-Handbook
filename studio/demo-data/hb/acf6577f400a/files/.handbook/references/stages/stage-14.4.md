# Sandbox policy generation and command-safety parsing helpers  `stage-14.4`

This stage is cross-cutting infrastructure that sits between policy definition and actual tool execution. It turns loosely specified confinement rules and raw command strings into concrete sandbox settings and approval signals that higher layers can trust before launching a process.

On the policy side, the legacy execpolicy files define how command arguments are described and validated: arg_matcher.rs models policy-language match patterns and cardinality, opt.rs represents command-line options in Starlark-parsed policy files, and arg_type.rs performs the concrete value checks for matched arguments. sed_command.rs adds a special-purpose validator for the tiny safe subset of sed expressions the system permits. For runtime confinement, policy_transforms.rs merges base profiles with extra requested permissions into effective sandbox policies, while seatbelt.rs renders those policies into macOS Seatbelt rules and launch arguments; linux-sandbox/build.rs ensures Linux sandbox rebuilds when the bundled bubblewrap digest changes.

On the command-analysis side, bash.rs and powershell.rs unwrap and normalize shell invocations, parse_command.rs summarizes user-facing intent, command_canonicalization.rs produces stable approval-cache keys, and the command_safety modules classify commands as safely read-only or obviously dangerous, with powershell_parser.rs supplying structured PowerShell AST data for the Windows-specific safe and dangerous heuristics.

## Files in this stage

### Legacy policy argument model
These files define the legacy execution-policy language for command arguments, options, and narrowly validated value types.

### `execpolicy-legacy/src/arg_matcher.rs`

`data_model` · `cross-cutting`

This file is primarily a data-model layer for describing how command-line arguments should be interpreted by the legacy exec policy engine. The `ArgMatcher` enum distinguishes literal tokens, opaque non-file values, readable and writable file arguments, repeated readable-file forms, positive integers, safe sed commands, and an unconstrained varargs form. Two methods provide the operational meaning of each variant: `cardinality` collapses the matcher into `ArgMatcherCardinality::{One, AtLeastOne, ZeroOrMore}`, while `arg_type` converts it into the lower-level `ArgType` used for per-value validation and file-write risk analysis. Notably, both `ReadableFiles` and `ReadableFilesOrCwd` map to `ArgType::ReadableFile`; the difference between them is cardinality, not element type.

The file also exposes `ArgMatcherCardinality::is_exact`, which returns `Some(1)` only for fixed-width matchers and `None` for vararg forms. The remaining implementations make `ArgMatcher` usable from Starlark: `AllocValue` stores it on a heap, `StarlarkValue` declares the runtime type name, and `UnpackValue` accepts either a native `ArgMatcher` object or a plain Starlark string, treating strings as `ArgMatcher::Literal`. That implicit string-to-literal conversion is an important convenience in policy definitions.

#### Function details

##### `ArgMatcher::cardinality`  (lines 51–64)

```
fn cardinality(&self) -> ArgMatcherCardinality
```

**Purpose**: Classifies each matcher variant by how many positional arguments it consumes. Fixed tokens and typed single arguments consume exactly one, while file-list and varargs forms consume variable counts.

**Data flow**: Reads `self` and matches on the enum variant. It returns `ArgMatcherCardinality::One`, `AtLeastOne`, or `ZeroOrMore` without side effects.

**Call relations**: This method is consumed by argument-resolution logic elsewhere to partition patterns into prefix, vararg, and suffix sections and to determine how many observed arguments each fixed matcher should bind.


##### `ArgMatcher::arg_type`  (lines 66–78)

```
fn arg_type(&self) -> ArgType
```

**Purpose**: Converts a matcher pattern into the concrete `ArgType` used to validate individual observed argument values. It preserves literal strings and collapses repeated-file matchers to the per-element readable-file type.

**Data flow**: Matches on `self`; for `Literal(String)` it clones the stored string into `ArgType::Literal`, and for all other variants it returns the corresponding `ArgType` enum value. It performs no mutation.

**Call relations**: Resolution code calls this after deciding which observed arguments belong to a pattern. The returned `ArgType` is then passed into `MatchedArg::new`, which validates the actual string value.

*Call graph*: 1 external calls (Literal).


##### `ArgMatcherCardinality::is_exact`  (lines 88–94)

```
fn is_exact(&self) -> Option<usize>
```

**Purpose**: Reports whether a cardinality corresponds to a fixed argument count. Only `One` is exact in this model.

**Data flow**: Reads `self` and returns `Some(1)` for `One`; `AtLeastOne` and `ZeroOrMore` both return `None` to indicate variable width.

**Call relations**: Argument partitioning and matching use this to distinguish fixed-width patterns from the single allowed vararg pattern. A `None` result is what triggers vararg handling.


##### `ArgMatcher::alloc_value`  (lines 98–100)

```
fn alloc_value(self, heap: Heap<'v>) -> Value<'v>
```

**Purpose**: Allocates an `ArgMatcher` as a Starlark heap value. This is the bridge from Rust-owned matcher data into the embedded Starlark runtime.

**Data flow**: Consumes `self` and a `Heap<'v>`, calls `heap.alloc_simple(self)`, and returns the resulting `Value<'v>`. No external state is modified beyond the heap allocation.

**Call relations**: This implementation is used implicitly by Starlark embedding code whenever an `ArgMatcher` needs to be exposed to scripts or policy evaluation.

*Call graph*: 1 external calls (alloc_simple).


##### `ArgMatcher::unpack_value_impl`  (lines 111–117)

```
fn unpack_value_impl(value: Value<'v>) -> starlark::Result<Option<Self>>
```

**Purpose**: Attempts to recover an `ArgMatcher` from a generic Starlark value, with a convenience rule that plain strings become literal matchers. This makes policy authoring less verbose.

**Data flow**: Accepts a `Value<'v>`. If it downcasts to `StarlarkStr`, it returns `Ok(Some(ArgMatcher::Literal(...)))`; otherwise it tries to downcast to an existing `ArgMatcher` and clones it, returning that optional result. Errors come from the Starlark API type.

**Call relations**: This unpacker is invoked by the Starlark runtime when Rust code requests an `ArgMatcher` parameter from script values. Its string-special case is what allows script authors to write bare string literals instead of constructing matcher objects explicitly.

*Call graph*: 1 external calls (Literal).


### `execpolicy-legacy/src/opt.rs`

`data_model` · `config load`

This file is primarily a data-model bridge between Rust and Starlark. `Opt` represents one allowed command-line option for a program spec: the literal option spelling in `opt`, metadata in `meta`, and whether the option is mandatory in `required`. `OptMeta` distinguishes a pure flag (`Flag`) from an option that consumes a value of a specific `ArgType` (`Value(ArgType)`). Display derives render these in policy/debug-friendly forms.

Beyond the plain structs, the file implements the traits needed for Starlark policy evaluation. `StarlarkValue` marks both `Opt` and `OptMeta` as first-class Starlark values. `UnpackValue` for `Opt` downcasts a generic Starlark `Value` to `Opt` and clones it out, which is how builtin functions such as `define_program` receive typed option lists from policy code. `AllocValue` allocates an `Opt` into the Starlark heap with `heap.alloc_simple(self)`. The implementation is intentionally minimal: there is no parsing logic here, only construction, name access, and runtime interop so other modules can build `ProgramSpec.allowed_options` from policy declarations.

#### Function details

##### `Opt::new`  (lines 40–46)

```
fn new(opt: String, meta: OptMeta, required: bool) -> Self
```

**Purpose**: Constructs an `Opt` from its command-line spelling, metadata, and requiredness flag.

**Data flow**: Takes ownership of `opt: String`, `meta: OptMeta`, and `required: bool`, then returns an `Opt` with those fields unchanged.

**Call relations**: Used by policy builtin functions when translating Starlark `opt(...)` and `flag(...)` declarations into Rust values stored in a `ProgramSpec`.


##### `Opt::name`  (lines 48–50)

```
fn name(&self) -> &str
```

**Purpose**: Returns the option's canonical command-line spelling as a borrowed string slice.

**Data flow**: Reads `self.opt` and returns `&str` pointing into that field without allocation or mutation.

**Call relations**: Called while building the allowed-options map so duplicate detection and key insertion use the exact option name.


##### `Opt::unpack_value_impl`  (lines 61–65)

```
fn unpack_value_impl(value: Value<'v>) -> starlark::Result<Option<Self>>
```

**Purpose**: Attempts to extract an `Opt` from a generic Starlark runtime value.

**Data flow**: Receives a `Value<'v>`, downcasts it to `&Opt` if possible, clones the underlying `Opt`, and returns `Ok(Some(opt))`; non-`Opt` values become `Ok(None)`.

**Call relations**: Used by Starlark argument unpacking when builtin policy functions accept `UnpackList<Opt>` parameters.


##### `Opt::alloc_value`  (lines 69–71)

```
fn alloc_value(self, heap: Heap<'v>) -> Value<'v>
```

**Purpose**: Allocates an `Opt` into the Starlark heap so it can be passed around inside evaluated policy code.

**Data flow**: Consumes `self`, writes it into the provided `Heap<'v>` via `alloc_simple`, and returns the resulting Starlark `Value<'v>` handle.

**Call relations**: Participates in Rust-to-Starlark value conversion for policy builtins and module setup.

*Call graph*: 1 external calls (alloc_simple).


### `execpolicy-legacy/src/arg_type.rs`

`domain_logic` · `request handling`

This file introduces `ArgType`, the normalized classification attached to each matched argument after pattern resolution. Variants distinguish exact literals, opaque non-file values, readable and writable file paths, positive integers, safe sed commands, and an `Unknown` fallback. The key behavior is `validate`, which enforces the per-type constraints used when constructing matched arguments. Literal values must exactly equal the stored string; readable and writable file arguments must be non-empty strings; positive integers must parse as `u64` and be greater than zero; and sed commands are delegated to `parse_sed_command` for bespoke safety checks. `OpaqueNonFile` and `Unknown` intentionally accept any string.

The second method, `might_write_file`, is a conservative risk classifier used by policy logic to reason about side effects. It returns `true` for `WriteableFile` and also for `Unknown`, reflecting the design choice that unknown arguments may represent writable paths and therefore should be treated cautiously. All other variants are considered non-writing. The file also marks `ArgType` as a Starlark value type, but unlike `ArgMatcher` it contains no custom unpacking logic; its main role is to carry validated semantics through the rest of the legacy exec-policy pipeline.

#### Function details

##### `ArgType::validate`  (lines 32–70)

```
fn validate(&self, value: &str) -> Result<()>
```

**Purpose**: Checks whether a concrete argument string satisfies the constraints implied by this `ArgType`. It turns semantic mismatches into structured policy errors.

**Data flow**: Reads `self` and an input `&str`. Depending on the variant, it compares against a stored literal, checks for non-empty file names, parses a positive integer, or delegates sed-command validation to `parse_sed_command`; `OpaqueNonFile` and `Unknown` accept any value. It returns `Result<()>`, producing specific `Error` variants on failure.

**Call relations**: This method is called during matched-argument construction elsewhere in the policy engine. It is the final per-value gate after argument-resolution has decided which observed string belongs to which semantic type.

*Call graph*: calls 1 internal fn (parse_sed_command); called by 2 (new, new).


##### `ArgType::might_write_file`  (lines 72–81)

```
fn might_write_file(&self) -> bool
```

**Purpose**: Conservatively reports whether an argument of this type could represent a file write. It is used for side-effect analysis rather than strict validation.

**Data flow**: Matches on `self` and returns `true` for `WriteableFile` and `Unknown`, `false` for all other variants. It has no side effects.

**Call relations**: Other policy components can call this after arguments have been typed to decide whether a command may write to the filesystem. The inclusion of `Unknown` makes the method intentionally pessimistic.


### `execpolicy-legacy/src/sed_command.rs`

`util` · `request handling`

This file contains a single conservative parser used when an argument has been classified as a sed command. Rather than attempting to understand general sed syntax, it recognizes only commands of the form `N,Mp`: a trailing literal `p`, exactly one comma separating two numeric fields, and both numeric fields parseable as `u64`. The implementation uses chained `if let`/`&&` guards to keep the accepted grammar explicit and small.

Anything outside that exact shape is rejected with `Error::SedCommandNotProvablySafe`, carrying the original command string. That includes missing `p`, extra syntax, non-numeric ranges, single-address commands, substitutions, and any other sed features. The design choice here is intentional: the function is not a general parser but a proof-oriented whitelist for a tiny safe subset, so false negatives are acceptable while false positives are avoided.

#### Function details

##### `parse_sed_command`  (lines 4–17)

```
fn parse_sed_command(sed_command: &str) -> Result<()>
```

**Purpose**: Accepts only sed print-range commands in the exact `number,numberp` format and rejects all other sed syntax.

**Data flow**: Reads `sed_command`, strips a trailing `p`, splits the remainder once on `,`, and attempts to parse both sides as `u64`. If all checks succeed it returns `Ok(())`; otherwise it returns `Err(Error::SedCommandNotProvablySafe { command: sed_command.to_string() })`.

**Call relations**: Called from argument validation logic when a policy marks an argument as a sed command, serving as the concrete whitelist check for that argument type.

*Call graph*: called by 1 (validate).


### Sandbox policy construction
These files turn higher-level sandbox permissions into concrete platform-specific confinement artifacts and build-time wiring.

### `linux-sandbox/build.rs`

`config` · `build time`

This build script exists solely to connect the compile-time `CODEX_BWRAP_SHA256` environment variable to Cargo's rebuild logic. The runtime sandbox code in `bundled_bwrap.rs` reads that value through `option_env!`, which means the compiled binary embeds whatever digest was present at build time. Without a build script, changing the environment variable would not necessarily trigger recompilation, and the embedded expected digest could become stale.

The script therefore prints a single Cargo directive, `cargo:rerun-if-env-changed=CODEX_BWRAP_SHA256`. Cargo interprets that line specially and reruns the build script whenever the variable's value changes between builds. There is no filesystem probing, code generation, or conditional logic here; the file's entire role is to keep the compile-time digest dependency explicit and reproducible.

#### Function details

##### `main`  (lines 1–3)

```
fn main()
```

**Purpose**: Emits the Cargo rebuild hint for the bundled bubblewrap SHA-256 environment variable.

**Data flow**: Reads no runtime inputs → prints `cargo:rerun-if-env-changed=CODEX_BWRAP_SHA256` to stdout for Cargo to consume.

**Call relations**: Executed by Cargo during crate build so changes to the digest environment variable invalidate the build as intended.

*Call graph*: 1 external calls (println!).


### `sandboxing/src/policy_transforms.rs`

`domain_logic` · `permission evaluation and sandbox setup`

This file concentrates the rules for reconciling `AdditionalPermissionProfile` values with existing `PermissionProfile`, `FileSystemSandboxPolicy`, and `NetworkSandboxPolicy` settings. Its first responsibility is normalization: `normalize_additional_permissions` removes empty sections, canonicalizes concrete filesystem paths while preserving symlink structure, rejects invalid glob grants unless they are deny entries, and deduplicates entries. From there, the file provides two distinct composition modes. `merge_permission_profiles` unions two additional-permission profiles, preserving any enabled network access and combining filesystem entries plus the effective glob scan depth needed by deny-glob rules. `intersect_permission_profiles` instead computes what granted permissions remain inside a requested envelope, using a restricted `FileSystemSandboxPolicy`, `ReadDenyMatcher`, path resolution against `cwd`, and explicit retention of deny entries that still constrain accepted grants.

A large part of the logic exists to deal with cwd-dependent or symbolic permission paths: special paths such as project roots, root, tmpdir, and relative glob patterns are resolved or materialized only when needed. The file also encodes subtle invariants: deny glob entries are the only legal glob additional permissions; deny entries are retained only if they actually constrain surviving readable grants; and glob scan depth is only meaningful when deny-glob entries exist, with `None` representing either no glob scanning requirement or an unbounded scan depending on context. Finally, the module derives effective runtime filesystem/network policies and decides whether a platform sandbox is still required based on network enablement, managed-network requirements, filesystem sandbox kind, and whether restricted mode still blocks full-disk writes.

#### Function details

##### `normalize_additional_permissions`  (lines 19–69)

```
fn normalize_additional_permissions(
    additional_permissions: AdditionalPermissionProfile,
) -> Result<AdditionalPermissionProfile, String>
```

**Purpose**: Normalizes an `AdditionalPermissionProfile` into a canonical, deduplicated form suitable for later policy merging. It strips empty network/filesystem sections, canonicalizes concrete paths, and rejects glob filesystem entries unless they are deny rules.

**Data flow**: It takes ownership of an `AdditionalPermissionProfile`. It reads `network` and drops it when `is_empty()` is true; for `file_system`, it iterates each `FileSystemSandboxEntry`, validates that `FileSystemPath::GlobPattern` entries only appear with `FileSystemAccessMode::Deny`, canonicalizes `FileSystemPath::Path` values via `canonicalize_preserving_symlinks` and `AbsolutePathBuf::from_absolute_path`, leaves glob and special paths unchanged, and pushes only unique normalized entries. It returns `Ok` with a rebuilt profile containing only non-empty sections, or `Err(String)` for invalid glob grants.

**Call relations**: This is an early validation/cleanup step invoked before permissions are persisted or applied. Callers such as request/response handling and write-path setup use it to ensure downstream merge/intersection logic sees canonical paths and legal glob semantics.

*Call graph*: called by 3 (write_permissions_for_paths, normalize_and_validate_additional_permissions, handle_call); 3 external calls (with_capacity, canonicalize_preserving_symlinks, matches!).


##### `merge_permission_profiles`  (lines 71–123)

```
fn merge_permission_profiles(
    base: Option<&AdditionalPermissionProfile>,
    permissions: Option<&AdditionalPermissionProfile>,
) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Computes the union of a base and an overlay `AdditionalPermissionProfile`. The result preserves any enabled network access and combines filesystem entries without duplicates while carrying forward the strongest glob-scan requirement implied by deny-glob rules.

**Data flow**: It accepts optional references to a base profile and an overriding profile. If the overlay is absent it clones the base; otherwise it inspects both `network` sections and returns `enabled: Some(true)` if either side explicitly enables network. For filesystem permissions, it either clones one side, or when both exist, builds a new `FileSystemPermissions` whose `entries` come from `merge_permission_entries` and whose `glob_scan_max_depth` comes from `merge_glob_scan_max_depth` converted back into `NonZeroUsize`. Empty merged sections are filtered out, and the final `Option<AdditionalPermissionProfile>` is omitted if fully empty.

**Call relations**: This function sits in the additive composition path used when previously granted permissions are accumulated or patch permissions are layered. It delegates entry deduplication and glob-depth reconciliation to helper functions so callers get a single merged profile without reimplementing those rules.

*Call graph*: calls 2 internal fn (merge_glob_scan_max_depth, merge_permission_entries); called by 5 (record_granted_permissions, record_granted_permissions, apply_granted_turn_permissions, effective_patch_permissions, relative_deny_glob_grants_remain_preapproved_after_materialization).


##### `intersect_permission_profiles`  (lines 125–195)

```
fn intersect_permission_profiles(
    requested: AdditionalPermissionProfile,
    granted: AdditionalPermissionProfile,
    cwd: &Path,
) -> AdditionalPermissionProfile
```

**Purpose**: Builds the subset of granted permissions that are actually allowed by a requested permission profile. It intersects both filesystem and network permissions, preserving only readable grants covered by the request and retaining deny entries that still meaningfully constrain those surviving grants.

**Data flow**: It consumes `requested` and `granted` `AdditionalPermissionProfile` values plus a `cwd`. For filesystem permissions, it converts the requested entries into a restricted `FileSystemSandboxPolicy`, constructs a `ReadDenyMatcher`, filters granted entries through `granted_file_system_entry_within_request`, materializes cwd-dependent entries, deduplicates them, then appends deny entries from both requested and granted sides only when `retain_constraining_deny_entries` determines they overlap accepted readable grants. It computes the resulting `glob_scan_max_depth` from the retained deny entries on both sides. For network, it returns enabled only when both requested and granted explicitly enable it. The function returns a new `AdditionalPermissionProfile`, omitting empty filesystem results.

**Call relations**: This is the restrictive counterpart to profile merging and is used when a granted set must be checked against a requested envelope, such as client permission responses or preapproval checks. Internally it relies on path resolution, access coverage checks, and deny-retention helpers to avoid accidentally widening permissions during intersection.

*Call graph*: called by 4 (request_permissions_response_from_client_result, normalize_request_permissions_response, permissions_are_preapproved, relative_deny_glob_grants_remain_preapproved_after_materialization).


##### `merge_glob_scan_max_depth`  (lines 197–215)

```
fn merge_glob_scan_max_depth(
    left_entries: &[FileSystemSandboxEntry],
    left_depth: Option<usize>,
    right_entries: &[FileSystemSandboxEntry],
    right_depth: Option<usize>,
) -> Option<usiz
```

**Purpose**: Combines two optional glob scan depth settings into the effective depth required by both permission sets. It only treats a depth as meaningful when the corresponding entries actually contain deny-glob rules.

**Data flow**: It receives left/right entry slices and optional numeric depths. It first converts each side into an `Option<GlobScanDepth>` using `effective_glob_scan_depth`; then it merges them so that any `Unbounded` side yields `None`, two bounded depths yield their maximum, and a single bounded side wins over a missing side. It returns `Option<usize>` representing the merged runtime depth requirement.

**Call relations**: This helper is used whenever filesystem permissions or policies are combined. Its role is to centralize the subtle interpretation of `None` versus bounded values in the presence of deny-glob entries.

*Call graph*: calls 1 internal fn (effective_glob_scan_depth); called by 2 (merge_file_system_policy_with_additional_permissions, merge_permission_profiles).


##### `effective_glob_scan_depth`  (lines 217–231)

```
fn effective_glob_scan_depth(
    entries: &[FileSystemSandboxEntry],
    depth: Option<usize>,
) -> Option<GlobScanDepth>
```

**Purpose**: Determines whether a filesystem entry list implies glob scanning at all, and if so whether that scan is bounded or unbounded. Only deny entries with `FileSystemPath::GlobPattern` activate this behavior.

**Data flow**: It reads a slice of `FileSystemSandboxEntry` plus an optional depth. It scans the entries for any deny-glob rule; if none exist it returns `None`. If one exists, it maps `Some(depth)` to `Some(GlobScanDepth::Bounded(depth))` and missing depth to `Some(GlobScanDepth::Unbounded)`.

**Call relations**: This function is only called by `merge_glob_scan_max_depth`, where it supplies the normalized per-side interpretation needed before two depth settings can be reconciled.

*Call graph*: called by 1 (merge_glob_scan_max_depth); 2 external calls (iter, Bounded).


##### `granted_file_system_entry_within_request`  (lines 239–265)

```
fn granted_file_system_entry_within_request(
    requested: &FileSystemPermissions,
    requested_policy: &FileSystemSandboxPolicy,
    requested_read_deny_matcher: Option<&ReadDenyMatcher>,
    grant
```

**Purpose**: Checks whether a single granted filesystem entry is covered by the requested filesystem permissions. It rejects non-readable grants, honors requested deny-read matchers, and compares either resolved path access or exact unresolved entry equality.

**Data flow**: It takes the requested `FileSystemPermissions`, a prebuilt restricted `FileSystemSandboxPolicy`, an optional `ReadDenyMatcher`, one granted `FileSystemSandboxEntry`, and `cwd`. It first rejects entries whose access mode cannot read. If the granted path can be resolved by `resolve_permission_path`, it asks the deny matcher whether reads are denied for that path and, if not, compares the requested policy's resolved access against the granted access via `access_covers`. If the path cannot be resolved, it falls back to scanning requested entries for an exact path match with sufficient access. It returns `bool`.

**Call relations**: This predicate is used during profile intersection to decide which granted entries survive. It delegates path interpretation to `resolve_permission_path` and access comparison to `access_covers`, because requested coverage depends on both cwd-sensitive resolution and access-mode semantics.

*Call graph*: calls 3 internal fn (resolve_access_with_cwd, access_covers, resolve_permission_path).


##### `retain_constraining_deny_entries`  (lines 267–288)

```
fn retain_constraining_deny_entries(
    source_entries: &[FileSystemSandboxEntry],
    accepted_entries: &[FileSystemSandboxEntry],
    cwd: &Path,
    output_entries: &mut Vec<FileSystemSandboxEntry
```

**Purpose**: Selectively carries deny entries into an intersected permission set only when they still constrain at least one accepted readable grant. This prevents irrelevant deny rules from cluttering the resulting profile.

**Data flow**: It accepts source deny candidates, the already accepted entries, `cwd`, and a mutable output vector. It filters `source_entries` down to deny entries, checks each with `deny_entry_constrains_accepted_grant`, materializes cwd-dependent forms with `materialize_cwd_dependent_entry`, appends unique retained entries into `output_entries`, and also collects them into a returned `Vec<FileSystemSandboxEntry>` for later glob-depth computation.

**Call relations**: This helper is called twice by `intersect_permission_profiles`, once for requested deny entries and once for granted deny entries. Its job in that flow is to preserve only semantically active deny constraints so the intersection remains both safe and minimal.

*Call graph*: calls 2 internal fn (deny_entry_constrains_accepted_grant, materialize_cwd_dependent_entry); 2 external calls (new, iter).


##### `deny_entry_constrains_accepted_grant`  (lines 290–312)

```
fn deny_entry_constrains_accepted_grant(
    deny_entry: &FileSystemSandboxEntry,
    accepted_entries: &[FileSystemSandboxEntry],
    cwd: &Path,
) -> bool
```

**Purpose**: Determines whether a deny entry overlaps any accepted readable grant closely enough to matter. It treats glob denies by their static path prefix and concrete/special denies by their resolved path.

**Data flow**: It takes one deny entry, the accepted entries, and `cwd`. It iterates accepted entries that can read, resolves each grant path, and then compares the deny side: for `GlobPattern`, it computes a static prefix with `glob_static_prefix_path` and checks overlap; for `Path` or `Special`, it resolves the deny path with `resolve_permission_path` and checks overlap. It returns `true` if any accepted readable grant overlaps.

**Call relations**: This predicate is used exclusively by `retain_constraining_deny_entries`. In the intersection pipeline it is the gate that decides whether a deny rule survives because it still narrows one of the accepted grants.

*Call graph*: called by 1 (retain_constraining_deny_entries); 1 external calls (iter).


##### `glob_static_prefix_path`  (lines 314–333)

```
fn glob_static_prefix_path(pattern: &str, cwd: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Extracts the non-wildcard absolute directory prefix from a glob pattern, resolved against the current working directory. This gives the code a conservative concrete path for overlap checks without expanding the glob.

**Data flow**: It takes a glob pattern string and `cwd`, resolves the pattern against `cwd` with `AbsolutePathBuf::resolve_path_against_base`, converts it to a lossy string, finds the first wildcard metacharacter, and then chooses either the full path, the prefix directory, or `None` if the pattern begins with a wildcard. It returns `Option<AbsolutePathBuf>` after validating the prefix as absolute.

**Call relations**: This helper is used by `deny_entry_constrains_accepted_grant` when a deny rule is a glob. It exists because overlap checks need a concrete path anchor even though glob patterns themselves cannot be fully resolved.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); 1 external calls (new).


##### `paths_overlap`  (lines 335–337)

```
fn paths_overlap(left: &Path, right: &Path) -> bool
```

**Purpose**: Tests whether two filesystem paths are in an ancestor/descendant relationship. It is a simple overlap notion used for permission containment checks.

**Data flow**: It takes two `&Path` values and returns `true` if either starts with the other using `starts_with`, otherwise `false`.

**Call relations**: This small helper supports deny/grant overlap detection in the intersection logic. It is intentionally narrow: callers use it only after resolving or approximating permission paths.

*Call graph*: 1 external calls (starts_with).


##### `access_covers`  (lines 339–345)

```
fn access_covers(requested: FileSystemAccessMode, granted: FileSystemAccessMode) -> bool
```

**Purpose**: Checks whether a requested access mode is sufficient to cover a granted access mode. Read grants require readable requested access, write grants require writable requested access, and deny grants are never considered covered.

**Data flow**: It takes `requested` and `granted` `FileSystemAccessMode` values. It matches on the granted mode and calls `can_read` or `can_write` on the requested mode as appropriate, returning a boolean.

**Call relations**: This helper is used by `granted_file_system_entry_within_request` to compare requested coverage against each granted entry. It isolates the access-mode semantics from the surrounding path-resolution logic.

*Call graph*: calls 2 internal fn (can_read, can_write); called by 1 (granted_file_system_entry_within_request).


##### `materialize_cwd_dependent_entry`  (lines 347–370)

```
fn materialize_cwd_dependent_entry(
    entry: &FileSystemSandboxEntry,
    cwd: &Path,
) -> FileSystemSandboxEntry
```

**Purpose**: Converts cwd-dependent permission entries into concrete forms where possible so later comparisons and persisted results are stable. It resolves project-root special paths to concrete paths and rewrites relative glob patterns against `cwd`.

**Data flow**: It takes a `FileSystemSandboxEntry` reference and `cwd`. For `Special::ProjectRoots`, it tries `resolve_permission_path` and, if successful, returns a new `FileSystemSandboxEntry` with `FileSystemPath::Path`; for `GlobPattern`, it rewrites the pattern string to an absolute pattern using `resolve_path_against_base`; for ordinary `Path` and other `Special` variants it clones the original entry. It returns the transformed entry.

**Call relations**: This helper is used while intersecting permissions and retaining deny entries so the resulting profile contains concrete, cwd-stable entries whenever possible. It depends on `resolve_permission_path` for special-path resolution.

*Call graph*: calls 2 internal fn (resolve_permission_path, resolve_path_against_base); called by 1 (retain_constraining_deny_entries); 1 external calls (clone).


##### `resolve_permission_path`  (lines 372–404)

```
fn resolve_permission_path(path: &FileSystemPath, cwd: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a `FileSystemPath` into an absolute concrete path when that path kind has a cwd- or environment-dependent meaning. It is the central interpreter for special filesystem permission path variants.

**Data flow**: It takes a `FileSystemPath` and `cwd`. `Path` returns its contained `AbsolutePathBuf`; `GlobPattern` returns `None`; `Special::Root` resolves to the filesystem root by taking the last ancestor of `cwd`; `Special::ProjectRoots` resolves either to `cwd` or a subpath under it; `Special::Tmpdir` reads `TMPDIR` from the environment and validates it as absolute and non-empty; `Special::SlashTmp` returns `/tmp` only if it exists as a directory; `Minimal` and `Unknown` return `None`. The result is `Option<AbsolutePathBuf>`.

**Call relations**: This function underpins several higher-level checks: request/grant containment, cwd-dependent entry materialization, and deny overlap detection. Callers use it whenever they need a concrete path rather than a symbolic permission path.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); called by 2 (granted_file_system_entry_within_request, materialize_cwd_dependent_entry); 5 external calls (ancestors, as_path, from, clone, var_os).


##### `merge_permission_entries`  (lines 406–417)

```
fn merge_permission_entries(
    base: &[FileSystemSandboxEntry],
    permissions: &[FileSystemSandboxEntry],
) -> Vec<FileSystemSandboxEntry>
```

**Purpose**: Produces a deduplicated concatenation of two filesystem permission entry lists while preserving first-seen order. It is the low-level union operation for filesystem entries.

**Data flow**: It takes slices of base and overlay `FileSystemSandboxEntry` values, allocates a vector sized for both, iterates the concatenated sequence, clones each entry not already present, and returns the merged vector.

**Call relations**: This helper is called by `merge_permission_profiles` when both profiles contain filesystem permissions. It isolates the entry-level union behavior from the surrounding profile merge logic.

*Call graph*: called by 1 (merge_permission_profiles); 3 external calls (with_capacity, iter, len).


##### `merge_file_system_policy_with_additional_permissions`  (lines 419–443)

```
fn merge_file_system_policy_with_additional_permissions(
    file_system_policy: &FileSystemSandboxPolicy,
    additional_permissions: &FileSystemPermissions,
) -> FileSystemSandboxPolicy
```

**Purpose**: Adds additional filesystem permissions into an existing runtime filesystem sandbox policy when that policy is restricted. Unrestricted and externally sandboxed policies are left unchanged.

**Data flow**: It takes a `FileSystemSandboxPolicy` and `FileSystemPermissions`. If the policy kind is `Restricted`, it clones the policy, appends any missing additional entries, recomputes `glob_scan_max_depth` with `merge_glob_scan_max_depth`, and returns the merged policy. For `Unrestricted` and `ExternalSandbox`, it simply clones and returns the original policy.

**Call relations**: This helper is the implementation detail behind `effective_file_system_sandbox_policy`. It is only used when deriving the runtime filesystem policy from a base policy plus optional additional permissions.

*Call graph*: calls 1 internal fn (merge_glob_scan_max_depth); called by 1 (effective_file_system_sandbox_policy); 1 external calls (clone).


##### `effective_file_system_sandbox_policy`  (lines 445–464)

```
fn effective_file_system_sandbox_policy(
    file_system_policy: &FileSystemSandboxPolicy,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> FileSystemSandboxPolicy
```

**Purpose**: Computes the runtime filesystem sandbox policy after applying optional additional permissions. It short-circuits when no additional filesystem permissions are present or when they are empty.

**Data flow**: It takes a base `FileSystemSandboxPolicy` and an optional `AdditionalPermissionProfile`. If the profile is absent, lacks `file_system`, or contains an empty filesystem section, it clones and returns the original policy. Otherwise it passes the base policy and additional filesystem permissions to `merge_file_system_policy_with_additional_permissions` and returns that result.

**Call relations**: This function is called by sandbox-context builders and by `effective_permission_profile`. In the call flow it is the public filesystem-policy derivation step that hides the restricted-vs-unrestricted merge rules.

*Call graph*: calls 1 internal fn (merge_file_system_policy_with_additional_permissions); called by 5 (file_system_sandbox_context, effective_patch_permissions, file_system_sandbox_context_uses_active_attempt, file_system_sandboxed_write_allows_additional_write_root, effective_permission_profile); 1 external calls (clone).


##### `merge_network_access`  (lines 466–476)

```
fn merge_network_access(
    base_network_access: bool,
    additional_permissions: &AdditionalPermissionProfile,
) -> bool
```

**Purpose**: Combines a base network-enabled flag with additional permissions to determine whether network access should be considered enabled. Additional permissions only widen access when they explicitly set `enabled` to `true`.

**Data flow**: It takes a boolean `base_network_access` and an `AdditionalPermissionProfile`. It reads `additional_permissions.network.enabled`, defaults missing values to `false`, ORs that with the base flag, and returns the resulting boolean.

**Call relations**: This is a small helper used by `effective_network_sandbox_policy` to keep the network-enablement rule in one place.


##### `effective_network_sandbox_policy`  (lines 478–491)

```
fn effective_network_sandbox_policy(
    network_policy: NetworkSandboxPolicy,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> NetworkSandboxPolicy
```

**Purpose**: Derives the runtime network sandbox policy from a base policy plus optional additional permissions. Additional permissions can force `Enabled`; otherwise, if additional permissions are present but do not enable network, the result becomes `Restricted` rather than preserving the original policy.

**Data flow**: It takes a `NetworkSandboxPolicy` and an optional `AdditionalPermissionProfile`. If additional permissions exist and `merge_network_access(network_policy.is_enabled(), permissions)` is true, it returns `NetworkSandboxPolicy::Enabled`. If additional permissions exist but do not enable network, it returns `NetworkSandboxPolicy::Restricted`. If no additional permissions are supplied, it returns the original policy unchanged.

**Call relations**: This function is used alongside filesystem policy derivation in sandbox-context creation and `effective_permission_profile`. Its role is to convert the base-plus-additional network state into the concrete runtime enum used by the sandbox layer.

*Call graph*: called by 4 (file_system_sandbox_context, file_system_sandbox_context_uses_active_attempt, file_system_sandboxed_write_allows_additional_write_root, effective_permission_profile).


##### `effective_permission_profile`  (lines 493–507)

```
fn effective_permission_profile(
    permission_profile: &PermissionProfile,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> PermissionProfile
```

**Purpose**: Builds a full `PermissionProfile` reflecting the effective runtime filesystem and network policies after applying optional additional permissions. It preserves the original enforcement mode while replacing the runtime permission components.

**Data flow**: It takes a `PermissionProfile` and optional additional permissions. It extracts the current runtime filesystem and network policies with `to_runtime_permissions`, computes updated versions via `effective_file_system_sandbox_policy` and `effective_network_sandbox_policy`, reads the original enforcement mode with `enforcement`, and reconstructs a new `PermissionProfile` using `from_runtime_permissions_with_enforcement`.

**Call relations**: This is the top-level profile transformation used by callers that need a complete permission profile object rather than separate filesystem/network policies. It orchestrates the two effective-policy helpers and rewraps their results into the protocol-level profile type.

*Call graph*: calls 5 internal fn (enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions, effective_file_system_sandbox_policy, effective_network_sandbox_policy); called by 3 (file_system_sandbox_context_for_attempt, preapproved_additional_permissions_escalate_intercepted_exec, transform).


##### `should_require_platform_sandbox`  (lines 509–529)

```
fn should_require_platform_sandbox(
    file_system_policy: &FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    has_managed_network_requirements: bool,
) -> bool
```

**Purpose**: Decides whether an additional platform sandbox mechanism is still necessary given the effective filesystem and network policies. The decision is conservative when managed network requirements exist or when the current policy still leaves meaningful restrictions to enforce.

**Data flow**: It takes a `FileSystemSandboxPolicy`, a `NetworkSandboxPolicy`, and a `has_managed_network_requirements` flag. It immediately returns `true` if managed network requirements are present. Otherwise, if network is not enabled, it requires a platform sandbox unless the filesystem policy kind is `ExternalSandbox`. If network is enabled, it requires a platform sandbox only for `Restricted` filesystem policies that do not already have full disk write access; unrestricted and external-sandbox kinds return `false`.

**Call relations**: This function is consulted by higher-level sandbox selection and warning logic after effective policies have been computed. It does not transform permissions itself; instead it interprets the resulting policy combination to decide whether OS-level sandboxing must still be engaged.

*Call graph*: calls 2 internal fn (has_full_disk_write_access, is_enabled); called by 3 (permission_profile_sandbox_tag, should_warn_about_system_bwrap, select_initial); 1 external calls (matches!).


### `sandboxing/src/seatbelt.rs`

`domain_logic` · `sandbox setup before spawning a macOS sandboxed child process`

This file is the macOS-specific policy compiler for sandboxed process execution. It starts from `FileSystemSandboxPolicy`, `NetworkSandboxPolicy`, optional `NetworkProxy` configuration, and a target command, then emits the full `sandbox-exec` argument vector: `-p <policy>`, zero or more `-DKEY=VALUE` parameter definitions, `--`, and the original command. The generated policy is assembled from embedded base/network/defaults SBPL fragments plus dynamically synthesized read, write, deny, and network clauses.

Filesystem policy generation is centered on `SeatbeltAccessRoot`, which models an allowed root together with excluded subpaths and protected metadata names. `build_seatbelt_access_policy` turns those into `(allow file-read*)` or `(allow file-write*)` forms using `subpath`, `literal`, `require-not`, and regex guards. A notable detail is that protected metadata names are denied by regex under writable roots when the higher-level policy would not permit writing those metadata paths. Unreadable glob patterns are separately converted into anchored Seatbelt regex deny rules for both reads and unlink-style writes, because Seatbelt cannot consume the original glob syntax directly.

Network policy generation is intentionally fail-closed around managed proxies. The code extracts loopback proxy ports from proxy environment variables, distinguishes between “proxy configured” and “proxy endpoints successfully inferred,” and only grants broad network access when the sandbox policy explicitly enables networking and no proxy enforcement is active. Unix domain socket access is modeled separately with either `AllowAll` or a normalized allowlist of absolute paths; restricted mode emits parameterized `subpath` rules so sockets created beneath approved directories remain usable. Path normalization consistently rejects relative paths and prefers canonicalized absolute paths when available, reducing accidental policy widening and duplicate entries.

#### Function details

##### `is_loopback_host`  (lines 31–33)

```
fn is_loopback_host(host: &str) -> bool
```

**Purpose**: Checks whether a hostname should be treated as loopback for proxy allowance purposes. It recognizes `localhost`, `127.0.0.1`, and `::1` only.

**Data flow**: Takes a `&str` host name, compares it against the accepted loopback spellings using ASCII-insensitive matching for `localhost`, and returns a `bool`. It reads no external state and writes nothing.

**Call relations**: This is a small predicate used during proxy environment parsing. `proxy_loopback_ports_from_env` invokes it after URL parsing to decide whether a proxy endpoint should contribute an allowed outbound localhost port.

*Call graph*: called by 1 (proxy_loopback_ports_from_env).


##### `proxy_scheme_default_port`  (lines 35–41)

```
fn proxy_scheme_default_port(scheme: &str) -> u16
```

**Purpose**: Supplies the implicit port number for proxy URLs that omit an explicit port. It maps HTTPS to 443, SOCKS variants to 1080, and everything else to 80.

**Data flow**: Consumes a URL scheme string and returns a `u16` default port chosen by a `match`. It has no side effects or external dependencies.

**Call relations**: This helper supports proxy URL interpretation inside `proxy_loopback_ports_from_env`, where parsed URLs without a port still need a concrete localhost port for Seatbelt rules.


##### `proxy_loopback_ports_from_env`  (lines 43–76)

```
fn proxy_loopback_ports_from_env(env: &HashMap<String, String>) -> Vec<u16>
```

**Purpose**: Scans proxy-related environment variables and extracts the set of loopback proxy ports that should be reachable from inside the sandbox. It tolerates missing schemes, malformed URLs, empty values, and non-loopback hosts by skipping them.

**Data flow**: Reads a `HashMap<String, String>` environment, iterates over `PROXY_URL_ENV_KEYS`, fetches each value via `proxy_url_env_value`, trims it, prepends `http://` when no scheme is present, parses it as a `Url`, filters to loopback hosts via `is_loopback_host`, resolves an explicit or default port via `proxy_scheme_default_port`, deduplicates ports in a `BTreeSet`, and returns them as a sorted `Vec<u16>`. It does not mutate caller state.

**Call relations**: Called by `proxy_policy_inputs` when a `NetworkProxy` is present. Its output directly drives the per-port `(allow network-outbound (remote ip "localhost:PORT"))` rules emitted later by `dynamic_network_policy_for_network`.

*Call graph*: calls 1 internal fn (is_loopback_host); called by 1 (proxy_policy_inputs); 4 external calls (new, parse, proxy_url_env_value, format!).


##### `UnixDomainSocketPolicy::default`  (lines 94–96)

```
fn default() -> Self
```

**Purpose**: Defines the safe default unix-socket policy as restricted mode with an empty allowlist. This avoids silently granting unix socket access when no explicit configuration exists.

**Data flow**: Constructs and returns `UnixDomainSocketPolicy::Restricted { allowed: vec![] }`. It reads no state and performs no I/O.

**Call relations**: Used indirectly through `ProxyPolicyInputs` defaulting and in the no-network branch of `proxy_policy_inputs`, ensuring the rest of the policy builder can assume a concrete unix-socket mode.

*Call graph*: 1 external calls (vec!).


##### `proxy_policy_inputs`  (lines 105–153)

```
fn proxy_policy_inputs(
    network: Option<&NetworkProxy>,
    extra_allow_unix_sockets: &[AbsolutePathBuf],
) -> ProxyPolicyInputs
```

**Purpose**: Normalizes all proxy- and unix-socket-related inputs into a single `ProxyPolicyInputs` struct consumed by network policy generation. It merges explicit network proxy settings with extra unix socket allowances supplied by the caller.

**Data flow**: Accepts `Option<&NetworkProxy>` and a slice of `AbsolutePathBuf` extra socket paths. It first normalizes extra socket paths with `normalize_path_for_sandbox`. If a `NetworkProxy` exists, it materializes proxy env vars into a temporary `HashMap` via `apply_to_env`, computes loopback ports with `proxy_loopback_ports_from_env`, detects whether any proxy env vars are configured with `has_proxy_url_env_vars`, reads `allow_local_binding`, and builds either `UnixDomainSocketPolicy::AllowAll` or a restricted allowlist from `network.allow_unix_sockets()` plus extras, warning on entries that cannot be normalized. Without a proxy, it returns defaults except for a restricted unix-socket allowlist containing only the normalized extras.

**Call relations**: This is the bridge between external network configuration and Seatbelt-specific policy synthesis. `create_seatbelt_command_args` calls it once, then passes the resulting struct to both `dynamic_network_policy_for_network` and `unix_socket_dir_params`.

*Call graph*: calls 1 internal fn (proxy_loopback_ports_from_env); called by 1 (create_seatbelt_command_args); 4 external calls (default, new, has_proxy_url_env_vars, iter).


##### `normalize_path_for_sandbox`  (lines 155–169)

```
fn normalize_path_for_sandbox(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Validates and normalizes a filesystem path before embedding it into Seatbelt parameters. It rejects relative paths outright and prefers canonicalized absolute paths when canonicalization succeeds.

**Data flow**: Takes a `&Path`, returns `None` if `is_absolute` is false, otherwise constructs an `AbsolutePathBuf` with `from_absolute_path`. It then attempts `canonicalize` and converts the canonical path back into `AbsolutePathBuf`; if canonicalization fails, it falls back to the original absolute path. The result is `Option<AbsolutePathBuf>` with no side effects.

**Call relations**: Used wherever path-based policy inputs are accepted from higher layers: `proxy_policy_inputs` for unix sockets, `build_seatbelt_access_policy` for allowed and excluded roots, and `canonicalize_glob_static_prefix_for_sandbox` for unreadable glob normalization.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (build_seatbelt_access_policy, canonicalize_glob_static_prefix_for_sandbox); 1 external calls (is_absolute).


##### `unix_socket_path_params`  (lines 171–187)

```
fn unix_socket_path_params(proxy: &ProxyPolicyInputs) -> Vec<UnixSocketPathParam>
```

**Purpose**: Converts the restricted unix-socket allowlist into a stable, deduplicated sequence of indexed parameter records. Allow-all mode intentionally produces no path parameters because the policy does not need path qualifiers.

**Data flow**: Reads `ProxyPolicyInputs`. If `unix_domain_socket_policy` is `AllowAll`, it returns an empty `Vec`. Otherwise it inserts each allowed `AbsolutePathBuf` into a `BTreeMap<String, AbsolutePathBuf>` keyed by lossy string form to deduplicate and sort deterministically, then enumerates the values into `UnixSocketPathParam { index, path }` records.

**Call relations**: This helper feeds both parameter definition generation and SBPL rule generation. `unix_socket_dir_params` uses it to build `-D` arguments, while `unix_socket_policy` uses the same indexed paths to reference those parameters in `subpath` clauses.

*Call graph*: called by 2 (unix_socket_dir_params, unix_socket_policy); 2 external calls (new, vec!).


##### `unix_socket_path_param_key`  (lines 189–191)

```
fn unix_socket_path_param_key(index: usize) -> String
```

**Purpose**: Formats the Seatbelt parameter name used for a unix-socket allowlist entry. The names are `UNIX_SOCKET_PATH_<index>`.

**Data flow**: Consumes a `usize` index and returns a `String` built with `format!`. It has no side effects.

**Call relations**: Called from both `unix_socket_policy` and the surrounding parameter-generation path so the SBPL references and `-D` definitions stay in sync.

*Call graph*: called by 1 (unix_socket_policy); 1 external calls (format!).


##### `unix_socket_dir_params`  (lines 193–203)

```
fn unix_socket_dir_params(proxy: &ProxyPolicyInputs) -> Vec<(String, PathBuf)>
```

**Purpose**: Builds the concrete `-DKEY=VALUE` parameter bindings for restricted unix-socket paths. Each allowed path becomes one named parameter pointing at its directory path.

**Data flow**: Reads `ProxyPolicyInputs`, obtains indexed path records from `unix_socket_path_params`, maps each to `(String, PathBuf)` using `unix_socket_path_param_key` and `into_path_buf`, and returns the resulting vector. It does not mutate external state.

**Call relations**: Invoked by `create_seatbelt_command_args` when assembling all Seatbelt parameter definitions. Its output must correspond exactly to the parameter names referenced by `unix_socket_policy`.

*Call graph*: calls 1 internal fn (unix_socket_path_params); called by 1 (create_seatbelt_command_args).


##### `unix_socket_policy`  (lines 208–242)

```
fn unix_socket_policy(proxy: &ProxyPolicyInputs) -> String
```

**Purpose**: Generates the SBPL lines that permit unix domain socket use for local IPC. It emits either broad AF_UNIX/network rules for allow-all mode or parameterized `subpath` rules for each approved socket directory.

**Data flow**: Consumes `&ProxyPolicyInputs`, derives indexed socket params with `unix_socket_path_params`, checks whether any unix-socket access exists, and returns either an empty `String` or a newline-terminated policy block. In allow-all mode it emits generic `system-socket`, `network-bind`, and `network-outbound` unix-socket rules; in restricted mode it emits one bind and one outbound rule per parameter key from `unix_socket_path_param_key`.

**Call relations**: This function is called only from `dynamic_network_policy_for_network`, which splices its output into the broader network policy when unix-socket access should coexist with disabled or restricted IP networking.

*Call graph*: calls 2 internal fn (unix_socket_path_param_key, unix_socket_path_params); called by 1 (dynamic_network_policy_for_network); 3 external calls (new, format!, matches!).


##### `dynamic_network_policy`  (lines 245–255)

```
fn dynamic_network_policy(
    sandbox_policy: &SandboxPolicy,
    enforce_managed_network: bool,
    proxy: &ProxyPolicyInputs,
) -> String
```

**Purpose**: Adapts a full `SandboxPolicy` into the narrower network-policy builder used by this file. It exists mainly as a compatibility wrapper around `dynamic_network_policy_for_network`.

**Data flow**: Accepts `&SandboxPolicy`, `bool` enforcement flag, and `&ProxyPolicyInputs`; converts the sandbox policy into `NetworkSandboxPolicy` with `from`, forwards all inputs to `dynamic_network_policy_for_network`, and returns the resulting policy string.

**Call relations**: This wrapper is retained for dead-code-tolerant/test use. The main production path calls `dynamic_network_policy_for_network` directly from `create_seatbelt_command_args` after it already has a `NetworkSandboxPolicy`.

*Call graph*: calls 2 internal fn (from, dynamic_network_policy_for_network).


##### `dynamic_network_policy_for_network`  (lines 257–319)

```
fn dynamic_network_policy_for_network(
    network_policy: NetworkSandboxPolicy,
    enforce_managed_network: bool,
    proxy: &ProxyPolicyInputs,
) -> String
```

**Purpose**: Synthesizes the complete dynamic network section of the Seatbelt policy from network enablement, managed-network enforcement, proxy-derived localhost ports, local-binding permission, and unix-socket allowances. Its key design choice is to fail closed when proxy enforcement is expected but no usable proxy endpoints can be inferred.

**Data flow**: Takes a `NetworkSandboxPolicy`, `bool` `enforce_managed_network`, and `&ProxyPolicyInputs`. It first determines whether any unix-socket access exists, then decides whether to use a restricted policy based on proxy ports, proxy config presence, managed-network enforcement, or the special case of disabled IP networking plus unix-socket access. In restricted mode it conditionally appends localhost bind/inbound/outbound rules, optional DNS egress on port 53 when local binding and proxy ports coexist, one localhost outbound rule per proxy port, and any unix-socket rules from `unix_socket_policy`, then appends the embedded network SBPL fragment. Outside restricted mode it returns an empty string for fail-closed proxy/enforcement cases, broad inbound/outbound rules plus unix-socket rules when networking is enabled, or an empty string when networking is disabled.

**Call relations**: This is the central network-policy decision point. `create_seatbelt_command_args` calls it during final policy assembly, and `dynamic_network_policy` delegates to it for legacy/test callers.

*Call graph*: calls 2 internal fn (is_enabled, unix_socket_policy); called by 2 (create_seatbelt_command_args, dynamic_network_policy); 3 external calls (from, new, format!).


##### `root_absolute_path`  (lines 321–326)

```
fn root_absolute_path() -> AbsolutePathBuf
```

**Purpose**: Constructs the absolute path object representing `/`. It panics if that invariant somehow fails.

**Data flow**: Calls `AbsolutePathBuf::from_absolute_path` on `Path::new("/")`; on success returns the `AbsolutePathBuf`, on error panics with a descriptive message. It has no external side effects beyond the panic path.

**Call relations**: Used by `create_seatbelt_command_args` when full-disk read or write access must be represented as a single root with optional excluded unreadable subpaths.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (new, panic!).


##### `build_seatbelt_access_policy`  (lines 335–390)

```
fn build_seatbelt_access_policy(
    action: &str,
    param_prefix: &str,
    roots: Vec<SeatbeltAccessRoot>,
) -> (String, Vec<(String, PathBuf)>)
```

**Purpose**: Builds parameterized Seatbelt allow rules for filesystem reads or writes over one or more roots, with optional excluded subpaths and protected metadata-name exclusions. It is the core translator from structured filesystem access roots into SBPL expressions and matching `-D` parameter bindings.

**Data flow**: Accepts an action string like `file-read*` or `file-write*`, a parameter-name prefix, and a `Vec<SeatbeltAccessRoot>`. For each root it normalizes the root path, allocates a root parameter name, and records `(param, PathBuf)` in the returned params vector. If there are no exclusions or protected metadata names, it emits a simple `(subpath (param ...))` component. Otherwise it builds a `(require-all ...)` expression containing the root subpath plus `require-not` clauses for each excluded path's exact literal and subtree, and regex-based `require-not` clauses for each protected metadata name using `seatbelt_protected_metadata_name_regex`. It returns either an empty policy with no params or a complete `(allow ACTION ... )` string plus all parameter bindings.

**Call relations**: This function is called repeatedly by `create_seatbelt_command_args` to generate read and write policy sections for full-disk and allowlisted modes. It relies on `normalize_path_for_sandbox` and `seatbelt_protected_metadata_name_regex` to keep path handling and metadata exclusions precise.

*Call graph*: calls 2 internal fn (normalize_path_for_sandbox, seatbelt_protected_metadata_name_regex); called by 1 (create_seatbelt_command_args); 4 external calls (new, new, format!, vec!).


##### `seatbelt_protected_metadata_name_regex`  (lines 392–404)

```
fn seatbelt_protected_metadata_name_regex(root: &AbsolutePathBuf, name: &str) -> String
```

**Purpose**: Creates an anchored regex that matches a protected metadata path name directly under a given root and anything beneath it. It handles the root directory `/` as a special case so the resulting pattern is syntactically correct.

**Data flow**: Consumes an `&AbsolutePathBuf` root and `&str` metadata name, trims trailing slashes from the root except when it is exactly `/`, escapes both pieces with `regex_lite::escape`, and returns a regex string of the form `^/name(/.*)?$` or `^<root>/name(/.*)?$`.

**Call relations**: Used only by `build_seatbelt_access_policy` when writable roots need metadata-name exclusions expressed as regex-based `require-not` clauses.

*Call graph*: calls 1 internal fn (to_string_lossy); called by 1 (build_seatbelt_access_policy); 5 external calls (format!, escape, ends_with, len, pop).


##### `protected_metadata_names_for_writable_root`  (lines 406–422)

```
fn protected_metadata_names_for_writable_root(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    writable_root: &WritableRoot,
    cwd: &Path,
) -> Vec<String>
```

**Purpose**: Determines which metadata names under a writable root must still be protected from writes. It merges explicit per-root protected names with globally protected metadata names that the higher-level filesystem policy would not allow writing.

**Data flow**: Takes a `&FileSystemSandboxPolicy`, `&WritableRoot`, and current working directory `&Path`. It clones `writable_root.protected_metadata_names`, then iterates `PROTECTED_METADATA_PATH_NAMES`; for each missing name it joins that name onto the writable root path and asks `can_write_path_with_cwd` whether the policy permits writing it. Names that remain unwritable are appended, and the final `Vec<String>` is returned.

**Call relations**: This helper is used during writable-root translation inside `create_seatbelt_command_args`, ensuring write-allowed roots do not accidentally permit writes to metadata paths that the higher-level policy still intends to protect.

*Call graph*: calls 1 internal fn (can_write_path_with_cwd).


##### `build_seatbelt_unreadable_glob_policy`  (lines 424–456)

```
fn build_seatbelt_unreadable_glob_policy(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
) -> String
```

**Purpose**: Converts unreadable glob patterns from the filesystem sandbox policy into explicit Seatbelt deny rules. It denies both reads and unlink-style writes so forbidden paths cannot be probed or removed despite broader allow rules.

**Data flow**: Reads unreadable glob strings from `file_system_sandbox_policy.get_unreadable_globs_with_cwd(cwd)`. If none exist, it returns an empty string. Otherwise, for each pattern it computes one regex from the original pattern via `seatbelt_regex_for_unreadable_glob` and optionally a second regex from a canonicalized static-prefix variant via `canonicalize_glob_static_prefix_for_sandbox`; duplicates are removed with a `BTreeSet`. Each regex is escaped for embedded quotes and expanded into `(deny file-read* ...)` and `(deny file-write-unlink ...)` lines, which are joined with newlines and returned.

**Call relations**: Called by `create_seatbelt_command_args` after allow rules are built. It complements the allowlist-based read/write policy by re-imposing explicit denials for glob-based unreadable paths that Seatbelt cannot represent natively.

*Call graph*: calls 3 internal fn (get_unreadable_globs_with_cwd, canonicalize_glob_static_prefix_for_sandbox, seatbelt_regex_for_unreadable_glob); called by 1 (create_seatbelt_command_args); 4 external calls (new, new, new, format!).


##### `canonicalize_glob_static_prefix_for_sandbox`  (lines 458–482)

```
fn canonicalize_glob_static_prefix_for_sandbox(pattern: &str) -> Option<String>
```

**Purpose**: Attempts to normalize the non-glob prefix of a glob pattern so equivalent paths resolve consistently in Seatbelt regex generation. This improves matching when the original pattern contains symlinked or non-canonical absolute prefixes.

**Data flow**: Accepts a glob pattern `&str`. It finds the first glob metacharacter among `*`, `?`, `[`, or `]`. If none exist, it normalizes the whole path with `normalize_path_for_sandbox` and returns its string form. Otherwise it isolates the static prefix up to the containing directory boundary, normalizes that prefix, appends the untouched suffix, and returns `Some(normalized_pattern)` only when the normalized result differs from the original; if no usable absolute prefix exists, it returns `None`.

**Call relations**: Used only by `build_seatbelt_unreadable_glob_policy` as a second-chance normalization step before converting unreadable globs into regexes.

*Call graph*: calls 1 internal fn (normalize_path_for_sandbox); called by 1 (build_seatbelt_unreadable_glob_policy); 2 external calls (new, format!).


##### `seatbelt_regex_for_unreadable_glob`  (lines 484–566)

```
fn seatbelt_regex_for_unreadable_glob(pattern: &str) -> Option<String>
```

**Purpose**: Translates the supported unreadable-glob syntax into an anchored regex suitable for Seatbelt deny rules. It preserves path-component semantics for `*` and `?`, supports `**/` for recursive directory matching, and treats non-glob patterns as exact path plus subtree matches.

**Data flow**: Consumes a pattern string and returns `None` for empty input. Otherwise it walks the pattern character-by-character using a `VecDeque<char>`, building a regex string starting with `^`. `*` becomes `[^/]*` unless doubled, where `**/` becomes `(.*/)?` and bare `**` becomes `.*`; `?` becomes `[^/]`; closed character classes are copied with minimal escaping and `!` translated to `^`; unmatched `[` is treated literally by emitting `\[` and pushing consumed chars back; stray `]` becomes `\]`; all other characters are escaped with `regex_lite::escape`. If no glob metacharacters were seen, it appends `(/.*)?` so the exact path and descendants are denied. It then appends `$` and returns the regex.

**Call relations**: This translator is called by `build_seatbelt_unreadable_glob_policy` for both original and canonicalized patterns. Its output directly becomes the regex payload in generated Seatbelt deny clauses.

*Call graph*: called by 1 (build_seatbelt_unreadable_glob_policy); 3 external calls (from, new, escape).


##### `create_seatbelt_command_args_for_legacy_policy`  (lines 569–589)

```
fn create_seatbelt_command_args_for_legacy_policy(
    command: Vec<String>,
    sandbox_policy: &SandboxPolicy,
    sandbox_policy_cwd: &Path,
    enforce_managed_network: bool,
    network: Option<&
```

**Purpose**: Provides a compatibility entry point for callers that still hold the older unified `SandboxPolicy` representation. It derives the newer filesystem and network policy forms and forwards them to the main argument builder.

**Data flow**: Accepts the command vector, `&SandboxPolicy`, cwd, managed-network flag, and optional `&NetworkProxy`. It constructs a `FileSystemSandboxPolicy` with `from_legacy_sandbox_policy_for_cwd`, derives `NetworkSandboxPolicy` with `from`, packages all values into `CreateSeatbeltCommandArgsParams` with no extra unix sockets, and returns the `Vec<String>` from `create_seatbelt_command_args`.

**Call relations**: This wrapper is called by legacy code paths and delegates all real work to `create_seatbelt_command_args`, preserving one implementation of Seatbelt argument synthesis.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, from, create_seatbelt_command_args).


##### `create_seatbelt_command_args`  (lines 602–741)

```
fn create_seatbelt_command_args(args: CreateSeatbeltCommandArgsParams<'_>) -> Vec<String>
```

**Purpose**: Assembles the complete `sandbox-exec` invocation arguments for a command, including the full SBPL policy text and all parameter definitions. It is the file's main public entry point and combines filesystem, unreadable-glob, network, proxy, and unix-socket policy generation into one deterministic output vector.

**Data flow**: Consumes `CreateSeatbeltCommandArgsParams`, destructuring the command, filesystem policy, network policy, cwd, managed-network flag, optional proxy, and extra unix sockets. It queries unreadable roots, then builds write policy: either broad full-disk write, full-root-with-exclusions, or per-writable-root rules using `build_seatbelt_access_policy` and `protected_metadata_names_for_writable_root`. It similarly builds read policy from full-disk read or readable roots, carrying unreadable-root exclusions where needed. It computes `ProxyPolicyInputs` via `proxy_policy_inputs`, derives the network section with `dynamic_network_policy_for_network`, optionally adds platform-default restrictions, and generates unreadable-glob deny rules with `build_seatbelt_unreadable_glob_policy`. All policy sections are concatenated with embedded base/default SBPL fragments into one string. It then concatenates read, write, and unix-socket parameter bindings, formats them as `-DKEY=VALUE`, prefixes `-p <policy>`, appends `--`, then appends the original command, returning the final `Vec<String>`.

**Call relations**: This function is invoked by the sandbox runner and by `create_seatbelt_command_args_for_legacy_policy`. It orchestrates nearly every helper in the file: filesystem access builders, unreadable-glob translation, proxy normalization, network policy synthesis, and unix-socket parameter generation.

*Call graph*: calls 5 internal fn (build_seatbelt_access_policy, build_seatbelt_unreadable_glob_policy, dynamic_network_policy_for_network, proxy_policy_inputs, unix_socket_dir_params); called by 2 (run_command_under_sandbox, create_seatbelt_command_args_for_legacy_policy); 4 external calls (new, new, format!, vec!).


### Shell parsing foundations
These helpers provide shell-specific parsing and normalization primitives that higher-level command analysis builds on.

### `shell-command/src/bash.rs`

`domain_logic` · `command classification and approval checks`

This file is the shell-side parser used by command safety logic. It uses `tree_sitter_bash` to parse script text into a syntax tree, then walks that tree with explicit allow-lists rather than trying to interpret arbitrary shell. The central rule is conservative: only scripts composed of plain commands joined by `&&`, `||`, `;`, or `|` are accepted, and every named node and punctuation token encountered must be on an allow-list. Parentheses, redirections, substitutions, assignments, control flow, and other shell constructs are rejected by structure, not by string matching.

Accepted command nodes are converted into argv-like `Vec<String>` values by `parse_plain_command_from_node`, which supports bare words, numbers, single-quoted strings, double-quoted strings containing only literal `string_content`, and concatenations such as `-g"*.py"`. A separate path, `parse_shell_lc_single_command_prefix`, handles heredoc-style scripts for exec-policy prefix matching: it requires a parse without errors, presence of a heredoc redirect, absence of ordinary file redirects, exactly one command node, and then extracts only literal command words while ignoring heredoc attachment nodes.

The file also contains wrapper detection in `extract_bash_command`, normalizing only shell invocations whose executable path resolves to Bash/Zsh/Sh via `detect_shell_type`. Extensive tests document accepted quoting, concatenation, pipelines, and many rejected edge cases such as substitutions, malformed operator placement, and heredoc misuse.

#### Function details

##### `try_parse_shell`  (lines 13–20)

```
fn try_parse_shell(shell_lc_arg: &str) -> Option<Tree>
```

**Purpose**: Parses raw shell source text with the Bash tree-sitter grammar and returns the syntax tree if parsing succeeds. It does not itself enforce any safety constraints beyond parser success.

**Data flow**: It takes a shell script `&str`, constructs a `Parser`, loads the Bash language, parses the source with no previous tree, and returns `Option<Tree>` from tree-sitter.

**Call relations**: It is the first stage for both `parse_shell_script_into_commands` and `parse_shell_lc_single_command_prefix`, and is also reused by other shell-parsing entry points elsewhere in the crate.

*Call graph*: called by 3 (parse_shell_lc_single_command_prefix, parse_shell_script_into_commands, parse_shell_script); 1 external calls (new).


##### `try_parse_word_only_commands_sequence`  (lines 29–95)

```
fn try_parse_word_only_commands_sequence(tree: &Tree, src: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: Validates that a parsed shell tree contains only a restricted sequence of plain commands joined by safe operators, then extracts each command’s words in source order. Any disallowed syntax causes rejection.

**Data flow**: It takes a parsed `Tree` and original source `&str`, rejects immediately if the root has parse errors, traverses the tree with a stack, checks every named node kind against `ALLOWED_KINDS`, checks punctuation/operator tokens against `ALLOWED_PUNCT_TOKENS`, collects `command` nodes, sorts them by `start_byte`, converts each with `parse_plain_command_from_node`, and returns `Some(Vec<Vec<String>>)` or `None`.

**Call relations**: It is the core validator/extractor called by `parse_shell_script_into_commands`. Its strict traversal is what prevents later safety logic from trusting scripts with hidden shell features.

*Call graph*: calls 1 internal fn (parse_plain_command_from_node); called by 2 (parse_shell_script_into_commands, parse_shell_script); 3 external calls (root_node, new, vec!).


##### `parse_shell_script_into_commands`  (lines 98–101)

```
fn parse_shell_script_into_commands(script: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: Convenience entry point that parses shell text and, if it matches the restricted grammar, returns the extracted command sequence. It combines syntax parsing and structural validation into one call.

**Data flow**: It takes a script `&str`, calls `try_parse_shell`, then passes the resulting tree and original source into `try_parse_word_only_commands_sequence`, returning the extracted commands or `None`.

**Call relations**: This function is the main shell-script parser consumed by command safety code and tests, including `parse_shell_lc_plain_commands`.

*Call graph*: calls 2 internal fn (try_parse_shell, try_parse_word_only_commands_sequence); called by 3 (memories_usage_kinds_from_command, parse_shell_lc_plain_commands, parse_seq).


##### `extract_bash_command`  (lines 103–116)

```
fn extract_bash_command(command: &[String]) -> Option<(&str, &str)>
```

**Purpose**: Recognizes argv vectors of the form `<shell> -c <script>` or `<shell> -lc <script>` where the executable resolves to Bash, Zsh, or Sh. It returns the shell executable and script text for further parsing.

**Data flow**: It takes a `&[String]`, pattern-matches exactly three elements `[shell, flag, script]`, checks that `flag` is `-lc` or `-c`, runs `detect_shell_type(PathBuf::from(shell))`, and returns `Some((&str, &str))` only for Bash/Zsh/Sh executables.

**Call relations**: It is the gatekeeper used by both shell-wrapper parsing functions and by other approval/canonicalization code that wants to inspect shell invocations safely.

*Call graph*: called by 6 (canonicalize_command_for_approval, parse_shell_lc_plain_commands, parse_shell_lc_single_command_prefix, extract_shell_command, parse_shell_lc_commands, format_unified_exec_interaction); 1 external calls (matches!).


##### `parse_shell_lc_plain_commands`  (lines 121–124)

```
fn parse_shell_lc_plain_commands(command: &[String]) -> Option<Vec<Vec<String>>>
```

**Purpose**: Extracts the plain command sequence from a shell wrapper invocation when the embedded script satisfies the restricted grammar. It is the shell-wrapper counterpart to `parse_shell_script_into_commands`.

**Data flow**: It takes a tokenized command slice, uses `extract_bash_command` to obtain the script, then parses that script with `parse_shell_script_into_commands`, returning the command vectors or `None`.

**Call relations**: This is the main bridge from outer argv classification into shell-script analysis, and is used by safety and danger heuristics for `bash -lc` and `zsh -lc` commands.

*Call graph*: calls 2 internal fn (extract_bash_command, parse_shell_script_into_commands); called by 6 (canonicalize_command_for_approval, commands_for_exec_policy, commands_for_intercepted_exec_policy, parse_zsh_lc_plain_commands, command_might_be_dangerous, is_known_safe_command).


##### `parse_shell_lc_single_command_prefix`  (lines 128–144)

```
fn parse_shell_lc_single_command_prefix(command: &[String]) -> Option<Vec<String>>
```

**Purpose**: Extracts only the executable-prefix words from a heredoc-style shell wrapper script when the script contains exactly one command and no ordinary file redirects. It is intentionally narrower than full plain-command parsing.

**Data flow**: It takes a tokenized command slice, extracts the shell script with `extract_bash_command`, parses it with `try_parse_shell`, rejects parse errors, requires a named descendant `heredoc_redirect`, rejects any `file_redirect`, finds exactly one command node with `find_single_command_node`, then converts that node with `parse_heredoc_command_words`.

**Call relations**: It is used by exec-policy code paths that need to recognize a single command prefix even when stdin is supplied via heredoc. It delegates tree searches and word extraction to dedicated helpers.

*Call graph*: calls 5 internal fn (extract_bash_command, find_single_command_node, has_named_descendant_kind, parse_heredoc_command_words, try_parse_shell); called by 3 (commands_for_exec_policy, commands_for_intercepted_exec_policy, parse_shell_lc_single_command_prefix_supports_heredoc).


##### `parse_plain_command_from_node`  (lines 146–202)

```
fn parse_plain_command_from_node(cmd: tree_sitter::Node, src: &str) -> Option<Vec<String>>
```

**Purpose**: Converts one tree-sitter `command` node into a vector of literal argv words, supporting bare words, numbers, quoted strings, and concatenations. It rejects any child shape outside that narrow subset.

**Data flow**: It takes a `Node` and source `&str`, verifies the node kind is `command`, iterates named children, extracts command names from nested `word` nodes, copies `word` and `number` text directly, parses `string` via `parse_double_quoted_string`, parses `raw_string` via `parse_raw_string`, flattens `concatenation` parts into one `String`, and returns `Option<Vec<String>>`.

**Call relations**: It is called for each collected command node by `try_parse_word_only_commands_sequence`, and its rejection behavior enforces literal-only argv extraction.

*Call graph*: calls 2 internal fn (parse_double_quoted_string, parse_raw_string); called by 1 (try_parse_word_only_commands_sequence); 5 external calls (kind, named_children, walk, new, new).


##### `parse_heredoc_command_words`  (lines 204–239)

```
fn parse_heredoc_command_words(cmd: Node<'_>, src: &str) -> Option<Vec<String>>
```

**Purpose**: Extracts the literal argv prefix from a single command node that may carry heredoc attachments. It allows heredoc-related nodes but rejects expansions and non-heredoc redirects.

**Data flow**: It takes a `command` `Node` and source `&str`, iterates named children, accepts `command_name`, `word`, and `number` only when `is_literal_word_or_number` says they have no named descendants, ignores `comment`, ignores attachment kinds accepted by `is_allowed_heredoc_attachment_kind`, rejects everything else, and returns `Some(words)` only if at least one word was collected.

**Call relations**: It is the final extraction step in `parse_shell_lc_single_command_prefix`, specialized for heredoc-bearing scripts where full plain-command parsing would reject the redirect nodes.

*Call graph*: calls 2 internal fn (is_allowed_heredoc_attachment_kind, is_literal_word_or_number); called by 1 (parse_shell_lc_single_command_prefix); 5 external calls (kind, named_children, walk, new, matches!).


##### `is_literal_word_or_number`  (lines 241–247)

```
fn is_literal_word_or_number(node: Node<'_>) -> bool
```

**Purpose**: Checks whether a `word` or `number` node is syntactically literal rather than containing nested expansions or other named structure. This is a structural safety predicate.

**Data flow**: It takes a `Node`, verifies its kind is `word` or `number`, walks its named children, and returns `true` only if there are none.

**Call relations**: It is used by `parse_heredoc_command_words` to reject arithmetic expansions, substitutions, and similar constructs hidden inside otherwise word-like nodes.

*Call graph*: called by 1 (parse_heredoc_command_words); 3 external calls (named_children, walk, matches!).


##### `is_allowed_heredoc_attachment_kind`  (lines 249–258)

```
fn is_allowed_heredoc_attachment_kind(kind: &str) -> bool
```

**Purpose**: Defines which named node kinds may appear alongside a command when extracting a heredoc command prefix. The allow-list is limited to stdin-attachment constructs.

**Data flow**: It takes a node kind `&str` and returns `true` only for `heredoc_body`, `simple_heredoc_body`, `heredoc_redirect`, `herestring_redirect`, or `redirected_statement`.

**Call relations**: It is consulted by `parse_heredoc_command_words` to distinguish acceptable heredoc plumbing from other redirect or syntax nodes.

*Call graph*: called by 1 (parse_heredoc_command_words); 1 external calls (matches!).


##### `find_single_command_node`  (lines 260–277)

```
fn find_single_command_node(root: Node<'_>) -> Option<Node<'_>>
```

**Purpose**: Traverses a syntax subtree and returns the only `command` node if exactly one exists. Multiple commands cause rejection.

**Data flow**: It takes a root `Node`, performs a stack-based traversal over named children, tracks whether a `command` has already been seen, returns `None` on the second one, and otherwise returns the single found node.

**Call relations**: It is used by `parse_shell_lc_single_command_prefix` to enforce the invariant that heredoc prefix extraction only applies to one-command scripts.

*Call graph*: called by 1 (parse_shell_lc_single_command_prefix); 1 external calls (vec!).


##### `has_named_descendant_kind`  (lines 279–291)

```
fn has_named_descendant_kind(node: Node<'_>, kind: &str) -> bool
```

**Purpose**: Searches a syntax subtree for any named descendant of a given kind. It is a generic tree predicate used for redirect checks.

**Data flow**: It takes a root `Node` and target kind `&str`, traverses named children with a stack, returns `true` on the first matching node kind, and `false` if none are found.

**Call relations**: It is called by `parse_shell_lc_single_command_prefix` to require heredoc presence and forbid ordinary file redirects before attempting prefix extraction.

*Call graph*: called by 1 (parse_shell_lc_single_command_prefix); 1 external calls (vec!).


##### `parse_double_quoted_string`  (lines 293–309)

```
fn parse_double_quoted_string(node: Node, src: &str) -> Option<String>
```

**Purpose**: Extracts the literal contents of a double-quoted string node only when it contains plain `string_content` parts and no expansions. This rejects interpolated shell strings.

**Data flow**: It takes a `string` `Node` and source `&str`, verifies the node kind, checks every named child is `string_content`, reads the raw source text, strips the surrounding double quotes, and returns the inner `String`.

**Call relations**: It is used by `parse_plain_command_from_node` for both standalone quoted arguments and quoted parts inside concatenations.

*Call graph*: called by 1 (parse_plain_command_from_node); 4 external calls (kind, named_children, utf8_text, walk).


##### `parse_raw_string`  (lines 311–321)

```
fn parse_raw_string(node: Node, src: &str) -> Option<String>
```

**Purpose**: Extracts the contents of a single-quoted shell string node. It assumes the parser has already identified the node as a raw string literal.

**Data flow**: It takes a `raw_string` `Node` and source `&str`, verifies the kind, reads the raw source text, strips leading and trailing single quotes, and returns the inner owned string.

**Call relations**: It is the single-quoted counterpart to `parse_double_quoted_string`, used by `parse_plain_command_from_node`.

*Call graph*: called by 1 (parse_plain_command_from_node); 2 external calls (kind, utf8_text).


##### `tests::parse_seq`  (lines 328–330)

```
fn parse_seq(src: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: Small test helper that forwards shell source into the main parser. It keeps the test bodies concise.

**Data flow**: It takes a source `&str`, calls `parse_shell_script_into_commands`, and returns the resulting optional command sequence.

**Call relations**: Most parser tests call this helper instead of invoking the parser directly.

*Call graph*: calls 1 internal fn (parse_shell_script_into_commands).


##### `tests::accepts_single_simple_command`  (lines 333–336)

```
fn accepts_single_simple_command()
```

**Purpose**: Confirms that a basic command with one flag parses into one argv vector. It establishes the simplest accepted case.

**Data flow**: The test parses `ls -1`, unwraps the result, and asserts it equals a single command vector containing `ls` and `-1`.

**Call relations**: It exercises the happy path through `parse_shell_script_into_commands` and `parse_plain_command_from_node`.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_multiple_commands_with_allowed_operators`  (lines 339–349)

```
fn accepts_multiple_commands_with_allowed_operators()
```

**Purpose**: Verifies that `&&`, `;`, and `|` are accepted as sequence operators and that commands are returned in source order. It also checks quoted string extraction inside a pipeline.

**Data flow**: The test parses `ls && pwd; echo 'hi there' | wc -l`, unwraps the result, builds the expected nested vectors, and asserts equality.

**Call relations**: It covers the traversal, operator allow-list, command sorting by byte position, and mixed command extraction logic.

*Call graph*: 3 external calls (assert_eq!, parse_seq, vec!).


##### `tests::extracts_double_and_single_quoted_strings`  (lines 352–364)

```
fn extracts_double_and_single_quoted_strings()
```

**Purpose**: Checks that both double-quoted and single-quoted literal strings are unwrapped correctly into argv words. It ensures quotes are removed but contents preserved.

**Data flow**: The test parses `echo "hello world"` and `echo 'hi there'`, unwraps both results, and asserts the extracted words contain the unquoted string contents.

**Call relations**: It specifically exercises `parse_double_quoted_string` and `parse_raw_string` through the main parser.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_double_quoted_strings_with_newlines`  (lines 367–378)

```
fn accepts_double_quoted_strings_with_newlines()
```

**Purpose**: Verifies that literal newlines inside double-quoted strings are preserved rather than rejected. This documents that multiline literal strings are acceptable.

**Data flow**: The test parses `git commit -m "line1
line2"`, unwraps the result, and asserts the `-m` argument value contains the embedded newline.

**Call relations**: It covers the string-content-only rule in `parse_double_quoted_string` with multiline content.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_mixed_quote_concatenation`  (lines 381–390)

```
fn accepts_mixed_quote_concatenation()
```

**Purpose**: Confirms that adjacent quoted and unquoted literal fragments are concatenated into one argv word. This matches shell concatenation semantics for purely literal pieces.

**Data flow**: The test parses two mixed-quote `echo` examples and asserts each yields a single concatenated path argument `/usr/local/bin`.

**Call relations**: It exercises the `concatenation` branch in `parse_plain_command_from_node`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_double_quoted_strings_with_expansions`  (lines 393–396)

```
fn rejects_double_quoted_strings_with_expansions()
```

**Purpose**: Ensures interpolated double-quoted strings are rejected. Variable and parameter expansions inside quotes are not considered literal-safe.

**Data flow**: The test calls `parse_seq` on examples containing `${USER}` and `$HOME` inside double quotes and asserts both return `None`.

**Call relations**: It validates the child-kind check in `parse_double_quoted_string` and the parser’s conservative rejection of expansions.

*Call graph*: 1 external calls (assert!).


##### `tests::accepts_numbers_as_words`  (lines 399–409)

```
fn accepts_numbers_as_words()
```

**Purpose**: Checks that numeric tokens are accepted as command arguments. Tree-sitter emits numbers separately from words, so this test locks in support for them.

**Data flow**: The test parses `echo 123 456`, unwraps the result, and asserts the argv contains the numeric strings unchanged.

**Call relations**: It exercises the `number` handling in `parse_plain_command_from_node`.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::rejects_parentheses_and_subshells`  (lines 412–415)

```
fn rejects_parentheses_and_subshells()
```

**Purpose**: Verifies that subshell/grouping syntax is rejected outright. Parentheses are outside the allowed shell subset.

**Data flow**: The test parses `(ls)` and `ls || (pwd && echo hi)` and asserts both return `None`.

**Call relations**: It covers the named-node and punctuation rejection logic in `try_parse_word_only_commands_sequence`.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_redirections_and_unsupported_operators`  (lines 418–421)

```
fn rejects_redirections_and_unsupported_operators()
```

**Purpose**: Ensures output redirection and unsupported backgrounding operators are rejected. These constructs can introduce side effects or ambiguous semantics.

**Data flow**: The test parses `ls > out.txt` and `echo hi & echo bye` and asserts both are rejected.

**Call relations**: It validates the punctuation/operator allow-list and disallowed syntax filtering in the tree walk.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_command_and_process_substitutions_and_expansions`  (lines 424–429)

```
fn rejects_command_and_process_substitutions_and_expansions()
```

**Purpose**: Checks that command substitution, backticks, variable expansion, and interpolated variables are all rejected. These forms are not literal-safe.

**Data flow**: The test parses several substitution/expansion examples and asserts each returns `None`.

**Call relations**: It exercises multiple rejection paths in the parser’s structural checks and string parsing helpers.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_variable_assignment_prefix`  (lines 432–434)

```
fn rejects_variable_assignment_prefix()
```

**Purpose**: Verifies that assignment-prefixed commands like `FOO=bar ls` are not accepted as plain commands. Environment mutation before execution is outside the safe subset.

**Data flow**: The test parses `FOO=bar ls` and asserts the parser returns `None`.

**Call relations**: It documents that assignment syntax is excluded by the allowed-node filter.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_trailing_operator_parse_error`  (lines 437–439)

```
fn rejects_trailing_operator_parse_error()
```

**Purpose**: Ensures syntactically incomplete command sequences are rejected. A trailing operator must not produce a partial accepted parse.

**Data flow**: The test parses `ls &&` and asserts the result is `None`.

**Call relations**: It relies on parse errors being surfaced by `tree.root_node().has_error()` in `try_parse_word_only_commands_sequence`.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_empty_command_position_with_leading_operator`  (lines 442–444)

```
fn rejects_empty_command_position_with_leading_operator()
```

**Purpose**: Checks that a leading operator without a preceding command is rejected. Empty command slots are not tolerated.

**Data flow**: The test parses `&& ls` and asserts rejection.

**Call relations**: It covers parse-error or invalid-structure rejection in the main sequence parser.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_empty_command_position_with_double_separator`  (lines 447–449)

```
fn rejects_empty_command_position_with_double_separator()
```

**Purpose**: Verifies that doubled separators creating an empty command position are rejected. This prevents malformed lists from being misinterpreted.

**Data flow**: The test parses `ls ;; pwd` and asserts the parser returns `None`.

**Call relations**: It exercises the same conservative malformed-script handling as other operator-placement tests.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_empty_command_position_with_empty_pipeline_segment`  (lines 452–454)

```
fn rejects_empty_command_position_with_empty_pipeline_segment()
```

**Purpose**: Ensures pipelines with an empty segment are rejected. A missing command between pipes must not be accepted.

**Data flow**: The test parses `ls | | wc` and asserts rejection.

**Call relations**: It validates malformed pipeline handling in the parser.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_zsh_lc_plain_commands`  (lines 457–461)

```
fn parse_zsh_lc_plain_commands()
```

**Purpose**: Confirms that `zsh -lc` wrappers are accepted alongside Bash wrappers and parsed into plain commands. The shell executable detection intentionally treats Zsh as supported.

**Data flow**: The test builds a three-element command vector for `zsh -lc ls`, calls `parse_shell_lc_plain_commands`, unwraps the result, and asserts it equals one `ls` command.

**Call relations**: It exercises `extract_bash_command`’s shell-type detection and the wrapper parsing path.

*Call graph*: calls 1 internal fn (parse_shell_lc_plain_commands); 2 external calls (assert_eq!, vec!).


##### `tests::accepts_concatenated_flag_and_value`  (lines 464–476)

```
fn accepts_concatenated_flag_and_value()
```

**Purpose**: Checks that concatenated literal fragments like `-g"*.py"` are flattened into one argv word. This is important for common CLI flag syntax.

**Data flow**: The test parses `rg -n "foo" -g"*.py"`, unwraps the result, and asserts the final argument is `-g*.py`.

**Call relations**: It specifically covers concatenation handling in `parse_plain_command_from_node`.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_concatenated_flag_with_single_quotes`  (lines 479–490)

```
fn accepts_concatenated_flag_with_single_quotes()
```

**Purpose**: Verifies the same concatenation behavior for single-quoted fragments. Literal quoting style should not affect acceptance.

**Data flow**: The test parses `grep -n 'pattern' -g'*.txt'`, unwraps the result, and asserts the final argument is `-g*.txt`.

**Call relations**: It complements the previous concatenation test using `parse_raw_string` inside concatenations.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::rejects_concatenation_with_variable_substitution`  (lines 493–497)

```
fn rejects_concatenation_with_variable_substitution()
```

**Purpose**: Ensures concatenations containing variable expansion are rejected rather than partially flattened. Literal-only concatenation is the invariant.

**Data flow**: The test parses two `rg -g"$VAR"` forms and asserts both return `None`.

**Call relations**: It validates that concatenation parsing still depends on the quoted-string helpers rejecting expansions.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_concatenation_with_command_substitution`  (lines 500–504)

```
fn rejects_concatenation_with_command_substitution()
```

**Purpose**: Checks that command substitution inside concatenated strings is rejected. This prevents hidden execution inside otherwise literal-looking arguments.

**Data flow**: The test parses two `$(...)` concatenation examples and asserts both are rejected.

**Call relations**: It covers the same concatenation path under substitution-heavy inputs.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_shell_lc_single_command_prefix_supports_heredoc`  (lines 507–523)

```
fn parse_shell_lc_single_command_prefix_supports_heredoc()
```

**Purpose**: Verifies that heredoc scripts can still yield a single executable prefix when they contain exactly one command and no unsafe redirects. Both quoted and unquoted heredoc delimiters are accepted.

**Data flow**: The test builds two `zsh -lc` command vectors containing `python3 <<...` scripts, calls `parse_shell_lc_single_command_prefix`, and asserts each returns `Some(vec!["python3"])`.

**Call relations**: It exercises the heredoc-specific path through `extract_bash_command`, `try_parse_shell`, descendant checks, `find_single_command_node`, and `parse_heredoc_command_words`.

*Call graph*: calls 1 internal fn (parse_shell_lc_single_command_prefix); 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_multi_command_scripts`  (lines 526–533)

```
fn parse_shell_lc_single_command_prefix_rejects_multi_command_scripts()
```

**Purpose**: Ensures heredoc prefix extraction does not apply when the script contains more than one command. The helper is intentionally single-command only.

**Data flow**: The test builds a `bash -lc` heredoc script followed by `echo done` and asserts `parse_shell_lc_single_command_prefix` returns `None`.

**Call relations**: It validates the uniqueness check enforced by `find_single_command_node`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_non_heredoc_redirects`  (lines 536–543)

```
fn parse_shell_lc_single_command_prefix_rejects_non_heredoc_redirects()
```

**Purpose**: Checks that ordinary file redirects are rejected by the heredoc-prefix parser. Prefix extraction must not ignore output side effects.

**Data flow**: The test passes `echo hello > /tmp/out.txt` through `parse_shell_lc_single_command_prefix` and asserts `None`.

**Call relations**: It covers the `has_named_descendant_kind(root, "file_redirect")` rejection path.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_heredoc_with_extra_file_redirect`  (lines 546–553)

```
fn parse_shell_lc_single_command_prefix_rejects_heredoc_with_extra_file_redirect()
```

**Purpose**: Ensures a heredoc combined with an additional file redirect is still rejected. Heredoc support is not a blanket redirect exemption.

**Data flow**: The test parses a `python3 <<'PY' > /tmp/out.txt` script and asserts the prefix parser returns `None`.

**Call relations**: It validates that the file-redirect prohibition still applies even when a heredoc is present.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_heredoc_with_variable_assignment`  (lines 556–563)

```
fn parse_shell_lc_single_command_prefix_rejects_heredoc_with_variable_assignment()
```

**Purpose**: Checks that assignment-prefixed heredoc commands are rejected. Literal command-prefix extraction must not ignore environment mutation.

**Data flow**: The test parses `PATH=/tmp/evil:$PATH cat <<'EOF'...` and asserts `None`.

**Call relations**: It exercises `parse_heredoc_command_words` and the literal-word checks against expanded/structured nodes.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_herestring_with_chaining`  (lines 566–573)

```
fn parse_shell_lc_single_command_prefix_rejects_herestring_with_chaining()
```

**Purpose**: Verifies that scripts with chaining and non-heredoc redirects are rejected by the single-command prefix parser. It must not collapse multi-step scripts into one executable prefix.

**Data flow**: The test parses `echo hello > /tmp/out.txt && cat /tmp/out.txt` and asserts `None`.

**Call relations**: It covers both the redirect and multi-command rejection conditions in the heredoc-prefix path.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_herestring_with_substitution`  (lines 576–583)

```
fn parse_shell_lc_single_command_prefix_rejects_herestring_with_substitution()
```

**Purpose**: Ensures here-string input containing command substitution is rejected. Dynamic stdin expressions are not treated as safe literal prefixes.

**Data flow**: The test parses `python3 <<< "$(rm -rf /)"` and asserts `None`.

**Call relations**: It validates the literal-word restrictions and unsupported syntax handling in the heredoc-prefix parser.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_arithmetic_shift_non_heredoc_script`  (lines 586–593)

```
fn parse_shell_lc_single_command_prefix_rejects_arithmetic_shift_non_heredoc_script()
```

**Purpose**: Checks that arithmetic expansion in a non-heredoc script is rejected by the prefix parser. The helper is not a general shell parser.

**Data flow**: The test parses `echo $((1<<2))` and asserts `None`.

**Call relations**: It exercises the parse and descendant checks leading to rejection before any prefix extraction.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_heredoc_command_with_word_expansion`  (lines 596–603)

```
fn parse_shell_lc_single_command_prefix_rejects_heredoc_command_with_word_expansion()
```

**Purpose**: Ensures arithmetic expansion inside the command words of a heredoc script is rejected. Even with heredoc stdin, argv words must remain literal.

**Data flow**: The test parses `python3 $((1<<2)) <<'PY'...` and asserts `None`.

**Call relations**: It specifically validates `is_literal_word_or_number` within `parse_heredoc_command_words`.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `shell-command/src/powershell.rs`

`domain_logic` · `command parsing and shell normalization; occasional executable discovery during setup/tests`

This file concentrates all logic for recognizing argv-style PowerShell invocations, extracting the script payload behind `-Command`/`-c`, optionally rewriting that payload to force UTF-8 console output, and locating runnable `powershell.exe` or `pwsh.exe` binaries. The recognition path is intentionally strict: `extract_powershell_command` first verifies that argv[0] resolves to `ShellType::PowerShell` via `detect_shell_type`, then scans subsequent arguments in order, accepting only a small allowlist of wrapper flags (`-nologo`, `-noprofile`, `-command`, `-c`). Any unexpected flag aborts extraction rather than trying to be permissive. Once a command is recognized, `prefix_powershell_script_with_utf8` rewrites only the final script argument, preserving the original executable and flags and avoiding duplicate insertion if the script already begins with `UTF8_OUTPUT_PREFIX` after leading whitespace trimming.

For parsing, `parse_powershell_command_into_plain_commands` does not interpret arbitrary Windows shell syntax itself; it unwraps the PowerShell wrapper and delegates the script body to `try_parse_powershell_ast_commands`, keeping this module narrowly focused on wrapper detection. Executable discovery is similarly defensive: `try_find_pwsh_executable_blocking` first asks `cmd /C pwsh ... $PSHOME` for PowerShell Core’s installation home, constructs `pwsh.exe` relative to that directory, validates it by actually running `Write-Output ok`, and only then falls back to PATH lookup. Shared helpers ensure discovered paths are absolute and executable, not merely present in PATH. The tests cover accepted casing, full-path executables, alias handling, UTF-8 prefix idempotence, and AST-based plain-command parsing on Windows.

#### Function details

##### `prefix_powershell_script_with_utf8`  (lines 15–33)

```
fn prefix_powershell_script_with_utf8(command: &[String]) -> Vec<String>
```

**Purpose**: Prepends a best-effort PowerShell snippet that sets `[Console]::OutputEncoding` to UTF-8, but only when the input argv is a recognized PowerShell `-Command`/`-c` invocation. It preserves non-script arguments unchanged and avoids adding the prefix twice.

**Data flow**: It takes a borrowed `&[String]` command vector, reads it through `extract_powershell_command`, and if extraction fails returns a cloned copy of the original argv. When extraction succeeds, it trims leading whitespace from the script to test whether `UTF8_OUTPUT_PREFIX` is already present; if not, it builds a new script string with `format!`, clones all arguments except the last one, appends the rewritten script, and returns the new `Vec<String>`.

**Call relations**: This function is used from higher-level run paths when PowerShell commands need output normalized before execution, and it is exercised directly by the UTF-8 prefix test. Its only internal dependency is `extract_powershell_command`, which gates rewriting so callers can safely pass arbitrary argv without separate shell checks.

*Call graph*: calls 1 internal fn (extract_powershell_command); called by 3 (run, run, prefixes_powershell_command_with_best_effort_utf8); 1 external calls (format!).


##### `extract_powershell_command`  (lines 43–71)

```
fn extract_powershell_command(command: &[String]) -> Option<(&str, &str)>
```

**Purpose**: Recognizes a narrow PowerShell wrapper shape and returns the executable token plus the script body string that follows `-Command` or `-c`. It rejects short argv, non-PowerShell executables, and any wrapper containing flags outside the module’s allowlist.

**Data flow**: It reads the input `&[String]`, first requiring at least three elements. It inspects `command[0]`, converts it to a `PathBuf`, and asks `detect_shell_type` whether it is `Some(ShellType::PowerShell)`; if not, it returns `None`. It then scans arguments from index 1 onward while a following element exists, lowercases each flag for membership testing against `POWERSHELL_FLAGS`, returns `None` on the first unknown flag, and returns `Some((&str, &str))` when it encounters `-Command` or `-c`, using the next element as the script.

**Call relations**: This is the central recognizer for the file: approval/canonicalization code, parser code, UTF-8 prefixing, and plain-command parsing all call it before doing PowerShell-specific work. It does not delegate further parsing of the script itself; instead it acts as the narrow front door that decides whether downstream PowerShell logic should run at all.

*Call graph*: called by 8 (canonicalize_command_for_approval, parse_command_impl, parse_powershell_command_into_plain_commands, prefix_powershell_script_with_utf8, extracts_basic_powershell_command, extracts_full_path_powershell_command, extracts_lowercase_flags, extracts_with_noprofile_and_alias); 1 external calls (matches!).


##### `parse_powershell_command_into_plain_commands`  (lines 78–83)

```
fn parse_powershell_command_into_plain_commands(
    command: &[String],
) -> Option<Vec<Vec<String>>>
```

**Purpose**: Unwraps a recognized PowerShell wrapper and asks the PowerShell AST parser to convert the script body into plain argv-like command segments. It exists specifically for top-level `powershell ... -Command <script>` forms, not arbitrary shell command lines.

**Data flow**: It accepts `&[String]`, calls `extract_powershell_command`, and early-returns `None` if the wrapper is not recognized. On success it receives `(executable, script)` and passes both into `try_parse_powershell_ast_commands`, returning that parser’s `Option<Vec<Vec<String>>>` result unchanged.

**Call relations**: This function is invoked by command-policy logic that needs to inspect the concrete commands embedded inside a PowerShell wrapper, and by Windows-only tests that verify simple and piped scripts are decomposed correctly. It sits between wrapper recognition and the AST parser, deliberately delegating all script semantics to `try_parse_powershell_ast_commands`.

*Call graph*: calls 1 internal fn (extract_powershell_command); called by 3 (commands_for_exec_policy, parses_multiple_plain_powershell_commands, parses_plain_powershell_commands); 1 external calls (try_parse_powershell_ast_commands).


##### `try_find_powershell_executable_blocking`  (lines 86–88)

```
fn try_find_powershell_executable_blocking() -> Option<AbsolutePathBuf>
```

**Purpose**: Looks for a usable Windows PowerShell executable by searching for `powershell.exe` and validating the result. It is the simplest discovery path in the file.

**Data flow**: It takes no arguments and directly calls `try_find_powershellish_executable_in_path` with a single candidate slice containing `"powershell.exe"`. It returns the resulting `Option<AbsolutePathBuf>` unchanged.

**Call relations**: Tests and parser-process scenarios call this helper when they need a concrete Windows PowerShell binary to exercise wrapper recognition or safety checks. All actual lookup and validation work is delegated to the shared PATH-search helper.

*Call graph*: calls 1 internal fn (try_find_powershellish_executable_in_path); called by 3 (commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command, parser_process_handles_multiple_requests, parser_process_rejects_stop_parsing_forms).


##### `try_find_pwsh_executable_blocking`  (lines 100–122)

```
fn try_find_pwsh_executable_blocking() -> Option<AbsolutePathBuf>
```

**Purpose**: Finds a usable PowerShell Core executable, preferring discovery via `$PSHOME` and falling back to PATH lookup. This extra logic exists because `pwsh.exe` may be installed outside PATH even when present on the machine.

**Data flow**: It starts a blocking `cmd /C pwsh -NoProfile -Command $PSHOME` subprocess and reads its output. If the subprocess succeeds and stdout trims to a non-empty directory string, it resolves `pwsh.exe` against that base with `AbsolutePathBuf::resolve_path_against_base`, validates the candidate with `is_powershellish_executable_available`, and returns it on success. If any step fails, it falls back to `try_find_powershellish_executable_in_path(&["pwsh.exe"])` and returns that result.

**Call relations**: Safety and parsing tests that specifically care about `pwsh` variants call this function to obtain a real executable path. Internally it orchestrates two lower-level helpers—path construction/validation first, generic PATH search second—so callers get a single best-effort discovery API.

*Call graph*: calls 3 internal fn (is_powershellish_executable_available, try_find_powershellish_executable_in_path, resolve_path_against_base); called by 7 (commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command, windows_powershell_full_path_is_safe, accepts_full_path_powershell_invocations, allows_read_only_pipelines_and_git_usage, recognizes_safe_powershell_wrappers, rejects_git_global_override_options, uses_invoked_powershell_variant_for_parsing); 1 external calls (new).


##### `try_find_powershellish_executable_in_path`  (lines 124–142)

```
fn try_find_powershellish_executable_in_path(candidates: &[&str]) -> Option<AbsolutePathBuf>
```

**Purpose**: Searches PATH for one or more candidate executable names and returns the first one that both resolves and successfully runs a trivial PowerShell command. It filters out stale PATH entries or nonfunctional binaries.

**Data flow**: It takes a slice of candidate names, iterates in order, and for each one calls `which::which`. For each resolved path it invokes `is_powershellish_executable_available`; unavailable candidates are skipped. For available paths it attempts `AbsolutePathBuf::from_absolute_path`, skipping any path that cannot be represented as an absolute-path wrapper, and returns the first successful `AbsolutePathBuf`. If no candidate passes all checks, it returns `None`.

**Call relations**: Both executable-discovery entry points delegate to this helper for their PATH fallback or sole lookup path. Its role is to centralize the repeated loop of locate → validate → normalize-to-absolute-path.

*Call graph*: calls 2 internal fn (is_powershellish_executable_available, from_absolute_path); called by 2 (try_find_powershell_executable_blocking, try_find_pwsh_executable_blocking); 1 external calls (which).


##### `is_powershellish_executable_available`  (lines 144–151)

```
fn is_powershellish_executable_available(powershell_or_pwsh_exe: &std::path::Path) -> bool
```

**Purpose**: Verifies that a candidate PowerShell executable can actually be launched and execute a minimal command successfully. It is a runtime health check rather than a mere filesystem existence test.

**Data flow**: It accepts a `&Path`, spawns that executable with `-NoLogo -NoProfile -Command Write-Output ok`, and reads the subprocess result. It maps a successful spawn to `output.status.success()` and returns `false` for spawn failures or unsuccessful exits via `unwrap_or(false)`.

**Call relations**: This helper is called from both discovery paths: directly when validating a `$PSHOME`-derived `pwsh.exe`, and indirectly from the PATH-search loop for every candidate found by `which`. It provides the invariant that any returned executable path has already survived a real invocation.

*Call graph*: called by 2 (try_find_powershellish_executable_in_path, try_find_pwsh_executable_blocking); 1 external calls (new).


##### `tests::extracts_basic_powershell_command`  (lines 162–170)

```
fn extracts_basic_powershell_command()
```

**Purpose**: Checks that a minimal `powershell -Command <script>` argv is recognized and that the script body is returned unchanged.

**Data flow**: The test constructs a three-element `Vec<String>`, passes it to `extract_powershell_command`, unwraps the `Option`, and asserts that the extracted script equals `"Write-Host hi"`. It writes no persistent state beyond the test assertion outcome.

**Call relations**: This test directly exercises the happy-path branch of `extract_powershell_command`, serving as the baseline wrapper shape against which stricter flag handling is understood.

*Call graph*: calls 1 internal fn (extract_powershell_command); 2 external calls (assert_eq!, vec!).


##### `tests::extracts_lowercase_flags`  (lines 173–182)

```
fn extracts_lowercase_flags()
```

**Purpose**: Verifies that lowercase PowerShell flags are accepted, confirming case-insensitive handling of wrapper options.

**Data flow**: It builds argv using `-nologo` and `-command`, calls `extract_powershell_command`, unwraps the result, and asserts that the script payload is preserved. The only output is the pass/fail assertion.

**Call relations**: This test targets the flag-normalization path inside `extract_powershell_command`, specifically the lowercase membership check and case-insensitive command-flag recognition.

*Call graph*: calls 1 internal fn (extract_powershell_command); 2 external calls (assert_eq!, vec!).


##### `tests::extracts_full_path_powershell_command`  (lines 185–194)

```
fn extracts_full_path_powershell_command()
```

**Purpose**: Confirms that wrapper recognition works when argv[0] is a full filesystem path to `powershell.exe`, not just a bare executable name.

**Data flow**: It chooses a Windows or Unix-style full path string based on `cfg!(windows)`, constructs argv with `-Command`, calls `extract_powershell_command`, and asserts that the extracted script matches the input script. No external state is modified.

**Call relations**: This test validates the interaction between `extract_powershell_command` and shell detection, proving that `detect_shell_type(PathBuf::from(shell))` accepts full-path PowerShell executables.

*Call graph*: calls 1 internal fn (extract_powershell_command); 3 external calls (assert_eq!, cfg!, vec!).


##### `tests::extracts_with_noprofile_and_alias`  (lines 197–206)

```
fn extracts_with_noprofile_and_alias()
```

**Purpose**: Checks that `pwsh` plus `-NoProfile` and the short `-c` alias are accepted as a valid PowerShell wrapper.

**Data flow**: It creates argv for `pwsh -NoProfile -c <script>`, invokes `extract_powershell_command`, unwraps the result, and asserts that the script body is exactly the pipeline string supplied. The test only emits assertion success/failure.

**Call relations**: This test covers the alternate executable and short command-flag branch of `extract_powershell_command`, complementing the basic `powershell -Command` case.

*Call graph*: calls 1 internal fn (extract_powershell_command); 2 external calls (assert_eq!, vec!).


##### `tests::prefixes_powershell_command_with_best_effort_utf8`  (lines 209–226)

```
fn prefixes_powershell_command_with_best_effort_utf8()
```

**Purpose**: Ensures that recognized PowerShell commands are rewritten so the script begins with the UTF-8 output prefix.

**Data flow**: It constructs a simple PowerShell argv, passes it to `prefix_powershell_script_with_utf8`, and asserts that the returned vector matches the original executable and flags with the final script replaced by `UTF8_OUTPUT_PREFIX` plus the original script. The test has no side effects beyond assertion.

**Call relations**: This test exercises the successful rewrite path of `prefix_powershell_script_with_utf8`, demonstrating how that function transforms only the script argument after wrapper extraction succeeds.

*Call graph*: calls 1 internal fn (prefix_powershell_script_with_utf8); 2 external calls (assert_eq!, vec!).


##### `tests::does_not_duplicate_utf8_prefix`  (lines 229–237)

```
fn does_not_duplicate_utf8_prefix()
```

**Purpose**: Verifies idempotence of UTF-8 prefix insertion when the script already starts with the exact prefix string.

**Data flow**: It builds argv whose script is already `UTF8_OUTPUT_PREFIX` followed by a command, calls `prefix_powershell_script_with_utf8`, and asserts that the returned vector is byte-for-byte equal to the original input vector. No external state is touched.

**Call relations**: This test targets the branch in `prefix_powershell_script_with_utf8` that checks `trim_start()` and skips rewriting when the prefix is already present.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parses_plain_powershell_commands`  (lines 241–251)

```
fn parses_plain_powershell_commands()
```

**Purpose**: On Windows, confirms that a simple PowerShell script body like `echo hi` is parsed into a single plain argv command.

**Data flow**: It passes a `powershell.exe -NoProfile -Command "echo hi"` argv slice into `parse_powershell_command_into_plain_commands`, unwraps the returned nested vector, and asserts equality with `[["echo", "hi"]]`. The test only records assertion success/failure.

**Call relations**: This test exercises the full wrapper-unwrapping path into `try_parse_powershell_ast_commands`, proving that `parse_powershell_command_into_plain_commands` delegates correctly for a trivial script.

*Call graph*: calls 1 internal fn (parse_powershell_command_into_plain_commands); 1 external calls (assert_eq!).


##### `tests::parses_multiple_plain_powershell_commands`  (lines 255–271)

```
fn parses_multiple_plain_powershell_commands()
```

**Purpose**: On Windows, verifies that a piped PowerShell script is decomposed into multiple plain command vectors in pipeline order.

**Data flow**: It invokes `parse_powershell_command_into_plain_commands` with a wrapper around `Write-Output foo | Measure-Object`, unwraps the result, and asserts that the returned nested vector contains one argv for `Write-Output foo` and one for `Measure-Object`. No persistent state is changed.

**Call relations**: This test covers the multi-command parsing behavior exposed through `parse_powershell_command_into_plain_commands`, showing that the delegated AST parser can split a pipeline into separate plain commands.

*Call graph*: calls 1 internal fn (parse_powershell_command_into_plain_commands); 1 external calls (assert_eq!).


### `core/src/command_canonicalization.rs`

`util` · `approval matching`

This file contains a single helper, `canonicalize_command_for_approval`, plus two string constants used as synthetic prefixes for script-shaped commands. The function exists specifically for approval-cache matching: two invocations that are semantically the same should hash to the same approval key even if one uses `/bin/bash -lc` and another uses `bash -lc`, or if PowerShell wrappers differ slightly.

The control flow is intentionally ordered from most precise to most conservative. First, it asks `parse_shell_lc_plain_commands` whether the argv represents a shell `-lc` wrapper around plain tokenizable commands; if exactly one plain command is recovered, that inner token vector becomes the canonical form. This collapses whitespace and wrapper-path differences for simple shell invocations like `bash -lc "cargo   test"`. If that parse fails, it falls back to `extract_bash_command`; for arbitrary shell scripts such as heredocs, it returns a synthetic vector beginning with `__codex_shell_script__`, followed by the shell mode argument and the exact script text. PowerShell wrappers are handled similarly with `__codex_powershell_script__` and the extracted script body. If none of the shell-specific recognizers match, the original argv is returned unchanged. The design deliberately prefers preserving exact script text over risky normalization for complex scripts.

#### Function details

##### `canonicalize_command_for_approval`  (lines 14–38)

```
fn canonicalize_command_for_approval(command: &[String]) -> Vec<String>
```

**Purpose**: Converts a command argv slice into a stable canonical vector suitable for approval-cache comparisons. It collapses simple shell wrappers to their inner command tokens and otherwise emits synthetic script keys for bash-like and PowerShell script wrappers.

**Data flow**: Takes `&[String]` command argv → first tries `parse_shell_lc_plain_commands`; if it yields exactly one plain command, returns that cloned token vector → else tries `extract_bash_command` and returns `["__codex_shell_script__", shell_mode, script]` → else tries `extract_powershell_command` and returns `["__codex_powershell_script__", script]` → otherwise clones and returns the original argv.

**Call relations**: This helper is called by approval-related code that needs stable cache keys across wrapper-path and shell-launch variations, and it delegates parsing/extraction to the shell-command utility crate.

*Call graph*: calls 3 internal fn (extract_bash_command, parse_shell_lc_plain_commands, extract_powershell_command); 1 external calls (vec!).


### `shell-command/src/parse_command.rs`

`domain_logic` · `request handling`

This file is the core command summarizer for the shell-command crate. Its output type is `codex_protocol::parse_command::ParsedCommand`, and nearly all logic exists to infer one of a few semantic categories from a raw `&[String]` token vector or from a shell script embedded in `bash -c/-lc`, `zsh -c/-lc`, or PowerShell wrappers. The parser first peels off shell wrappers (`extract_bash_command`, `extract_powershell_command`), then either parses a shell AST via `try_parse_shell`/`try_parse_word_only_commands_sequence` or falls back to token-based heuristics.

The main heuristics classify commands like `rg`, `grep`, `git grep`, `fd`, `find`, `ls`/`tree`/`du`, `cat`/`bat`/`less`/`more`, `head`/`tail`, `awk`, `sed -n`, `nl`, and Python `-c` snippets that enumerate files. It tracks `cd` segments across command sequences so `Read` paths become relative to the effective working directory, using `join_paths` and `PathBuf`. It also strips or ignores formatting-only pipeline helpers (`head`, `tail`, `wc`, `cut`, `sort`, `uniq`, `printf`, non-mutating `xargs`, etc.), removes trivial commands like `true`, and repeatedly simplifies parsed sequences with `simplify_once`.

Two important invariants shape the final result: consecutive duplicate summaries are deduplicated, and if any parsed segment remains `ParsedCommand::Unknown`, the whole command collapses to a single `Unknown` summary built from the shell script or joined tokens. The large inline test module documents many edge cases: quoted patterns, Windows paths, `--flag=value` handling, `sed -n` range detection, mutating `xargs perl -pi`, and preserving grep queries without shortening slash-containing patterns.

#### Function details

##### `shlex_join`  (lines 10–13)

```
fn shlex_join(tokens: &[String]) -> String
```

**Purpose**: Joins a token slice back into a shell-escaped command string suitable for display in summaries. It provides a stable fallback string when joining fails because a token contains a NUL byte.

**Data flow**: Takes `&[String]`, maps each token to `&str`, and feeds them to `shlex::try_join`. On success it returns the escaped command string; on error it returns the literal placeholder `"<command included NUL byte>"`. It does not mutate external state.

**Call relations**: This is the common rendering primitive used throughout parsing and by external event-building code whenever a tokenized command must be shown to users. Parsing helpers call it when constructing `ParsedCommand::{Unknown,Search,ListFiles,Read}` so summaries preserve quoting and spacing.

*Call graph*: called by 16 (build_command_execution_approval_request_item, build_command_execution_begin_item, build_command_execution_end_item, build_item_from_guardian_event, apply_bespoke_event_handling, command_assessment_action, handle_call, prompt, execve_permission_request_hook_short_circuits_prompt, parse_grep_like (+6 more)); 1 external calls (try_join).


##### `extract_shell_command`  (lines 16–18)

```
fn extract_shell_command(command: &[String]) -> Option<(&str, &str)>
```

**Purpose**: Detects whether a tokenized command is really a shell wrapper and, if so, extracts the wrapped script text. It supports both Bash-compatible wrappers and PowerShell wrappers.

**Data flow**: Consumes `&[String]` and first queries Bash extraction; if that returns `None`, it tries PowerShell extraction. It returns `Option<(&str, &str)>`, where the tuple contains the shell executable and the embedded script string.

**Call relations**: It is used when building a single fallback `Unknown` summary so the displayed command is the inner script rather than the outer shell invocation. Other code that strips shell wrappers relies on this helper to unify Bash and PowerShell detection.

*Call graph*: calls 1 internal fn (extract_bash_command); called by 2 (single_unknown_for_command, strip_bash_lc_and_escape).


##### `parse_command`  (lines 30–48)

```
fn parse_command(command: &[String]) -> Vec<ParsedCommand>
```

**Purpose**: Provides the public, user-facing parse entrypoint that normalizes the lower-level parse result into a concise summary list. It removes consecutive duplicates and collapses any partially understood command sequence into one `Unknown` summary.

**Data flow**: Accepts a tokenized command slice, delegates to `parse_command_impl`, then iterates through the returned `Vec<ParsedCommand>` to drop adjacent duplicates. If any remaining element is `ParsedCommand::Unknown`, it discards the detailed list and returns a one-element vector from `single_unknown_for_command`; otherwise it returns the deduplicated vector.

**Call relations**: Higher-level execution, approval, and UI code calls this function when it needs a safe summary for arbitrary commands. It sits above `parse_command_impl` specifically to enforce the conservative rule that mixed known/unknown pipelines should be presented as wholly unknown.

*Call graph*: calls 1 internal fn (parse_command_impl); called by 10 (build_item_from_guardian_event, request_command_approval, execute_user_shell_command, shell, unified_exec, create_expected_elicitation_request_params, assert_parsed, supports_tail_n_last_lines, exec_end_without_begin_uses_event_command, begin_exec_with_source); 2 external calls (with_capacity, vec!).


##### `single_unknown_for_command`  (lines 50–60)

```
fn single_unknown_for_command(command: &[String]) -> ParsedCommand
```

**Purpose**: Builds the canonical fallback `ParsedCommand::Unknown` for a command that could not be summarized safely. It prefers the inner shell script text over the outer wrapper invocation.

**Data flow**: Reads the original `&[String]` command. If `extract_shell_command` finds an embedded script, it returns `ParsedCommand::Unknown { cmd: script.to_string() }`; otherwise it joins the original tokens with `shlex_join` and stores that string in the `cmd` field.

**Call relations**: This helper is only used by `parse_command` after the lower-level parser produced at least one unknown segment. Its role is to replace a potentially misleading partial parse with a single opaque summary.

*Call graph*: calls 2 internal fn (extract_shell_command, shlex_join).


##### `tests::shlex_split_safe`  (lines 71–73)

```
fn shlex_split_safe(s: &str) -> Vec<String>
```

**Purpose**: Test-only helper that tokenizes a shell command string while tolerating malformed quoting. It keeps tests concise by always returning a `Vec<String>`.

**Data flow**: Takes `&str`, tries `shlex::split`, and if parsing fails falls back to `split_whitespace()` with `ToString`. It returns the resulting token vector and touches no shared state.

**Call relations**: Many tests use this helper to build token arrays from inline shell snippets without having to care whether the snippet is perfectly shell-quoted.

*Call graph*: 1 external calls (split).


##### `tests::vec_str`  (lines 75–77)

```
fn vec_str(args: &[&str]) -> Vec<String>
```

**Purpose**: Converts a borrowed string slice into owned `String` tokens for tests. It avoids repetitive `to_string()` calls in assertions.

**Data flow**: Maps each `&str` in the input slice to `String` and collects into `Vec<String>`. It has no side effects.

**Call relations**: Used by tests that want exact token vectors, especially for shell-wrapper forms like `bash -lc <script>`.


##### `tests::assert_parsed`  (lines 79–82)

```
fn assert_parsed(args: &[String], expected: Vec<ParsedCommand>)
```

**Purpose**: Central test assertion helper that compares parser output against an expected `Vec<ParsedCommand>`. It keeps individual tests focused on the scenario rather than boilerplate.

**Data flow**: Accepts tokenized arguments and an expected parsed vector, calls `parse_command`, and asserts equality with `pretty_assertions::assert_eq!`. It returns unit and writes only to the test assertion machinery.

**Call relations**: Nearly every scenario test delegates through this helper so all parser expectations flow through the public `parse_command` API.

*Call graph*: calls 1 internal fn (parse_command); 1 external calls (assert_eq!).


##### `tests::git_status_is_unknown`  (lines 85–92)

```
fn git_status_is_unknown()
```

**Purpose**: Verifies that unsupported Git subcommands such as `git status` remain opaque rather than being misclassified.

**Data flow**: Builds `['git','status']`, passes it through `assert_parsed`, and expects a single `ParsedCommand::Unknown` with `cmd` equal to `git status`.

**Call relations**: This test exercises the `summarize_main_tokens` Git branch's fallback path through the public parser.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_git_grep_and_ls_files`  (lines 95–133)

```
fn supports_git_grep_and_ls_files()
```

**Purpose**: Checks that supported Git subcommands are recognized as search and file-list operations, including variants with flags and optional paths.

**Data flow**: Creates several tokenized `git grep` and `git ls-files` commands, runs them through `assert_parsed`, and compares against `ParsedCommand::Search` or `ParsedCommand::ListFiles` values with concrete `query` and `path` fields.

**Call relations**: It validates the specialized Git handling inside `summarize_main_tokens`, including delegation to `parse_grep_like` for `git grep`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::handles_git_pipe_wc`  (lines 136–144)

```
fn handles_git_pipe_wc()
```

**Purpose**: Ensures that a shell script containing an unsupported command piped into a formatting helper collapses to a single unknown summary.

**Data flow**: Wraps `git status | wc -l` in `bash -lc`, parses it, and expects one `Unknown` containing the inner script text.

**Call relations**: This test covers shell-wrapper extraction, shell-script parsing, formatting-helper dropping, and the top-level unknown-collapse behavior.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::bash_lc_redirect_not_quoted`  (lines 147–155)

```
fn bash_lc_redirect_not_quoted()
```

**Purpose**: Confirms that shell redirection syntax inside `bash -lc` is not incorrectly summarized as a known operation.

**Data flow**: Parses `bash -lc 'echo foo > bar'` and expects `ParsedCommand::Unknown { cmd: 'echo foo > bar' }`.

**Call relations**: It exercises the shell-script path where parsing succeeds enough to preserve the script text but no known command pattern matches.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::handles_complex_bash_command_head`  (lines 158–167)

```
fn handles_complex_bash_command_head()
```

**Purpose**: Checks that a long compound shell script with multiple connectors and pipelines remains unknown when it cannot be safely reduced to one semantic action.

**Data flow**: Builds a multi-command `bash -lc` script, parses it, and asserts a single `Unknown` containing the full script.

**Call relations**: This validates the conservative behavior of `parse_shell_script` and `parse_command` when many heterogeneous commands appear.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_searching_for_navigate_to_route`  (lines 170–181)

```
fn supports_searching_for_navigate_to_route() -> anyhow::Result<()>
```

**Purpose**: Verifies that quoted ripgrep patterns inside a shell wrapper are normalized into a `Search` summary with the expected query.

**Data flow**: Parses `bash -lc 'rg -n "navigate-to-route" -S'` and expects `ParsedCommand::Search` with `query: Some("navigate-to-route")` and no path.

**Call relations**: It exercises shell unwrapping plus the ripgrep branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::handles_complex_bash_command`  (lines 184–194)

```
fn handles_complex_bash_command()
```

**Purpose**: Ensures a pipeline whose primary stage is a recognizable search command still summarizes as that search even when followed by formatting helpers.

**Data flow**: Parses `bash -lc 'rg -n "BUG|FIXME|TODO|XXX|HACK" -S | head -n 200'` and expects a single `Search` for the regex pattern.

**Call relations**: This covers `drop_small_formatting_commands` and the rule that formatting-only pipeline stages should not obscure the main command.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_rg_files_with_path_and_pipe`  (lines 197–206)

```
fn supports_rg_files_with_path_and_pipe()
```

**Purpose**: Checks that `rg --files` with a path remains a file-list summary even when piped into another command.

**Data flow**: Parses `bash -lc 'rg --files webview/src | sed -n'` and expects `ListFiles` with path shortened to `webview`.

**Call relations**: It validates path shortening and formatting-helper removal in shell-script parsing.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_rg_files_then_head`  (lines 209–218)

```
fn supports_rg_files_then_head()
```

**Purpose**: Verifies that `head` after `rg --files` is treated as a formatting helper and omitted from the summary.

**Data flow**: Parses `bash -lc 'rg --files | head -n 50'` and expects a single `ListFiles` for `rg --files`.

**Call relations**: This specifically exercises `is_small_formatting_command` for `head` and the shell-script filtering pipeline.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::keeps_mutating_xargs_pipeline`  (lines 221–229)

```
fn keeps_mutating_xargs_pipeline()
```

**Purpose**: Ensures that a pipeline ending in mutating `xargs perl -pi` is not dropped as harmless formatting and therefore remains unknown.

**Data flow**: Parses a `bash -lc` pipeline from `rg -l ... | xargs perl -pi -e ...` and expects one `Unknown` containing the full script.

**Call relations**: It validates `is_mutating_xargs_command` and the distinction between formatting helpers and state-changing commands.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::collapses_plain_pipeline_when_any_stage_is_unknown`  (lines 232–242)

```
fn collapses_plain_pipeline_when_any_stage_is_unknown()
```

**Purpose**: Checks the public parser's rule that a mixed pipeline with any unknown stage collapses to one unknown summary.

**Data flow**: Tokenizes a plain pipeline with `rg -l ... | xargs perl -pi ...`, parses it through `parse_command`, and expects `Unknown` with `cmd` equal to `shlex_join(&command)`.

**Call relations**: This test targets the top-level `parse_command` post-processing rather than shell-script parsing.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::collapses_pipeline_with_helper_when_later_stage_is_unknown`  (lines 245–253)

```
fn collapses_pipeline_with_helper_when_later_stage_is_unknown()
```

**Purpose**: Verifies that even if an early stage is known and an intermediate stage is a helper, a later unknown stage forces the whole pipeline to become unknown.

**Data flow**: Parses `rg --files | nl -ba | foo` and expects a single `Unknown` for the whole joined command.

**Call relations**: It combines helper stripping with the conservative unknown-collapse rule in `parse_command`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::rg_files_with_matches_flags_are_search`  (lines 256–297)

```
fn rg_files_with_matches_flags_are_search()
```

**Purpose**: Confirms that ripgrep variants selecting matching or non-matching files are still summarized as searches, not file listings.

**Data flow**: Runs several `rg`/`rga` commands with `-l`, `--files-with-matches`, `-L`, and `--files-without-match`, asserting `Search` outputs with extracted query and path.

**Call relations**: This validates the ripgrep branch's distinction between explicit `--files` listing mode and pattern-search modes.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_cat`  (lines 300–310)

```
fn supports_cat()
```

**Purpose**: Checks that `cat <file>` inside `bash -lc` becomes a `Read` summary with the correct basename and `PathBuf`.

**Data flow**: Parses `bash -lc 'cat webview/README.md'` and expects `Read { name: 'README.md', path: PathBuf::from('webview/README.md') }`.

**Call relations**: It exercises shell unwrapping and the `cat` branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::zsh_lc_supports_cat`  (lines 313–323)

```
fn zsh_lc_supports_cat()
```

**Purpose**: Verifies that Zsh wrappers are treated like Bash wrappers for simple file reads.

**Data flow**: Parses `zsh -lc 'cat README.md'` and expects a `Read` summary for `README.md`.

**Call relations**: This covers `extract_bash_command` support for multiple shell names and the shared shell-script parser.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_bat`  (lines 326–336)

```
fn supports_bat()
```

**Purpose**: Checks that `bat` with option flags and a single file operand is recognized as a file read.

**Data flow**: Parses `bash -lc 'bat --theme TwoDark README.md'` and expects `Read` with `README.md`.

**Call relations**: It validates `single_non_flag_operand` with a command-specific list of flags that consume values.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_batcat`  (lines 339–349)

```
fn supports_batcat()
```

**Purpose**: Verifies that `batcat` is treated the same as `bat` for file-reading summaries.

**Data flow**: Parses `bash -lc 'batcat README.md'` and expects a `Read` summary for that file.

**Call relations**: This exercises the shared `bat`/`batcat` branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_less`  (lines 352–362)

```
fn supports_less()
```

**Purpose**: Checks that `less` with pattern-related flags still resolves to a single file read when exactly one file operand is present.

**Data flow**: Parses `bash -lc 'less -p TODO README.md'` and expects `Read` for `README.md`.

**Call relations**: It validates the `less` branch's flag-skipping logic.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_more`  (lines 365–375)

```
fn supports_more()
```

**Purpose**: Ensures `more <file>` is summarized as a file read.

**Data flow**: Parses `bash -lc 'more README.md'` and expects `Read` with the file path and basename.

**Call relations**: This covers the straightforward `more` branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::cd_then_cat_is_single_read`  (lines 378–387)

```
fn cd_then_cat_is_single_read()
```

**Purpose**: Verifies that a leading `cd` updates the effective working directory for a later read command.

**Data flow**: Parses `cd foo && cat foo.txt` and expects a single `Read` whose `path` is `foo/foo.txt` while the displayed `cmd` remains `cat foo.txt`.

**Call relations**: It exercises `cd_target`, `join_paths`, connector splitting, and the sequence simplification that drops standalone `cd` summaries.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::cd_with_double_dash_then_cat_is_read`  (lines 390–399)

```
fn cd_with_double_dash_then_cat_is_read()
```

**Purpose**: Checks that `cd -- <dir>` correctly treats the operand after `--` as the target directory.

**Data flow**: Parses `cd -- -weird && cat foo.txt` and expects a `Read` with path `-weird/foo.txt`.

**Call relations**: This validates `cd_target` handling of `--` and path joining.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::cd_with_multiple_operands_uses_last`  (lines 402–411)

```
fn cd_with_multiple_operands_uses_last()
```

**Purpose**: Ensures that when multiple non-flag operands appear in `cd`, the parser uses the last one as the effective target.

**Data flow**: Parses `cd dir1 dir2 && cat foo.txt` and expects the resulting read path to be `dir2/foo.txt`.

**Call relations**: It documents the parser's pragmatic `cd_target` heuristic rather than strict shell semantics.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bash_cd_then_bar_is_same_as_bar`  (lines 414–422)

```
fn bash_cd_then_bar_is_same_as_bar()
```

**Purpose**: Checks that a leading `cd` inside a shell wrapper is dropped when followed by an otherwise unknown command.

**Data flow**: Parses `bash -lc 'cd foo && bar'` and expects a single `Unknown` for `cd foo && bar`.

**Call relations**: This covers shell-script parsing plus `simplify_once` removal of `cd` summaries when another command follows.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bash_cd_then_cat_is_read`  (lines 425–434)

```
fn bash_cd_then_cat_is_read()
```

**Purpose**: Verifies `cd` path propagation inside `bash -lc` scripts for file reads.

**Data flow**: Parses `bash -lc 'cd foo && cat foo.txt'` and expects `Read` with path `foo/foo.txt`.

**Call relations**: It exercises the shell-script path's own `cwd` tracking logic.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_ls_with_pipe`  (lines 437–446)

```
fn supports_ls_with_pipe()
```

**Purpose**: Ensures `ls` remains a file-list summary even when piped into a formatting command.

**Data flow**: Parses `bash -lc 'ls -la | sed -n '1,120p''` and expects `ListFiles { cmd: 'ls -la', path: None }`.

**Call relations**: This validates helper stripping and the `ls` branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_eza_exa_tree_du`  (lines 449–478)

```
fn supports_eza_exa_tree_du()
```

**Purpose**: Checks several directory-listing tools and confirms their path extraction and shortening behavior.

**Data flow**: Parses `eza`, `exa`, `tree`, and `du` examples and asserts `ListFiles` outputs with command strings preserved and paths shortened where appropriate.

**Call relations**: It exercises multiple listing branches and command-specific flag-value skipping.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_head_n`  (lines 481–491)

```
fn supports_head_n()
```

**Purpose**: Verifies that `head -n <count> <file>` is treated as reading a file rather than as a formatting helper.

**Data flow**: Parses `bash -lc 'head -n 50 Cargo.toml'` and expects `Read` for `Cargo.toml`.

**Call relations**: This covers the `head` branch's explicit file-detection logic.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_head_file_only`  (lines 494–504)

```
fn supports_head_file_only()
```

**Purpose**: Checks that `head <file>` without an explicit count still becomes a file read.

**Data flow**: Parses `bash -lc 'head Cargo.toml'` and expects `Read` with the file path.

**Call relations**: It validates the fallback single-operand case in the `head` parser.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_cat_sed_n`  (lines 507–517)

```
fn supports_cat_sed_n()
```

**Purpose**: Ensures a `cat` piped into `sed -n` still summarizes as reading the original file.

**Data flow**: Parses `bash -lc 'cat tui/Cargo.toml | sed -n '1,200p''` and expects a `Read` for `tui/Cargo.toml` with the full script as `cmd`.

**Call relations**: This covers the special shell-script rule that preserves the full script text for read pipelines involving `sed -n`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_tail_n_plus`  (lines 520–530)

```
fn supports_tail_n_plus()
```

**Purpose**: Checks that `tail -n +<offset> <file>` is recognized as a file read.

**Data flow**: Parses `bash -lc 'tail -n +522 README.md'` and expects `Read` for `README.md`.

**Call relations**: It validates plus-prefixed numeric parsing in the `tail` branch.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_tail_n_last_lines`  (lines 533–544)

```
fn supports_tail_n_last_lines()
```

**Purpose**: Verifies the standard `tail -n <count> <file>` case through a direct `parse_command` call.

**Data flow**: Parses `bash -lc 'tail -n 30 README.md'`, stores the output, and asserts it equals a one-element `Read` vector.

**Call relations**: This test directly exercises the public parser rather than the shared assertion helper.

*Call graph*: calls 1 internal fn (parse_command); 2 external calls (assert_eq!, vec_str).


##### `tests::supports_tail_file_only`  (lines 547–557)

```
fn supports_tail_file_only()
```

**Purpose**: Checks that `tail <file>` without flags is treated as a file read.

**Data flow**: Parses `bash -lc 'tail README.md'` and expects `Read` for that file.

**Call relations**: It covers the single-operand fallback in the `tail` parser.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_npm_run_build_is_unknown`  (lines 560–567)

```
fn supports_npm_run_build_is_unknown()
```

**Purpose**: Ensures unrelated commands like `npm run build` are left as unknown rather than guessed.

**Data flow**: Parses `['npm','run','build']` and expects one `Unknown` with `cmd: 'npm run build'`.

**Call relations**: This validates the default branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_grep_recursive_current_dir`  (lines 570–579)

```
fn supports_grep_recursive_current_dir()
```

**Purpose**: Checks recursive grep parsing with a current-directory path operand.

**Data flow**: Parses `grep -R CODEX_SANDBOX_ENV_VAR -n .` and expects `Search` with query `CODEX_SANDBOX_ENV_VAR` and path `.`.

**Call relations**: It exercises `parse_grep_like` path and query extraction.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_grep_recursive_specific_file`  (lines 582–597)

```
fn supports_grep_recursive_specific_file()
```

**Purpose**: Verifies that grep against a specific file shortens the path to the basename in the summary.

**Data flow**: Parses `grep -R CODEX_SANDBOX_ENV_VAR -n core/src/spawn.rs` and expects `Search` with path `spawn.rs`.

**Call relations**: This covers `short_display_path` as used by `parse_grep_like`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_egrep_and_fgrep`  (lines 600–617)

```
fn supports_egrep_and_fgrep()
```

**Purpose**: Checks that grep-family aliases are parsed with the same search heuristics.

**Data flow**: Parses `egrep -R TODO src` and `fgrep -l TODO src`, expecting `Search` summaries with query `TODO` and path `src`.

**Call relations**: It validates the shared grep-like branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::grep_files_with_matches_flags_are_search`  (lines 620–653)

```
fn grep_files_with_matches_flags_are_search()
```

**Purpose**: Ensures grep flags that select matching or non-matching files still count as searches.

**Data flow**: Runs several grep variants with `-l`, `--files-with-matches`, `-L`, and `--files-without-match`, asserting `Search` outputs.

**Call relations**: This confirms that `parse_grep_like` ignores these flags when extracting the pattern and path.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_grep_query_with_slashes_not_shortened`  (lines 656–667)

```
fn supports_grep_query_with_slashes_not_shortened()
```

**Purpose**: Verifies that grep patterns containing slashes are preserved verbatim and not mistaken for paths.

**Data flow**: Parses `grep -R src/main.rs -n .` and expects `query: Some('src/main.rs')` with path `.`.

**Call relations**: It documents the deliberate design in `parse_grep_like` to shorten only paths, never grep queries.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_grep_weird_backtick_in_query`  (lines 670–679)

```
fn supports_grep_weird_backtick_in_query()
```

**Purpose**: Checks that unusual grep patterns containing backticks survive quoting and parsing intact.

**Data flow**: Parses `grep -R COD\`EX_SANDBOX -n` and expects a `Search` whose `cmd` is shell-escaped and whose `query` preserves the backtick.

**Call relations**: This exercises `shlex_join` rendering and grep pattern extraction.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_cd_and_rg_files`  (lines 682–690)

```
fn supports_cd_and_rg_files()
```

**Purpose**: Ensures a leading `cd` does not incorrectly alter a pure `rg --files` summary when no explicit path operand exists.

**Data flow**: Parses `cd codex-rs && rg --files` and expects `ListFiles { cmd: 'rg --files', path: None }`.

**Call relations**: It validates that `cwd` tracking only rewrites `Read` paths, not listing/search metadata.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_single_string_script_with_cd_and_pipe`  (lines 693–703)

```
fn supports_single_string_script_with_cd_and_pipe()
```

**Purpose**: Checks a realistic shell script combining `cd`, ripgrep search, and `head`, ensuring the search survives with the right path.

**Data flow**: Parses a `bash -lc` script that changes directory then runs `rg -n "codex_api" codex-rs -S | head -n 50`, expecting a `Search` for query `codex_api` and path `codex-rs`.

**Call relations**: This covers shell-script parsing, helper dropping, and search extraction in one scenario.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_python_walks_files`  (lines 706–715)

```
fn supports_python_walks_files()
```

**Purpose**: Verifies that Python one-liners using filesystem enumeration APIs are summarized as file listings.

**Data flow**: Parses `bash -lc 'python -c "import os; print(os.listdir('.'))"'` and expects `ListFiles` with `cmd` equal to the joined Python command and no path.

**Call relations**: It exercises `is_python_command` and `python_walks_files`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_python3_walks_files`  (lines 718–727)

```
fn supports_python3_walks_files()
```

**Purpose**: Checks the same file-listing heuristic for `python3` and `glob.glob`.

**Data flow**: Parses `bash -lc 'python3 -c "import glob; print(glob.glob('*.rs'))"'` and expects `ListFiles`.

**Call relations**: This validates the broader Python executable matching and script-content detection.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::python_without_file_walk_is_unknown`  (lines 730–738)

```
fn python_without_file_walk_is_unknown()
```

**Purpose**: Ensures arbitrary Python snippets are not over-classified as file listings.

**Data flow**: Parses `bash -lc 'python -c "print('hello')"'` and expects `Unknown` with the joined Python command.

**Call relations**: It covers the negative path of `python_walks_files`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::small_formatting_always_true_commands`  (lines 742–749)

```
fn small_formatting_always_true_commands()
```

**Purpose**: Checks commands that should always be treated as formatting helpers in pipelines.

**Data flow**: Builds token vectors for commands like `wc`, `tr`, `cut`, `sort`, `uniq`, `xargs`, `tee`, and `column`, then asserts `is_small_formatting_command` returns true both with and without a dummy flag.

**Call relations**: This directly tests the helper-filtering predicate used by `parse_shell_script`.

*Call graph*: 1 external calls (assert!).


##### `tests::awk_behavior`  (lines 752–762)

```
fn awk_behavior()
```

**Purpose**: Verifies that `awk` is considered formatting-only unless it clearly reads a data file.

**Data flow**: Asserts `is_small_formatting_command` is true for `awk '{print $1}'` and false when a file operand or `-f` script file plus data file is present.

**Call relations**: It exercises `awk_data_file_operand` and the `awk` branch of the formatting-helper predicate.

*Call graph*: 1 external calls (assert!).


##### `tests::head_behavior`  (lines 765–778)

```
fn head_behavior()
```

**Purpose**: Checks the distinction between `head` as a formatting helper and `head` as a file reader.

**Data flow**: Asserts helper status for `head`, `head -n 40`, and non-helper status for `head -n 40 file.txt` and `head file.txt`.

**Call relations**: This validates the exact shape matching in `is_small_formatting_command` for `head`.

*Call graph*: 1 external calls (assert!).


##### `tests::tail_behavior`  (lines 781–805)

```
fn tail_behavior()
```

**Purpose**: Verifies the analogous helper-versus-reader distinction for `tail`, including `-n`, `-c`, and `+offset` forms.

**Data flow**: Runs several assertions over tokenized `tail` commands, expecting true when no file operand is present and false when a file is explicitly named.

**Call relations**: It tests the `tail` branch of `is_small_formatting_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::sed_behavior`  (lines 808–833)

```
fn sed_behavior()
```

**Purpose**: Checks that `sed` is treated as formatting-only except for valid `sed -n <range> <file>` read patterns.

**Data flow**: Asserts helper status for plain `sed` and invalid range forms, and non-helper status for valid range-plus-file forms including `-e` and `--` variants.

**Call relations**: This directly validates `sed_read_path` and `is_valid_sed_n_arg` through the formatting predicate.

*Call graph*: 1 external calls (assert!).


##### `tests::empty_tokens_is_not_small`  (lines 836–839)

```
fn empty_tokens_is_not_small()
```

**Purpose**: Ensures the formatting-helper predicate rejects empty command vectors.

**Data flow**: Creates an empty `Vec<String>` and asserts `is_small_formatting_command` returns false.

**Call relations**: This covers the guard clause at the top of the helper predicate.

*Call graph*: 2 external calls (new, assert!).


##### `tests::supports_nl_then_sed_reading`  (lines 842–852)

```
fn supports_nl_then_sed_reading()
```

**Purpose**: Verifies that `nl <file> | sed -n ...` still summarizes as reading the original file.

**Data flow**: Parses `bash -lc 'nl -ba core/src/parse_command.rs | sed -n '1200,1720p''` and expects `Read` for `core/src/parse_command.rs`.

**Call relations**: It exercises the `nl` read parser plus the shell-script rule that preserves full script text for `sed -n` pipelines.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_sed_n`  (lines 855–865)

```
fn supports_sed_n()
```

**Purpose**: Checks direct `sed -n <range> <file>` parsing into a file read summary.

**Data flow**: Parses `bash -lc 'sed -n '2000,2200p' tui/src/history_cell.rs'` and expects `Read` with basename `history_cell.rs` and the full path.

**Call relations**: This validates `sed_read_path` as used by `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_awk_with_file`  (lines 868–878)

```
fn supports_awk_with_file()
```

**Purpose**: Ensures `awk` with a data file operand is summarized as reading that file.

**Data flow**: Parses `bash -lc 'awk '{print $1}' Cargo.toml'` and expects `Read` for `Cargo.toml`.

**Call relations**: It exercises `awk_data_file_operand` in the main summarizer.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::filters_out_printf`  (lines 881–892)

```
fn filters_out_printf()
```

**Purpose**: Checks that decorative `printf` stages are dropped so the actual file read remains visible.

**Data flow**: Parses a `bash -lc` script that prints a banner then runs `cat -- ansi-escape/Cargo.toml`, expecting only the `Read` summary for the `cat` command.

**Call relations**: This validates `printf` classification as a small formatting helper and `cat` handling of `--`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::drops_yes_in_pipelines`  (lines 895–905)

```
fn drops_yes_in_pipelines()
```

**Purpose**: Verifies that a leading `yes |` inside a shell wrapper is ignored when summarizing the primary command.

**Data flow**: Parses `bash -lc 'yes | rg --files'` and expects a single `ListFiles` for `rg --files`.

**Call relations**: It covers both `normalize_tokens` and helper dropping for `yes`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_sed_n_then_nl_as_search`  (lines 908–921)

```
fn supports_sed_n_then_nl_as_search()
```

**Purpose**: Ensures a `sed -n <range> <file> | nl -ba` pipeline is still treated as reading the file, not as an unknown or formatting-only sequence.

**Data flow**: Parses the tokenized pipeline and expects `Read` for `exec/src/event_processor_with_human_output.rs` with the `sed -n` command string.

**Call relations**: This validates that `nl` can be dropped while `sed -n` remains the primary read command.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::preserves_rg_with_spaces`  (lines 924–933)

```
fn preserves_rg_with_spaces()
```

**Purpose**: Checks that quoted ripgrep queries containing spaces survive helper stripping and remain intact in the summary.

**Data flow**: Parses `yes | rg -n 'foo bar' -S` and expects `Search` with `query: Some('foo bar')`.

**Call relations**: It combines `yes` dropping with `shlex_join`-based command reconstruction.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::ls_with_glob`  (lines 936–944)

```
fn ls_with_glob()
```

**Purpose**: Verifies that `ls` with an ignore glob but no explicit path is still a file-list summary with no path.

**Data flow**: Parses `ls -I '*.test.js'` and expects `ListFiles { path: None }`.

**Call relations**: This exercises `first_non_flag_operand` with `ls` flags that consume values.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::strips_true_in_sequence`  (lines 947–964)

```
fn strips_true_in_sequence()
```

**Purpose**: Checks that no-op `true` commands are removed from command sequences on either side of a meaningful command.

**Data flow**: Parses `true && rg --files` and `rg --files && true`, expecting only the `ListFiles` summary in both cases.

**Call relations**: It validates `simplify_once` removal of `ParsedCommand::Unknown { cmd: 'true' }`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::strips_true_inside_bash_lc`  (lines 967–985)

```
fn strips_true_inside_bash_lc()
```

**Purpose**: Ensures the same `true` stripping logic applies inside shell-wrapper scripts.

**Data flow**: Parses `bash -lc 'true && rg --files'` and `bash -lc 'rg --files || true'`, expecting only `ListFiles` summaries.

**Call relations**: This covers the shell-script path's reuse of `simplify_once`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::shorten_path_on_windows`  (lines 988–997)

```
fn shorten_path_on_windows()
```

**Purpose**: Verifies that Windows-style backslash paths are preserved in `PathBuf` while the display name is shortened to the basename.

**Data flow**: Parses `cat "pkg\src\main.rs"` and expects `Read` with `name: 'main.rs'` and `path: PathBuf::from(r'pkg\src\main.rs')`.

**Call relations**: It exercises `short_display_path` path normalization and `shlex_join` escaping.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::head_with_no_space`  (lines 1000–1009)

```
fn head_with_no_space()
```

**Purpose**: Checks support for compact `head -n50 <file>` syntax.

**Data flow**: Parses `bash -lc 'head -n50 Cargo.toml'` and expects a `Read` summary.

**Call relations**: This validates the `head` parser's no-space numeric flag handling.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bash_dash_c_pipeline_parsing`  (lines 1012–1022)

```
fn bash_dash_c_pipeline_parsing()
```

**Purpose**: Ensures `bash -c` is handled the same way as `bash -lc` for pipeline summarization.

**Data flow**: Parses `['bash','-c','rg --files | head -n 1']` and expects `ListFiles` for `rg --files`.

**Call relations**: It covers shell-wrapper extraction for both `-c` and `-lc` forms.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::tail_with_no_space`  (lines 1025–1034)

```
fn tail_with_no_space()
```

**Purpose**: Checks support for compact `tail -n+10 <file>` syntax.

**Data flow**: Parses `bash -lc 'tail -n+10 README.md'` and expects `Read` for `README.md`.

**Call relations**: This validates the `tail` parser's no-space plus-offset handling.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::grep_with_query_and_path`  (lines 1037–1046)

```
fn grep_with_query_and_path()
```

**Purpose**: Verifies the basic grep case where both a query and a path are present.

**Data flow**: Parses `grep -R TODO src` and expects `Search` with query `TODO` and path `src`.

**Call relations**: It exercises the standard operand ordering in `parse_grep_like`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_ag_ack_pt_rga`  (lines 1049–1082)

```
fn supports_ag_ack_pt_rga()
```

**Purpose**: Checks additional search tools that should map to the same `Search` summary shape.

**Data flow**: Parses `ag`, `ack`, `pt`, and `rga` examples and expects `Search` outputs with extracted query and path.

**Call relations**: This validates multiple branches in `summarize_main_tokens` that share grep-like semantics.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::ag_ack_pt_files_with_matches_flags_are_search`  (lines 1085–1110)

```
fn ag_ack_pt_files_with_matches_flags_are_search()
```

**Purpose**: Ensures `-l` variants of `ag`, `ack`, and `pt` are still treated as searches.

**Data flow**: Parses each command with `-l TODO src` and expects `Search` summaries.

**Call relations**: It confirms that these tools' parsers ignore file-selection flags when extracting operands.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::rg_with_equals_style_flags`  (lines 1113–1122)

```
fn rg_with_equals_style_flags()
```

**Purpose**: Checks that `--flag=value` ripgrep options are skipped correctly when extracting query and path operands.

**Data flow**: Parses `rg --colors=never -n foo src` and expects `Search` with query `foo` and path `src`.

**Call relations**: This validates `skip_flag_values` behavior for `--flag=value` forms.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::cat_with_double_dash_and_sed_ranges`  (lines 1125–1145)

```
fn cat_with_double_dash_and_sed_ranges()
```

**Purpose**: Verifies two read-specific edge cases: `cat -- <file>` and `sed -n <range> <file>`.

**Data flow**: Parses both commands and expects `Read` summaries with correct names and `PathBuf`s, including a filename beginning with `-`.

**Call relations**: It exercises operand parsing after `--` and valid `sed -n` range detection.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::drop_trailing_nl_in_pipeline`  (lines 1148–1157)

```
fn drop_trailing_nl_in_pipeline()
```

**Purpose**: Checks that a trailing `nl` stage with only flags is dropped from a pipeline summary.

**Data flow**: Parses `rg --files | nl -ba` and expects only `ListFiles { cmd: 'rg --files' }`.

**Call relations**: This validates both helper filtering and `simplify_once` handling of `nl`-only stages.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::ls_with_time_style_and_path`  (lines 1160–1169)

```
fn ls_with_time_style_and_path()
```

**Purpose**: Verifies `ls` path extraction when an equals-style option consumes a value and the path itself shortens to `.`.

**Data flow**: Parses `ls --time-style=long-iso ./dist` and expects `ListFiles` with path `.`.

**Call relations**: It exercises `first_non_flag_operand` plus `short_display_path`'s exclusion of `dist`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::fd_file_finder_variants`  (lines 1172–1190)

```
fn fd_file_finder_variants()
```

**Purpose**: Checks both listing and searching modes for `fd` depending on whether the first positional operand looks path-like.

**Data flow**: Parses `fd -t f src/` expecting `ListFiles` with path `src`, then parses `fd main src` expecting `Search` with query `main` and path `src`.

**Call relations**: This validates `parse_fd_query_and_path` and `is_pathish`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::find_basic_name_filter`  (lines 1193–1202)

```
fn find_basic_name_filter()
```

**Purpose**: Verifies that `find` with a `-name` filter is summarized as a search with both root path and pattern.

**Data flow**: Parses `find . -name '*.rs'` and expects `Search` with query `*.rs` and path `.`.

**Call relations**: It exercises `parse_find_query_and_path`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::find_type_only_path`  (lines 1205–1213)

```
fn find_type_only_path()
```

**Purpose**: Checks that `find` without a name/path/regex filter is treated as a file listing rooted at the given path.

**Data flow**: Parses `find src -type f` and expects `ListFiles` with path `src`.

**Call relations**: This covers the list-only branch after `parse_find_query_and_path` returns no query.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bin_bash_lc_sed`  (lines 1216–1225)

```
fn bin_bash_lc_sed()
```

**Purpose**: Ensures shell-wrapper extraction works even when the shell executable is given as an absolute path.

**Data flow**: Parses `/bin/bash -lc 'sed -n '1,10p' Cargo.toml'` and expects a `Read` summary for `Cargo.toml`.

**Call relations**: It validates `extract_bash_command` integration through `parse_shell_lc_commands`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bin_zsh_lc_sed`  (lines 1227–1236)

```
fn bin_zsh_lc_sed()
```

**Purpose**: Checks the same absolute-path wrapper handling for Zsh.

**Data flow**: Parses `/bin/zsh -lc 'sed -n '1,10p' Cargo.toml'` and expects `Read` for `Cargo.toml`.

**Call relations**: This covers shell-wrapper extraction for path-qualified Zsh executables.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::powershell_command_is_stripped`  (lines 1239–1246)

```
fn powershell_command_is_stripped()
```

**Purpose**: Verifies that PowerShell wrappers are stripped and summarized as the inner script text.

**Data flow**: Parses `['powershell','-Command','Get-ChildItem']` and expects `Unknown { cmd: 'Get-ChildItem' }`.

**Call relations**: It exercises the PowerShell extraction path in `parse_command_impl` and `single_unknown_for_command`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::pwsh_with_noprofile_and_c_alias_is_stripped`  (lines 1249–1256)

```
fn pwsh_with_noprofile_and_c_alias_is_stripped()
```

**Purpose**: Checks PowerShell Core wrapper stripping with extra flags and the `-c` alias.

**Data flow**: Parses `['pwsh','-NoProfile','-c','Write-Host hi']` and expects `Unknown` for the inner script.

**Call relations**: This validates the PowerShell extractor's tolerance for wrapper options.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::powershell_with_path_is_stripped`  (lines 1259–1272)

```
fn powershell_with_path_is_stripped()
```

**Purpose**: Ensures PowerShell extraction also works when the executable is specified by full path on either Windows or non-Windows test hosts.

**Data flow**: Chooses a platform-specific PowerShell executable path, parses it with `-NoProfile -c 'Write-Host hi'`, and expects `Unknown { cmd: 'Write-Host hi' }`.

**Call relations**: It covers path-qualified PowerShell wrapper detection.

*Call graph*: 4 external calls (cfg!, assert_parsed, vec_str, vec!).


##### `parse_command_impl`  (lines 1275–1336)

```
fn parse_command_impl(command: &[String]) -> Vec<ParsedCommand>
```

**Purpose**: Implements the main parsing pipeline that tokenizes, splits, summarizes, tracks `cd`, and simplifies command sequences before the public wrapper applies final deduplication and unknown collapsing.

**Data flow**: Takes `&[String]`. It first tries `parse_shell_lc_commands`; if that succeeds, it returns those parsed commands directly. Otherwise it strips PowerShell wrappers to a single `Unknown`, normalizes tokens with `normalize_tokens`, optionally splits on connectors, then iterates left-to-right over each segment. `cd` segments update a local `cwd: Option<String>` via `cd_target` and `join_paths`; non-`cd` segments are summarized by `summarize_main_tokens`, and `Read` paths are rewritten relative to `cwd`. Finally it repeatedly applies `simplify_once` until no further reduction occurs and returns the resulting `Vec<ParsedCommand>`.

**Call relations**: This is the internal engine behind `parse_command` and another caller that detects skill-doc reads. It delegates shell-wrapper parsing to `parse_shell_lc_commands`, per-command classification to `summarize_main_tokens`, and sequence cleanup to `simplify_once`.

*Call graph*: calls 9 internal fn (cd_target, contains_connectors, join_paths, normalize_tokens, parse_shell_lc_commands, simplify_once, split_on_connectors, summarize_main_tokens, extract_powershell_command); called by 2 (detect_skill_doc_read, parse_command); 3 external calls (from, new, vec!).


##### `simplify_once`  (lines 1338–1394)

```
fn simplify_once(commands: &[ParsedCommand]) -> Option<Vec<ParsedCommand>>
```

**Purpose**: Performs one pass of sequence-level cleanup over parsed commands, removing noise commands that should not appear in summaries.

**Data flow**: Consumes a `&[ParsedCommand]` and returns `Option<Vec<ParsedCommand>>`. It returns `None` when no simplification applies. Otherwise it clones all but one removed element according to four rules: drop a leading `echo ...`, remove any `cd ...` unknown when another command follows, remove any `Unknown { cmd: 'true' }`, or remove `nl` commands whose tokens are only `nl` plus flags.

**Call relations**: Both `parse_command_impl` and `parse_shell_script` call this in a loop until it stabilizes. Its role is to erase shell-control or formatting noise after command-level parsing has already happened.

*Call graph*: called by 2 (parse_command_impl, parse_shell_script); 4 external calls (with_capacity, iter, len, split).


##### `is_valid_sed_n_arg`  (lines 1397–1417)

```
fn is_valid_sed_n_arg(arg: Option<&str>) -> bool
```

**Purpose**: Recognizes the restricted `sed -n` script forms that represent line-range reads rather than arbitrary editing logic.

**Data flow**: Accepts `Option<&str>`, returns false for `None`, then checks whether the string ends with `p` and whether the preceding content is either a single ASCII digit sequence or two comma-separated ASCII digit sequences. It returns a boolean and mutates nothing.

**Call relations**: This helper is used only by `sed_read_path` to decide whether a `sed -n` invocation should be treated as reading a file.

*Call graph*: called by 1 (sed_read_path).


##### `sed_read_path`  (lines 1419–1460)

```
fn sed_read_path(args: &[String]) -> Option<String>
```

**Purpose**: Extracts the file operand from `sed -n <range> <file>`-style commands when they look like read-only line-range requests.

**Data flow**: Takes the `sed` argument tail, trims anything after a connector, and first requires that `-n` be present. It scans for valid range scripts supplied via `-e`/`--expression`, skips script-file flags `-f`/`--file`, and if needed also looks for a positional valid range argument. If no valid range script is found it returns `None`. Otherwise it uses `skip_flag_values` to remove expression/file flag values, filters to non-flag operands, and returns the inferred file path according to whether the first non-flag operand was the range script or the file.

**Call relations**: It is consulted both by `is_small_formatting_command` to keep real file reads from being dropped and by `summarize_main_tokens` to emit `ParsedCommand::Read` for `sed`.

*Call graph*: calls 3 internal fn (is_valid_sed_n_arg, skip_flag_values, trim_at_connector); called by 2 (is_small_formatting_command, summarize_main_tokens); 1 external calls (matches!).


##### `normalize_tokens`  (lines 1465–1482)

```
fn normalize_tokens(cmd: &[String]) -> Vec<String>
```

**Purpose**: Applies lightweight token-level normalization before connector splitting and heuristic parsing.

**Data flow**: Given a token slice, it pattern-matches a few special prefixes. It drops leading `yes |` and `no |`/`n |` by returning the remainder unchanged, and for exact three-token `bash|zsh -c|-lc <script>` forms it re-tokenizes the script with `shlex_split`, falling back to the original wrapper tokens if splitting fails. All other inputs are cloned unchanged.

**Call relations**: This is an early preprocessing step used only by `parse_command_impl` for non-AST parsing paths.

*Call graph*: called by 1 (parse_command_impl); 1 external calls (split).


##### `contains_connectors`  (lines 1484–1488)

```
fn contains_connectors(tokens: &[String]) -> bool
```

**Purpose**: Detects whether a token vector contains shell sequencing or pipeline connectors that should split parsing into multiple segments.

**Data flow**: Scans `&[String]` for any token equal to `&&`, `||`, `|`, or `;` and returns a boolean.

**Call relations**: Used by `parse_command_impl` to decide whether to call `split_on_connectors` or treat the whole token vector as one command.

*Call graph*: called by 1 (parse_command_impl).


##### `split_on_connectors`  (lines 1490–1506)

```
fn split_on_connectors(tokens: &[String]) -> Vec<Vec<String>>
```

**Purpose**: Splits a flat token stream into command segments separated by shell connectors while discarding the connector tokens themselves.

**Data flow**: Iterates over `&[String]`, accumulating cloned tokens into a current segment. On `&&`, `||`, `|`, or `;`, it pushes the current segment if non-empty and starts a new one. After the loop it pushes any trailing segment and returns `Vec<Vec<String>>`.

**Call relations**: This is the fallback sequence splitter used by `parse_command_impl` when shell AST parsing is not available.

*Call graph*: called by 1 (parse_command_impl); 2 external calls (new, take).


##### `trim_at_connector`  (lines 1508–1514)

```
fn trim_at_connector(tokens: &[String]) -> Vec<String>
```

**Purpose**: Returns only the prefix of a token slice before the first shell connector.

**Data flow**: Finds the first `|`, `&&`, `||`, or `;` token and clones the slice up to that index; if none exists, it clones the whole slice.

**Call relations**: Many operand-extraction helpers call this so they only inspect the current command stage rather than later pipeline or sequence stages.

*Call graph*: called by 7 (awk_data_file_operand, parse_fd_query_and_path, parse_find_query_and_path, parse_grep_like, python_walks_files, sed_read_path, summarize_main_tokens).


##### `short_display_path`  (lines 1521–1532)

```
fn short_display_path(path: &str) -> String
```

**Purpose**: Produces a concise display string for a path by normalizing separators and dropping unhelpful trailing directory names.

**Data flow**: Takes `&str`, replaces backslashes with `/`, trims trailing `/`, then walks path components from the end while skipping empty parts and the names `build`, `dist`, `node_modules`, and `src`. It returns the first remaining component, or the trimmed original path if nothing better exists.

**Call relations**: This helper is used throughout command summarization to populate human-friendly `path` and `name` fields without losing the full `PathBuf` stored for reads.

*Call graph*: called by 3 (parse_fd_query_and_path, parse_find_query_and_path, summarize_main_tokens).


##### `skip_flag_values`  (lines 1535–1564)

```
fn skip_flag_values(args: &'a [String], flags_with_vals: &[&str]) -> Vec<&'a String>
```

**Purpose**: Filters an argument list so positional-operand extraction can ignore flags that consume following values and `--flag=value` forms.

**Data flow**: Accepts `&[String]` plus a list of flag names that take values. It iterates once, skipping the next token after any matching flag, dropping any `--flag=value` token entirely, and treating `--` as the start of pure positional operands that are all retained. It returns `Vec<&String>` referencing the original arguments.

**Call relations**: Several parsers use this helper before collecting non-flag operands, especially for commands with many option forms like `rg`, `fd`, `awk`, and `sed`.

*Call graph*: called by 4 (awk_data_file_operand, parse_fd_query_and_path, sed_read_path, summarize_main_tokens); 1 external calls (new).


##### `first_non_flag_operand`  (lines 1566–1571)

```
fn first_non_flag_operand(args: &[String], flags_with_vals: &[&str]) -> Option<String>
```

**Purpose**: Returns the first positional operand after removing flags and their values.

**Data flow**: Delegates to `positional_operands`, takes the first element if any, clones it into a new `String`, and returns `Option<String>`.

**Call relations**: Used by listing-command parsers in `summarize_main_tokens` when they want at most one path operand.

*Call graph*: calls 1 internal fn (positional_operands); called by 1 (summarize_main_tokens).


##### `single_non_flag_operand`  (lines 1573–1580)

```
fn single_non_flag_operand(args: &[String], flags_with_vals: &[&str]) -> Option<String>
```

**Purpose**: Returns the sole positional operand only when exactly one exists.

**Data flow**: Calls `positional_operands`, takes the first operand, and returns `None` if a second operand exists; otherwise it clones and returns the single operand.

**Call relations**: Read-command parsers use this to avoid misclassifying commands that mention multiple files or extra operands.

*Call graph*: calls 1 internal fn (positional_operands); called by 1 (summarize_main_tokens).


##### `positional_operands`  (lines 1582–1614)

```
fn positional_operands(args: &'a [String], flags_with_vals: &[&str]) -> Vec<&'a String>
```

**Purpose**: Extracts positional operands from an argument list while respecting `--`, skipping flags, and skipping values consumed by selected flags.

**Data flow**: Iterates over `&[String]` with state for `after_double_dash` and `skip_next`. Before `--`, it ignores `--flag=value`, skips configured flag-value pairs, and drops any token starting with `-`; after `--`, it keeps everything. It returns `Vec<&String>` referencing the original slice.

**Call relations**: This is the shared low-level operand extractor behind `first_non_flag_operand` and `single_non_flag_operand`.

*Call graph*: called by 2 (first_non_flag_operand, single_non_flag_operand); 1 external calls (new).


##### `parse_grep_like`  (lines 1616–1671)

```
fn parse_grep_like(main_cmd: &[String], args: &[String]) -> ParsedCommand
```

**Purpose**: Parses grep-family commands into a `ParsedCommand::Search`, extracting the pattern and optional path while preserving grep-specific semantics.

**Data flow**: Takes the full command tokens and the argument tail. It trims at connectors, scans arguments while honoring `--`, captures the first explicit pattern from `-e/--regexp` or `-f/--file`, skips value-taking flags like `-m`, `-C`, `-A`, and `-B`, and collects remaining non-flag operands. It then chooses the query from the explicit pattern or first operand, chooses the path from the next operand when appropriate, shortens only the path with `short_display_path`, and returns `ParsedCommand::Search { cmd: shlex_join(main_cmd), query, path }`.

**Call relations**: This helper is called by `summarize_main_tokens` for `grep`, `egrep`, `fgrep`, and `git grep`. Its design intentionally avoids shortening slash-containing grep patterns.

*Call graph*: calls 2 internal fn (shlex_join, trim_at_connector); called by 1 (summarize_main_tokens); 1 external calls (new).


##### `awk_data_file_operand`  (lines 1673–1696)

```
fn awk_data_file_operand(args: &[String]) -> Option<String>
```

**Purpose**: Determines whether an `awk` invocation includes a data file operand and, if so, returns that file path.

**Data flow**: Takes the `awk` argument tail, trims at connectors, checks whether a script file flag `-f/--file` is present, then uses `skip_flag_values` to ignore field-separator, variable-assignment, and script-file options. It filters to non-flag candidates and returns either the first non-flag operand after a script file or the second non-flag operand in the inline-script case.

**Call relations**: Used both by `is_small_formatting_command` to decide whether `awk` is just a pipeline helper and by `summarize_main_tokens` to emit `Read` for file-reading `awk` commands.

*Call graph*: calls 2 internal fn (skip_flag_values, trim_at_connector); called by 2 (is_small_formatting_command, summarize_main_tokens).


##### `python_walks_files`  (lines 1698–1715)

```
fn python_walks_files(args: &[String]) -> bool
```

**Purpose**: Heuristically detects Python `-c` snippets that enumerate files or directories.

**Data flow**: Trims the argument list at connectors, scans for `-c`, and if present inspects the following script string for substrings such as `os.walk`, `os.listdir`, `os.scandir`, `glob.glob`, `glob.iglob`, `pathlib.Path`, or `.rglob(`. It returns true if any marker is found.

**Call relations**: This helper is used by `summarize_main_tokens` after `is_python_command` identifies a Python executable.

*Call graph*: calls 1 internal fn (trim_at_connector); called by 1 (summarize_main_tokens).


##### `is_python_command`  (lines 1717–1723)

```
fn is_python_command(cmd: &str) -> bool
```

**Purpose**: Recognizes Python executable names that should be eligible for Python-specific heuristics.

**Data flow**: Checks a command name string against exact names `python`, `python2`, `python3` and versioned prefixes `python2.` and `python3.`. It returns a boolean.

**Call relations**: Called only by `summarize_main_tokens` before applying `python_walks_files`.

*Call graph*: called by 1 (summarize_main_tokens).


##### `cd_target`  (lines 1725–1748)

```
fn cd_target(args: &[String]) -> Option<String>
```

**Purpose**: Extracts the effective target directory from a `cd` command using permissive heuristics.

**Data flow**: Scans the `cd` argument slice left-to-right. If it sees `--`, it returns the following token immediately. It skips `-L`, `-P`, and any other dash-prefixed options, and otherwise keeps updating `target` with each non-flag operand so the last one wins. It returns `Option<String>`.

**Call relations**: Both `parse_command_impl` and `parse_shell_script` use this to maintain an inferred current working directory across command sequences.

*Call graph*: called by 2 (parse_command_impl, parse_shell_script); 1 external calls (matches!).


##### `is_pathish`  (lines 1750–1757)

```
fn is_pathish(s: &str) -> bool
```

**Purpose**: Heuristically decides whether a token looks more like a filesystem path than a search query.

**Data flow**: Returns true for `.`, `..`, strings starting with `./` or `../`, or any string containing `/` or `\`; otherwise false.

**Call relations**: Used by `parse_fd_query_and_path` to distinguish `fd <path>` listing mode from `fd <query> <path>` search mode.

*Call graph*: called by 1 (parse_fd_query_and_path).


##### `parse_fd_query_and_path`  (lines 1759–1790)

```
fn parse_fd_query_and_path(tail: &[String]) -> (Option<String>, Option<String>)
```

**Purpose**: Extracts the query and path semantics from `fd` commands, which can act as either file listers or searchers.

**Data flow**: Trims at connectors, removes values consumed by flags like `-t`, `-e`, `-E`, and `--search-path` via `skip_flag_values`, then collects non-flag operands. With one operand, it returns `(None, Some(path))` if `is_pathish` says it looks like a path, otherwise `(Some(query), None)`. With two or more operands, it returns the first as query and the second as shortened path.

**Call relations**: Called by `summarize_main_tokens`, which turns its tuple into either `ParsedCommand::ListFiles` or `ParsedCommand::Search`.

*Call graph*: calls 4 internal fn (is_pathish, short_display_path, skip_flag_values, trim_at_connector); called by 1 (summarize_main_tokens).


##### `parse_find_query_and_path`  (lines 1792–1816)

```
fn parse_find_query_and_path(tail: &[String]) -> (Option<String>, Option<String>)
```

**Purpose**: Extracts a root path and common name/path/regex filter from `find` commands.

**Data flow**: Trims at connectors, scans for the first non-flag token that is not `!`, `(`, or `)` to use as the shortened root path, then scans for `-name`, `-iname`, `-path`, or `-regex` and captures the following token as the query. It returns `(Option<String>, Option<String>)`.

**Call relations**: Used by `summarize_main_tokens` to decide whether a `find` command is better summarized as a search or a file listing.

*Call graph*: calls 2 internal fn (short_display_path, trim_at_connector); called by 1 (summarize_main_tokens).


##### `parse_shell_lc_commands`  (lines 1818–1822)

```
fn parse_shell_lc_commands(original: &[String]) -> Option<Vec<ParsedCommand>>
```

**Purpose**: Detects Bash-compatible shell wrappers and parses their embedded script text using the shell-script parser.

**Data flow**: Accepts the original token vector, calls `extract_bash_command`, and if successful passes the extracted script to `parse_shell_script`, wrapping the result in `Some`. If no Bash-compatible wrapper is found, it returns `None`.

**Call relations**: This is the first branch in `parse_command_impl`, giving shell-script parsing priority over flat token heuristics.

*Call graph*: calls 2 internal fn (extract_bash_command, parse_shell_script); called by 1 (parse_command_impl).


##### `parse_shell_script`  (lines 1825–1951)

```
fn parse_shell_script(script: &str) -> Vec<ParsedCommand>
```

**Purpose**: Parses a Bash-compatible script string into one or more `ParsedCommand` summaries using AST-based command extraction plus the same heuristics used for flat token parsing.

**Data flow**: Takes `&str` script text. It first tries `try_parse_shell` and `try_parse_word_only_commands_sequence`; if either fails or yields no commands, it returns a one-element `Unknown` vector containing the original script. Otherwise it tokenizes the script with `shlex_split`, notes whether multiple commands existed, drops small formatting helpers with `drop_small_formatting_commands`, and if that empties the list returns `Unknown`. It then walks the remaining command token vectors in source order, tracking `cwd` via `cd_target` and `join_paths`, summarizing each with `summarize_main_tokens`, and rewriting `Read` paths relative to `cwd`. For multi-command results it removes `true` unknowns and repeatedly applies `simplify_once`. If exactly one command remains, it may rewrite that command's `cmd` field: for connector-free scripts it uses the joined script tokens; for pipelines it usually keeps only the primary command, except `Read` pipelines involving `sed -n`, where it preserves the full original script string for clearer UX. It returns the final `Vec<ParsedCommand>`.

**Call relations**: Called by `parse_shell_lc_commands` and another command-analysis path for memory usage kinds. It is the richer parsing path that uses shell AST extraction before falling back to the same summarization helpers as `parse_command_impl`.

*Call graph*: calls 7 internal fn (try_parse_shell, try_parse_word_only_commands_sequence, cd_target, drop_small_formatting_commands, join_paths, simplify_once, summarize_main_tokens); called by 2 (memories_usage_kinds_from_command, parse_shell_lc_commands); 4 external calls (from, new, split, vec!).


##### `is_small_formatting_command`  (lines 1956–2023)

```
fn is_small_formatting_command(tokens: &[String]) -> bool
```

**Purpose**: Classifies commands that are usually harmless formatting or display helpers so they can be dropped from shell-script summaries.

**Data flow**: Accepts a token slice and returns false for empty input. It then matches on the command name: always true for helpers like `wc`, `tr`, `cut`, `sort`, `uniq`, `tee`, `column`, `yes`, and `printf`; true for `xargs` only when `is_mutating_xargs_command` is false; true for `awk` when `awk_data_file_operand` finds no data file; true for `head` and `tail` only in no-file forms; and true for `sed` only when `sed_read_path` returns `None`. It returns a boolean and mutates nothing.

**Call relations**: Used by `drop_small_formatting_commands` and tested extensively because it strongly influences which pipeline stage becomes the user-visible summary.

*Call graph*: calls 3 internal fn (awk_data_file_operand, is_mutating_xargs_command, sed_read_path).


##### `is_mutating_xargs_command`  (lines 2025–2027)

```
fn is_mutating_xargs_command(tokens: &[String]) -> bool
```

**Purpose**: Determines whether an `xargs` pipeline stage invokes a mutating subcommand that should not be discarded as formatting noise.

**Data flow**: Calls `xargs_subcommand` to extract the delegated command after `xargs` options, then returns whether that subcommand satisfies `xargs_is_mutating_subcommand`.

**Call relations**: This helper is only used by `is_small_formatting_command` to keep dangerous `xargs` stages visible.

*Call graph*: calls 1 internal fn (xargs_subcommand); called by 1 (is_small_formatting_command).


##### `xargs_subcommand`  (lines 2029–2053)

```
fn xargs_subcommand(tokens: &[String]) -> Option<&[String]>
```

**Purpose**: Extracts the subcommand that `xargs` will execute after skipping `xargs`' own options.

**Data flow**: Checks that the first token is `xargs`, then scans subsequent tokens. It returns the slice after `--`, or the first non-option token onward, while skipping values consumed by short options like `-E`, `-e`, `-I`, `-L`, `-n`, `-P`, and `-s`. If no subcommand is found, it returns `None`.

**Call relations**: Called by `is_mutating_xargs_command` as the first step in analyzing whether an `xargs` stage is safe to drop.

*Call graph*: called by 1 (is_mutating_xargs_command); 1 external calls (matches!).


##### `xargs_is_mutating_subcommand`  (lines 2055–2065)

```
fn xargs_is_mutating_subcommand(tokens: &[String]) -> bool
```

**Purpose**: Recognizes mutating subcommands commonly used under `xargs`, such as in-place editors or replacement operations.

**Data flow**: Takes a token slice for the delegated subcommand, splits off the head command, and returns true for `perl` or `ruby` when `xargs_has_in_place_flag` finds in-place flags, for `sed` when in-place flags or `--in-place` are present, and for `rg` when `--replace` appears. Otherwise it returns false.

**Call relations**: This helper is reached only through `is_mutating_xargs_command` after `xargs_subcommand` has isolated the delegated command.

*Call graph*: calls 1 internal fn (xargs_has_in_place_flag).


##### `xargs_has_in_place_flag`  (lines 2067–2071)

```
fn xargs_has_in_place_flag(tokens: &[String]) -> bool
```

**Purpose**: Detects in-place editing flags in a delegated command's argument list.

**Data flow**: Scans tokens and returns true if any token equals or starts with `-i` or `-pi`, covering compact forms like `-pi` and attached suffixes.

**Call relations**: Used by `xargs_is_mutating_subcommand` for `perl`, `ruby`, and `sed` mutation detection.

*Call graph*: called by 1 (xargs_is_mutating_subcommand).


##### `drop_small_formatting_commands`  (lines 2073–2076)

```
fn drop_small_formatting_commands(mut commands: Vec<Vec<String>>) -> Vec<Vec<String>>
```

**Purpose**: Removes formatting-helper command stages from a shell-script command sequence.

**Data flow**: Takes ownership of `Vec<Vec<String>>`, retains only those token vectors for which `is_small_formatting_command` is false, and returns the filtered vector.

**Call relations**: Called by `parse_shell_script` before semantic summarization so pipelines focus on primary actions rather than display helpers.

*Call graph*: called by 1 (parse_shell_script).


##### `summarize_main_tokens`  (lines 2078–2503)

```
fn summarize_main_tokens(main_cmd: &[String]) -> ParsedCommand
```

**Purpose**: Maps one command token vector to a concrete `ParsedCommand` by applying command-specific heuristics for listing, searching, reading, Python file walks, or unknown commands.

**Data flow**: Accepts `&[String]`, pattern-matches on the first token, and constructs one of the `ParsedCommand` variants. Listing branches handle `ls`/`eza`/`exa`, `tree`, `du`, `rg --files`, `git ls-files`, `fd` without query, and `find` without filter. Search branches handle `rg`/`rga`, `grep`/`egrep`/`fgrep`, `git grep`, `ag`/`ack`/`pt`, `fd` with query, and `find` with `-name`/`-path`/`-regex`. Read branches handle `cat`, `bat`/`batcat`, `less`, `more`, `head`, `tail`, `awk` with data file, `nl` with file operand, and `sed -n` with valid range. Python commands become `ListFiles` only when `python_walks_files` returns true. Every known branch uses `shlex_join` for the `cmd` field and `short_display_path` for display names or paths while preserving full `PathBuf`s for reads; unmatched commands become `ParsedCommand::Unknown`.

**Call relations**: This is the central per-command classifier used by both `parse_command_impl` and `parse_shell_script`. It delegates operand extraction to many small helpers so each command family can be parsed with command-specific rules.

*Call graph*: calls 13 internal fn (awk_data_file_operand, first_non_flag_operand, is_python_command, parse_fd_query_and_path, parse_find_query_and_path, parse_grep_like, python_walks_files, sed_read_path, shlex_join, short_display_path (+3 more)); called by 2 (parse_command_impl, parse_shell_script); 3 external calls (from, new, matches!).


##### `is_abs_like`  (lines 2505–2518)

```
fn is_abs_like(path: &str) -> bool
```

**Purpose**: Determines whether a path string should be treated as absolute, including Windows-specific forms not always covered by generic path checks.

**Data flow**: Checks `std::path::Path::new(path).is_absolute()`, then manually recognizes drive-letter paths like `C:\...` and UNC paths beginning with `\\`. It returns a boolean.

**Call relations**: Used only by `join_paths` to avoid incorrectly prefixing an already absolute path with the current working directory.

*Call graph*: called by 1 (join_paths); 1 external calls (new).


##### `join_paths`  (lines 2520–2530)

```
fn join_paths(base: &str, rel: &str) -> String
```

**Purpose**: Combines an inferred current directory with a relative path while preserving absolute paths unchanged.

**Data flow**: Takes `base` and `rel` as `&str`. If `rel` is absolute according to `is_abs_like`, it returns `rel.to_string()`. If `base` is empty, it returns `rel.to_string()`. Otherwise it pushes `rel` onto a `PathBuf` built from `base` and returns the lossy string form.

**Call relations**: Both sequence parsers use this helper when a prior `cd` should affect the full path stored in a later `ParsedCommand::Read`.

*Call graph*: calls 1 internal fn (is_abs_like); called by 2 (parse_command_impl, parse_shell_script); 1 external calls (from).


### Command safety classification
These files organize and implement cross-platform safe and dangerous command detection, including the PowerShell AST helper used on Windows.

### `shell-command/src/command_safety/mod.rs`

`orchestration` · `command validation`

This module file wires together the command-safety portion of the shell-command crate. It declares the private `powershell_parser` implementation module, publicly exposes the `is_dangerous_command` and `is_safe_command` modules that contain the actual classification logic, and conditionally includes `windows_safe_commands` only on Windows builds. That conditional compilation is significant: Windows-specific allowlists or heuristics are kept out of non-Windows targets entirely.

The file also re-exports `try_parse_powershell_ast_commands` with crate visibility, making the parser helper available to sibling modules inside the crate without publishing it as part of the external API. This suggests a layered design where safety checks can attempt structured parsing of PowerShell input before falling back to simpler token or string heuristics.

Because there are no functions here, its role is purely structural: it defines which pieces belong to the command-safety subsystem, what is public to downstream crates, and what remains an internal implementation detail. Readers should treat this file as the namespace and compilation boundary for shell safety analysis rather than as a place where policy decisions are implemented directly.


### `shell-command/src/command_safety/powershell_parser.rs`

`io_transport` · `Windows command parsing during safety checks`

This file provides the AST-backed parsing substrate used by Windows safe-command classification. The bundled `powershell_parser.ps1` script is embedded at compile time, UTF-16LE encoded, base64-wrapped, and launched via `-EncodedCommand` in a child `powershell.exe` or `pwsh.exe` process. Because PowerShell startup is expensive, parser children are cached in a global `LazyLock<Mutex<HashMap<String, PowershellParserProcess>>>`, keyed by executable path so `powershell.exe` and `pwsh.exe` maintain separate parser streams.

`parse_with_powershell_ast` locks the cache and delegates to `parse_with_cached_process`, which lazily spawns a parser process, sends one JSON request containing a monotonic request id and base64-encoded script payload, reads one response line, deserializes it, verifies the response id matches the request, and converts the response into `PowershellParseOutcome`. If a cached child has died or its stdio is broken, the code removes it and retries once with a fresh child before returning `Failed`.

`PowershellParserResponse::into_outcome` is intentionally strict: `ok` responses must contain a non-empty command list where every command and every word is non-empty, otherwise the result is downgraded to `Unsupported`. Child setup also validates that stdin and stdout pipes were actually exposed; if not, the partially spawned child is killed immediately. `Drop` for `PowershellParserProcess` always kills and waits on the child to avoid leaks. Windows-only tests verify multi-request reuse and rejection of stop-parsing forms.

#### Function details

##### `parse_with_powershell_ast`  (lines 27–35)

```
fn parse_with_powershell_ast(executable: &str, script: &str) -> PowershellParseOutcome
```

**Purpose**: Top-level entry point for parsing a PowerShell script through the cached helper-process infrastructure. It ensures parser processes are reused across calls for the same executable.

**Data flow**: It takes an executable path `&str` and script `&str`, locks the global `HashMap<String, PowershellParserProcess>` inside a `Mutex`, recovering from poisoning with `PoisonError::into_inner`, then passes the mutable cache plus inputs to `parse_with_cached_process` and returns the resulting `PowershellParseOutcome`.

**Call relations**: It is called by `try_parse_powershell_ast_commands` and by higher-level PowerShell parsing code. It delegates all cache and process management details to `parse_with_cached_process`.

*Call graph*: calls 1 internal fn (parse_with_cached_process); called by 2 (try_parse_powershell_ast_commands, parse_powershell_script); 1 external calls (new).


##### `try_parse_powershell_ast_commands`  (lines 37–45)

```
fn try_parse_powershell_ast_commands(
    executable: &str,
    script: &str,
) -> Option<Vec<Vec<String>>>
```

**Purpose**: Convenience wrapper that returns parsed command vectors only when the parser outcome is a successful `Commands` result. Unsupported or failed parses are collapsed to `None`.

**Data flow**: It takes an executable path and script, calls `parse_with_powershell_ast`, matches the returned `PowershellParseOutcome`, and returns `Some(Vec<Vec<String>>)` only for the `Commands` variant.

**Call relations**: It is the simpler optional API layered on top of the richer outcome enum.

*Call graph*: calls 1 internal fn (parse_with_powershell_ast).


##### `parse_with_cached_process`  (lines 54–89)

```
fn parse_with_cached_process(
    parser_processes: &mut HashMap<String, PowershellParserProcess>,
    executable: &str,
    script: &str,
) -> PowershellParseOutcome
```

**Purpose**: Maintains one parser child per executable path, spawning lazily and retrying once if a cached child becomes unusable. It is the core request/response orchestration function.

**Data flow**: It takes a mutable parser-process map, an executable path, and a script. It builds a string cache key from the executable, loops for up to two attempts, spawns a `PowershellParserProcess` if the key is absent, fetches the mutable process, calls `parser_process.parse(script)`, returns the outcome on success, removes the cached process and retries once on I/O failure, and otherwise returns `PowershellParseOutcome::Failed`.

**Call relations**: It is called only by `parse_with_powershell_ast`. It delegates child creation to `PowershellParserProcess::spawn` and per-request protocol handling to `PowershellParserProcess::parse`.

*Call graph*: calls 1 internal fn (spawn); called by 1 (parse_with_powershell_ast).


##### `encode_powershell_base64`  (lines 91–97)

```
fn encode_powershell_base64(script: &str) -> String
```

**Purpose**: Encodes a PowerShell script string into the UTF-16LE base64 form expected by PowerShell’s `-EncodedCommand` and by the parser protocol payload. This matches native PowerShell command encoding semantics.

**Data flow**: It takes a script `&str`, allocates a `Vec<u8>` sized for UTF-16 bytes, iterates `encode_utf16()`, appends each code unit’s little-endian bytes, base64-encodes the resulting byte vector, and returns the encoded `String`.

**Call relations**: It is used both to pre-encode the bundled parser script and to encode each script payload sent to the helper process.

*Call graph*: called by 1 (parse); 1 external calls (with_capacity).


##### `encoded_parser_script`  (lines 99–103)

```
fn encoded_parser_script() -> &'static str
```

**Purpose**: Lazily computes and caches the base64-encoded bundled parser script. This avoids re-encoding the static script on every parser spawn.

**Data flow**: It takes no arguments, initializes a `LazyLock<String>` by calling `encode_powershell_base64(POWERSHELL_PARSER_SCRIPT)` on first use, and returns a shared `&'static str` reference to the cached encoded script.

**Call relations**: It is called by `PowershellParserProcess::spawn` when launching the helper child.

*Call graph*: called by 1 (spawn); 1 external calls (new).


##### `PowershellParserProcess::spawn`  (lines 115–148)

```
fn spawn(executable: &str) -> std::io::Result<Self>
```

**Purpose**: Launches a PowerShell child process running the bundled parser script and captures its stdin/stdout for the JSON protocol. It validates pipe availability and cleans up on partial setup failure.

**Data flow**: It takes an executable path `&str`, builds a `Command` with `-NoLogo`, `-NoProfile`, `-NonInteractive`, and `-EncodedCommand <encoded_parser_script()>`, configures piped stdin/stdout and null stderr, spawns the child, extracts `ChildStdin` with `take_child_stdin`, extracts `ChildStdout` wrapped in `BufReader` with `take_child_stdout`, kills the child if either extraction fails, and returns a `PowershellParserProcess` with `next_request_id` initialized to 0.

**Call relations**: It is called by `parse_with_cached_process` on cache misses and directly by Windows tests. It delegates cleanup to `kill_child` and pipe extraction to dedicated helpers.

*Call graph*: calls 4 internal fn (encoded_parser_script, kill_child, take_child_stdin, take_child_stdout); called by 3 (parse_with_cached_process, parser_process_handles_multiple_requests, parser_process_rejects_stop_parsing_forms); 3 external calls (null, piped, new).


##### `PowershellParserProcess::parse`  (lines 150–184)

```
fn parse(&mut self, script: &str) -> std::io::Result<PowershellParseOutcome>
```

**Purpose**: Sends one script parse request to the helper child and reads back one structured response. It also detects protocol desynchronization via request ids.

**Data flow**: It takes `&mut self` and a script `&str`, builds a `PowershellParserRequest` with the current `next_request_id` and base64-encoded payload, increments `next_request_id` with wrapping arithmetic, serializes the request to JSON with `serialize_request`, appends a newline, writes and flushes it to child stdin, reads one line from child stdout, errors on EOF, deserializes the line with `deserialize_response`, verifies `response.id == request.id`, converts the response with `into_outcome`, and returns the outcome or an I/O error.

**Call relations**: It is the per-request worker used by `parse_with_cached_process`. Its error results are what trigger cache eviction and one retry in the caller.

*Call graph*: calls 3 internal fn (deserialize_response, encode_powershell_base64, serialize_request); 6 external calls (read_line, flush, write_all, new, new, format!).


##### `PowershellParserProcess::drop`  (lines 188–190)

```
fn drop(&mut self)
```

**Purpose**: Ensures the helper child process is terminated when the parser-process wrapper is dropped. This prevents leaked background parser processes.

**Data flow**: It takes `&mut self`, calls `kill_child(&mut self.child)`, and returns nothing.

**Call relations**: It runs automatically when cached parser processes are removed or when the cache is dropped at process shutdown.

*Call graph*: calls 1 internal fn (kill_child).


##### `take_child_stdin`  (lines 193–200)

```
fn take_child_stdin(child: &mut Child) -> std::io::Result<ChildStdin>
```

**Purpose**: Extracts the child process stdin pipe or returns a broken-pipe error if it was not configured. It turns an optional handle into a checked invariant.

**Data flow**: It takes `&mut Child`, calls `child.stdin.take()`, and returns `Ok(ChildStdin)` if present or a `std::io::Error` with `ErrorKind::BrokenPipe` otherwise.

**Call relations**: It is used during `PowershellParserProcess::spawn` before the process is considered usable.

*Call graph*: called by 1 (spawn).


##### `take_child_stdout`  (lines 202–209)

```
fn take_child_stdout(child: &mut Child) -> std::io::Result<BufReader<ChildStdout>>
```

**Purpose**: Extracts the child process stdout pipe and wraps it in a buffered reader, or returns a broken-pipe error if stdout was unavailable. This prepares line-oriented protocol reads.

**Data flow**: It takes `&mut Child`, calls `child.stdout.take()`, maps the handle into `BufReader<ChildStdout>`, and returns an `ErrorKind::BrokenPipe` error if absent.

**Call relations**: It is the stdout counterpart to `take_child_stdin`, used during parser-process spawn.

*Call graph*: called by 1 (spawn).


##### `serialize_request`  (lines 211–218)

```
fn serialize_request(request: &PowershellParserRequest) -> std::io::Result<String>
```

**Purpose**: Serializes a parser request struct to JSON and converts serialization failures into `std::io::Error`. This keeps the parser protocol on one error type.

**Data flow**: It takes a `&PowershellParserRequest`, calls `serde_json::to_string`, and returns either the JSON `String` or an `ErrorKind::InvalidData` I/O error containing the serialization message.

**Call relations**: It is called by `PowershellParserProcess::parse` before writing a request to child stdin.

*Call graph*: called by 1 (parse); 1 external calls (to_string).


##### `deserialize_response`  (lines 220–227)

```
fn deserialize_response(response_line: &str) -> std::io::Result<PowershellParserResponse>
```

**Purpose**: Parses one JSON response line from the helper child and converts parse failures into `std::io::Error`. This mirrors `serialize_request` on the receive side.

**Data flow**: It takes a response line `&str`, calls `serde_json::from_str` into `PowershellParserResponse`, and returns either the parsed struct or an `ErrorKind::InvalidData` I/O error.

**Call relations**: It is called by `PowershellParserProcess::parse` after reading one line from child stdout.

*Call graph*: called by 1 (parse); 1 external calls (from_str).


##### `PowershellParserResponse::into_outcome`  (lines 244–259)

```
fn into_outcome(self) -> PowershellParseOutcome
```

**Purpose**: Converts a deserialized protocol response into the public parse outcome enum while validating command payload shape. It treats malformed `ok` payloads as unsupported rather than trusted commands.

**Data flow**: It takes ownership of `self`, matches `self.status`, returns `Commands(commands)` only when status is `ok` and `commands` is present, non-empty, and every command and word is non-empty; returns `Unsupported` for status `unsupported` or malformed `ok` payloads; and returns `Failed` for any other status.

**Call relations**: It is the final interpretation step in `PowershellParserProcess::parse` after JSON deserialization and request-id validation.


##### `kill_child`  (lines 262–265)

```
fn kill_child(child: &mut Child)
```

**Purpose**: Best-effort terminates a child process and waits for it to exit. It ignores errors because cleanup should not panic.

**Data flow**: It takes `&mut Child`, calls `child.kill()` and `child.wait()`, discards both results, and returns nothing.

**Call relations**: It is used during spawn cleanup, by `Drop`, and whenever a partially initialized parser child must be torn down.

*Call graph*: called by 2 (drop, spawn); 2 external calls (kill, wait).


##### `tests::parser_process_handles_multiple_requests`  (lines 274–298)

```
fn parser_process_handles_multiple_requests()
```

**Purpose**: Verifies that one parser child can successfully process multiple sequential requests. This confirms the long-lived request/response protocol works across calls.

**Data flow**: The test locates a PowerShell executable if available, spawns a `PowershellParserProcess`, parses `Get-Content 'foo bar'` and `Write-Output foo | Measure-Object`, and asserts the returned `PowershellParseOutcome::Commands` values match the expected command vectors.

**Call relations**: It directly exercises `PowershellParserProcess::spawn` and repeated calls to `PowershellParserProcess::parse`.

*Call graph*: calls 2 internal fn (spawn, try_find_powershell_executable_blocking); 1 external calls (assert_eq!).


##### `tests::parser_process_rejects_stop_parsing_forms`  (lines 301–312)

```
fn parser_process_rejects_stop_parsing_forms()
```

**Purpose**: Checks that stop-parsing forms such as `--%` are not returned as parsed commands. They should be classified as unsupported by the parser pipeline.

**Data flow**: The test locates PowerShell if available, spawns a parser process, parses `git log --% HEAD --output=codex_poc.txt`, and asserts the outcome is `PowershellParseOutcome::Unsupported`.

**Call relations**: It validates the parser script plus response interpretation path for unsupported PowerShell syntax.

*Call graph*: calls 2 internal fn (spawn, try_find_powershell_executable_blocking); 1 external calls (assert_eq!).


### `shell-command/src/command_safety/windows_dangerous_commands.rs`

`domain_logic` · `Windows command approval and danger heuristics`

This file contains the Windows-only danger classifier used by the cross-platform `command_might_be_dangerous` wrapper. The top-level flow checks three categories in order: PowerShell invocations, CMD invocations, and direct GUI/browser launchers. PowerShell detection first recognizes `powershell`/`pwsh` executables, then best-effort parses the invocation into tokens using `parse_powershell_invocation`, and finally scans those tokens in lowercase form for URL-bearing launch commands (`Start-Process`, `Invoke-Item`, COM/ShellExecute references, `rundll32 url.dll,FileProtocolHandler`, `mshta`, browsers, `explorer`) or force-delete cmdlets such as `Remove-Item`, `ri`, `rm`, `del`, `erase`, `rd`, and `rmdir` combined with `-Force` in the same rough command segment.

CMD detection recognizes `cmd`/`cmd.exe`, skips leading switches until `/c`, `/r`, or `-c`, tokenizes the remaining command body with `shlex`, then further splits embedded operators like `echo hi&del` into separate tokens. It scans each command segment separated by `&`, `&&`, `|`, or `||` for `start <url>`, `del/erase /f`, and `rd/rmdir /s /q`.

URL detection is heuristic but careful: `looks_like_url` trims common punctuation with a lazily compiled regex, also extracts embedded `http://` or `https://` substrings, and then validates with `url::Url`. Tests cover many bypass-shaped inputs including semicolons, blocks, comma-separated PowerShell tokens, uppercase flags, single-string CMD bodies, and no-space operator concatenation.

#### Function details

##### `is_dangerous_command_windows`  (lines 8–21)

```
fn is_dangerous_command_windows(command: &[String]) -> bool
```

**Purpose**: Top-level Windows dangerous-command classifier. It checks PowerShell, CMD, and direct GUI/browser launch patterns in that order.

**Data flow**: It takes `&[String]`, returns `true` if `is_dangerous_powershell(command)`, `is_dangerous_cmd(command)`, or `is_direct_gui_launch(command)` returns true, and otherwise returns `false`.

**Call relations**: It is called by the cross-platform `command_might_be_dangerous` wrapper when compiled on Windows.

*Call graph*: calls 3 internal fn (is_dangerous_cmd, is_dangerous_powershell, is_direct_gui_launch); called by 1 (command_might_be_dangerous).


##### `is_dangerous_powershell`  (lines 23–38)

```
fn is_dangerous_powershell(command: &[String]) -> bool
```

**Purpose**: Recognizes dangerous PowerShell invocations by parsing the wrapper and scanning the resulting token stream. It only applies to PowerShell executables.

**Data flow**: It takes `&[String]`, splits off the executable, rejects non-PowerShell executables via `is_powershell_executable`, parses the remaining invocation with `parse_powershell_invocation`, and if successful passes the parsed tokens to `is_dangerous_powershell_words`.

**Call relations**: It is the first branch checked by `is_dangerous_command_windows`, delegating wrapper parsing and token-level danger checks to helpers.

*Call graph*: calls 3 internal fn (is_dangerous_powershell_words, is_powershell_executable, parse_powershell_invocation); called by 1 (is_dangerous_command_windows).


##### `is_dangerous_powershell_words`  (lines 40–90)

```
fn is_dangerous_powershell_words(words: &[String]) -> bool
```

**Purpose**: Scans tokenized PowerShell words for dangerous URL-launching behavior and force-delete cmdlets. It is designed for both full invocations and already-tokenized PowerShell command words.

**Data flow**: It takes `&[String]`, builds a lowercase/trimmed token vector, computes `has_url` with `args_have_url`, returns `true` for URL-bearing `Start-Process`/`Invoke-Item` aliases or ShellExecute/COM references, for `rundll32 url.dll,fileprotocolhandler`, `mshta`, browsers, or `explorer` with URLs, and otherwise falls back to `has_force_delete_cmdlet(&tokens_lc)`.

**Call relations**: It is called from `is_dangerous_powershell` and also exposed indirectly through the cross-platform module for already tokenized PowerShell words.

*Call graph*: calls 3 internal fn (args_have_url, has_force_delete_cmdlet, is_browser_executable); called by 2 (is_dangerous_powershell_words, is_dangerous_powershell); 1 external calls (matches!).


##### `is_dangerous_cmd`  (lines 92–157)

```
fn is_dangerous_cmd(command: &[String]) -> bool
```

**Purpose**: Detects dangerous CMD invocations such as `start <url>`, `del /f`, and `rd /s /q`, including chained and compact operator forms. It only applies to `cmd`/`cmd.exe` wrappers.

**Data flow**: It takes `&[String]`, splits off the executable, normalizes its basename with `executable_basename`, scans wrapper args until `/c`, `/r`, or `-c` while tolerating leading slash switches, collects the remaining command body, tokenizes a single-string body with `shlex_split` or uses the remaining argv directly, refines tokens with `split_embedded_cmd_operators`, splits segments on `&`, `&&`, `|`, and `||`, and returns `true` if any segment matches the dangerous `start`, `del/erase /f`, or `rd/rmdir /s /q` patterns.

**Call relations**: It is the second branch checked by `is_dangerous_command_windows`, after PowerShell detection.

*Call graph*: calls 1 internal fn (executable_basename); called by 1 (is_dangerous_command_windows); 1 external calls (split).


##### `is_direct_gui_launch`  (lines 159–188)

```
fn is_direct_gui_launch(command: &[String]) -> bool
```

**Purpose**: Flags direct executable launches that open URLs through Explorer, browsers, `mshta`, or `rundll32 url.dll,FileProtocolHandler`. It catches dangerous forms that are not wrapped in CMD or PowerShell.

**Data flow**: It takes `&[String]`, splits off the executable, normalizes its basename, checks the remaining args for URLs with `args_have_url`, and returns `true` for `explorer`, `mshta`, `rundll32` with the URL DLL handler, or known browser executables when a URL is present.

**Call relations**: It is the final fallback branch in `is_dangerous_command_windows` after wrapper-specific checks.

*Call graph*: calls 3 internal fn (args_have_url, executable_basename, is_browser_executable); called by 1 (is_dangerous_command_windows); 1 external calls (matches!).


##### `split_embedded_cmd_operators`  (lines 190–223)

```
fn split_embedded_cmd_operators(token: &str) -> Vec<String>
```

**Purpose**: Splits a single CMD token containing concatenated operators into separate tokens, such as turning `echo hi&del` into `echo hi`, `&`, `del`. This improves segment-based CMD analysis.

**Data flow**: It takes a token `&str`, scans character indices, emits preceding text and operator tokens for `&`, `&&`, `|`, and `||`, retains any trailing text, removes empty/whitespace-only parts, and returns `Vec<String>`.

**Call relations**: It is used by `is_dangerous_cmd` after initial tokenization so chained commands without spaces are still analyzed correctly.

*Call graph*: 1 external calls (new).


##### `has_force_delete_cmdlet`  (lines 225–290)

```
fn has_force_delete_cmdlet(tokens: &[String]) -> bool
```

**Purpose**: Detects PowerShell delete/remove cmdlets combined with `-Force` within the same rough command segment. It is resilient to punctuation, blocks, and compact formatting.

**Data flow**: It takes tokenized lowercase strings, builds rough segments by splitting on hard separators like `;`, `|`, `&`, and newlines, then within each segment splits tokens on soft punctuation like braces, parens, brackets, commas, and semicolons, scans the resulting atoms for any delete cmdlet alias and any `-force` or `-force:` form, and returns `true` if both appear in one segment.

**Call relations**: It is the destructive-operation fallback used by `is_dangerous_powershell_words` after URL-launch checks.

*Call graph*: called by 1 (is_dangerous_powershell_words); 3 external calls (new, new, vec!).


##### `has_force_flag_cmd`  (lines 293–295)

```
fn has_force_flag_cmd(args: &[String]) -> bool
```

**Purpose**: Checks whether a CMD argument list contains the `/f` force flag. It is a tiny helper for `del`/`erase` detection.

**Data flow**: It takes `&[String]`, performs a case-insensitive equality check for `/f` across the slice, and returns a boolean.

**Call relations**: It is used by `is_dangerous_cmd` when evaluating `del` and `erase` segments.


##### `has_recursive_flag_cmd`  (lines 298–300)

```
fn has_recursive_flag_cmd(args: &[String]) -> bool
```

**Purpose**: Checks whether a CMD argument list contains the `/s` recursive flag. It supports dangerous `rd`/`rmdir` detection.

**Data flow**: It takes `&[String]`, scans for a case-insensitive `/s`, and returns a boolean.

**Call relations**: It is used by `is_dangerous_cmd` together with `has_quiet_flag_cmd`.


##### `has_quiet_flag_cmd`  (lines 303–305)

```
fn has_quiet_flag_cmd(args: &[String]) -> bool
```

**Purpose**: Checks whether a CMD argument list contains the `/q` quiet flag. It is part of the recursive directory removal heuristic.

**Data flow**: It takes `&[String]`, scans for a case-insensitive `/q`, and returns a boolean.

**Call relations**: It is used by `is_dangerous_cmd` to require both `/s` and `/q` for dangerous `rd`/`rmdir` classification.


##### `args_have_url`  (lines 307–309)

```
fn args_have_url(args: &[String]) -> bool
```

**Purpose**: Determines whether any argument in a slice looks like an HTTP or HTTPS URL. It is a shared helper for launcher heuristics.

**Data flow**: It takes `&[String]`, calls `looks_like_url` on each argument, and returns `true` if any argument matches.

**Call relations**: It is used by both PowerShell and direct-launch danger checks.

*Call graph*: called by 2 (is_dangerous_powershell_words, is_direct_gui_launch).


##### `looks_like_url`  (lines 311–334)

```
fn looks_like_url(token: &str) -> bool
```

**Purpose**: Best-effort URL recognizer for command arguments that may include quotes, parentheses, semicolons, or embedded URL substrings. It only accepts `http` and `https` schemes.

**Data flow**: It takes a token `&str`, optionally slices from the first `https://` or `http://` occurrence, uses a lazily compiled regex to trim surrounding punctuation and capture the candidate URL, parses it with `Url::parse`, and returns `true` only if parsing succeeds and the scheme is `http` or `https`.

**Call relations**: It is the primitive used by `args_have_url`, which feeds multiple dangerous-launch heuristics.

*Call graph*: 3 external calls (new, parse, matches!).


##### `executable_basename`  (lines 336–341)

```
fn executable_basename(exe: &str) -> Option<String>
```

**Purpose**: Extracts and lowercases the basename of an executable path. This normalizes full paths before command-name comparisons.

**Data flow**: It takes an executable string, converts it to a `Path`, extracts the file name and UTF-8 text, lowercases it, and returns `Option<String>`.

**Call relations**: It is used by `is_dangerous_cmd` and `is_direct_gui_launch` to recognize wrapper and launcher executables.

*Call graph*: called by 2 (is_dangerous_cmd, is_direct_gui_launch); 1 external calls (new).


##### `is_powershell_executable`  (lines 343–348)

```
fn is_powershell_executable(exe: &str) -> bool
```

**Purpose**: Recognizes supported PowerShell executable names. It accepts both bare names and `.exe` forms for Windows PowerShell and PowerShell Core.

**Data flow**: It takes an executable string, normalizes it with `executable_basename`, and returns `true` if the basename is `powershell`, `powershell.exe`, `pwsh`, or `pwsh.exe`.

**Call relations**: It gates `is_dangerous_powershell` so only PowerShell wrappers are parsed as PowerShell.

*Call graph*: called by 1 (is_dangerous_powershell); 1 external calls (matches!).


##### `is_browser_executable`  (lines 350–362)

```
fn is_browser_executable(name: &str) -> bool
```

**Purpose**: Recognizes browser executable names used in direct URL-launch heuristics. The list is explicit and small.

**Data flow**: It takes a lowercase executable name `&str` and returns `true` for Chrome, Edge, Firefox, or Internet Explorer names with or without `.exe`.

**Call relations**: It is used by both `is_dangerous_powershell_words` and `is_direct_gui_launch`.

*Call graph*: called by 2 (is_dangerous_powershell_words, is_direct_gui_launch); 1 external calls (matches!).


##### `parse_powershell_invocation`  (lines 368–408)

```
fn parse_powershell_invocation(args: &[String]) -> Option<ParsedPowershell>
```

**Purpose**: Best-effort parses a PowerShell wrapper argv into the underlying command tokens. It understands `-Command`, `/Command`, `-c`, inline `-Command:<script>`, benign wrapper flags, and direct command tails.

**Data flow**: It takes the PowerShell argument slice, scans from the front, handles `-command`/`/command`/`-c` by requiring exactly one following script token and no trailing args, handles inline `-command:` and `/command:` similarly, skips benign flags like `-NoLogo` and `-NoProfile`, skips unknown dash-prefixed switches conservatively, and otherwise treats the remaining args as direct command tokens. Script strings are tokenized with `shlex_split`, and the result is wrapped in `ParsedPowershell`.

**Call relations**: It is used by `is_dangerous_powershell` to obtain a flat token stream for heuristic scanning.

*Call graph*: called by 1 (is_dangerous_powershell); 1 external calls (split).


##### `tests::vec_str`  (lines 414–416)

```
fn vec_str(items: &[&str]) -> Vec<String>
```

**Purpose**: Converts string slices into owned argv vectors for tests. It is a local helper.

**Data flow**: It takes `&[&str]`, maps each item to `String`, collects into `Vec<String>`, and returns it.

**Call relations**: All tests in this module use it to build command vectors.


##### `tests::powershell_start_process_url_is_dangerous`  (lines 419–426)

```
fn powershell_start_process_url_is_dangerous()
```

**Purpose**: Verifies that a PowerShell `Start-Process` invocation targeting an HTTPS URL is flagged as dangerous. This covers the ShellExecute-style URL-launch heuristic.

**Data flow**: The test builds a `powershell -NoLogo -Command "Start-Process 'https://example.com'"` argv vector and asserts `is_dangerous_command_windows` returns `true`.

**Call relations**: It exercises the PowerShell wrapper parsing path and URL-launch detection.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_start_process_url_with_trailing_semicolon_is_dangerous`  (lines 429–435)

```
fn powershell_start_process_url_with_trailing_semicolon_is_dangerous()
```

**Purpose**: Checks that URL-launch detection still works when the PowerShell script includes trailing punctuation. This guards the URL trimming logic.

**Data flow**: The test passes `Start-Process('https://example.com');` through `is_dangerous_command_windows` and asserts `true`.

**Call relations**: It specifically covers `looks_like_url` and punctuation handling.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_start_process_local_is_not_flagged`  (lines 438–444)

```
fn powershell_start_process_local_is_not_flagged()
```

**Purpose**: Ensures local executable launches without URLs are not flagged by the URL-launch heuristic. The danger rule is URL-specific here.

**Data flow**: The test passes `Start-Process notepad.exe` through `is_dangerous_command_windows` and asserts `false`.

**Call relations**: It validates that `args_have_url` is required for the launcher branch.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_with_url_is_dangerous`  (lines 447–454)

```
fn cmd_start_with_url_is_dangerous()
```

**Purpose**: Verifies that `cmd /c start https://...` is classified as dangerous. This covers the classic CMD ShellExecute path.

**Data flow**: The test builds `['cmd', '/c', 'start', 'https://example.com']` and asserts `is_dangerous_command_windows` returns `true`.

**Call relations**: It exercises the CMD wrapper parser and segment scanner.

*Call graph*: 1 external calls (assert!).


##### `tests::msedge_with_url_is_dangerous`  (lines 457–462)

```
fn msedge_with_url_is_dangerous()
```

**Purpose**: Checks that directly launching a browser executable with a URL is flagged. Browser URL opens are treated as dangerous GUI launches.

**Data flow**: The test passes `['msedge.exe', 'https://example.com']` to `is_dangerous_command_windows` and asserts `true`.

**Call relations**: It covers the direct GUI/browser launch branch.

*Call graph*: 1 external calls (assert!).


##### `tests::explorer_with_directory_is_not_flagged`  (lines 465–470)

```
fn explorer_with_directory_is_not_flagged()
```

**Purpose**: Ensures Explorer launched on a local directory is not mistaken for a dangerous URL open. The heuristic requires a URL argument.

**Data flow**: The test passes `['explorer.exe', '.']` and asserts `false`.

**Call relations**: It validates the URL requirement in `is_direct_gui_launch`.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_is_dangerous`  (lines 475–481)

```
fn powershell_remove_item_force_is_dangerous()
```

**Purpose**: Verifies that `Remove-Item ... -Force` is flagged as dangerous in PowerShell. This is the basic force-delete heuristic.

**Data flow**: The test passes a `powershell -Command 'Remove-Item test -Force'` argv vector and asserts `true`.

**Call relations**: It exercises `has_force_delete_cmdlet` through the PowerShell path.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_recurse_force_is_dangerous`  (lines 484–490)

```
fn powershell_remove_item_recurse_force_is_dangerous()
```

**Purpose**: Checks that recursive force deletion in PowerShell is also flagged. Additional flags do not suppress the danger classification.

**Data flow**: The test passes `Remove-Item test -Recurse -Force` and asserts `true`.

**Call relations**: It covers the same force-delete detection with extra arguments present.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_ri_alias_force_is_dangerous`  (lines 493–499)

```
fn powershell_ri_alias_force_is_dangerous()
```

**Purpose**: Ensures PowerShell aliases like `ri` are treated the same as `Remove-Item`. Alias handling is part of the delete-cmdlet list.

**Data flow**: The test passes `pwsh -Command 'ri test -Force'` and asserts `true`.

**Call relations**: It validates alias coverage in `DELETE_CMDLETS`.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_without_force_is_not_flagged`  (lines 502–508)

```
fn powershell_remove_item_without_force_is_not_flagged()
```

**Purpose**: Checks that delete cmdlets without `-Force` are not flagged by this specific heuristic. The rule is intentionally narrower than all deletion.

**Data flow**: The test passes `Remove-Item test` and asserts `false`.

**Call relations**: It confirms `has_force_delete_cmdlet` requires both a delete cmdlet and a force flag.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_force_is_dangerous`  (lines 512–516)

```
fn cmd_del_force_is_dangerous()
```

**Purpose**: Verifies that `cmd /c del /f ...` is classified as dangerous. This is the CMD force-delete counterpart to the PowerShell rule.

**Data flow**: The test passes `['cmd', '/c', 'del', '/f', 'test.txt']` and asserts `true`.

**Call relations**: It exercises the `del/erase` branch in `is_dangerous_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_erase_force_is_dangerous`  (lines 519–523)

```
fn cmd_erase_force_is_dangerous()
```

**Purpose**: Checks that `erase /f` is treated the same as `del /f`. Both commands are force-delete aliases in CMD.

**Data flow**: The test passes `['cmd', '/c', 'erase', '/f', 'test.txt']` and asserts `true`.

**Call relations**: It covers the alternate CMD delete command name.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_without_force_is_not_flagged`  (lines 526–530)

```
fn cmd_del_without_force_is_not_flagged()
```

**Purpose**: Ensures `del` without `/f` is not flagged by this heuristic. The dangerous CMD delete rule is specifically force-based.

**Data flow**: The test passes `['cmd', '/c', 'del', 'test.txt']` and asserts `false`.

**Call relations**: It validates the `/f` requirement in `has_force_flag_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rd_recursive_is_dangerous`  (lines 533–537)

```
fn cmd_rd_recursive_is_dangerous()
```

**Purpose**: Verifies that recursive quiet directory removal via `rd /s /q` is flagged. Both recursion and quiet flags are required.

**Data flow**: The test passes `['cmd', '/c', 'rd', '/s', '/q', 'test']` and asserts `true`.

**Call relations**: It exercises the `rd/rmdir` branch in `is_dangerous_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rd_without_quiet_is_not_flagged`  (lines 540–544)

```
fn cmd_rd_without_quiet_is_not_flagged()
```

**Purpose**: Checks that `rd /s` without `/q` is not flagged by this heuristic. The rule intentionally targets the fully forceful recursive form.

**Data flow**: The test passes `['cmd', '/c', 'rd', '/s', 'test']` and asserts `false`.

**Call relations**: It validates the combined `/s` and `/q` requirement.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rmdir_recursive_is_dangerous`  (lines 547–551)

```
fn cmd_rmdir_recursive_is_dangerous()
```

**Purpose**: Ensures `rmdir /s /q` is treated the same as `rd /s /q`. Both names are recognized as recursive directory removal.

**Data flow**: The test passes `['cmd', '/c', 'rmdir', '/s', '/q', 'test']` and asserts `true`.

**Call relations**: It covers the alternate directory-removal command name.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_path_recurse_force_is_dangerous`  (lines 555–561)

```
fn powershell_remove_item_path_recurse_force_is_dangerous()
```

**Purpose**: Regression test for a `Remove-Item -Path ... -Recurse -Force` form. Option ordering should not bypass force-delete detection.

**Data flow**: The test passes that script through `is_dangerous_command_windows` and asserts `true`.

**Call relations**: It exercises the segment/atom scanning logic in `has_force_delete_cmdlet`.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_with_semicolon_is_dangerous`  (lines 564–570)

```
fn powershell_remove_item_force_with_semicolon_is_dangerous()
```

**Purpose**: Checks that a dangerous force-delete command remains flagged even when followed by another command separated by `;`. Segment splitting must preserve the dangerous segment.

**Data flow**: The test passes `Remove-Item test -Force; Write-Host done` and asserts `true`.

**Call relations**: It validates hard-separator handling in `has_force_delete_cmdlet`.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_inside_block_is_dangerous`  (lines 573–579)

```
fn powershell_remove_item_force_inside_block_is_dangerous()
```

**Purpose**: Ensures force-delete detection still works inside PowerShell blocks. Braces should not hide dangerous cmdlets.

**Data flow**: The test passes `if ($true) { Remove-Item test -Force}` and asserts `true`.

**Call relations**: It covers soft-separator splitting in `has_force_delete_cmdlet`.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_inside_brackets_is_dangerous`  (lines 582–588)

```
fn powershell_remove_item_force_inside_brackets_is_dangerous()
```

**Purpose**: Checks that bracketed or parenthesized force-delete forms are still detected. Punctuation trimming should not suppress the heuristic.

**Data flow**: The test passes `[void]( Remove-Item test -Force)]` and asserts `true`.

**Call relations**: It further validates punctuation splitting in `has_force_delete_cmdlet`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_path_containing_f_is_not_flagged`  (lines 591–598)

```
fn cmd_del_path_containing_f_is_not_flagged()
```

**Purpose**: Ensures a path containing the letter `f` is not mistaken for the `/f` force flag. Flag detection is exact, not substring-based.

**Data flow**: The test passes `['cmd', '/c', 'del', 'C:/foo/bar.txt']` and asserts `false`.

**Call relations**: It validates the exact-match behavior of `has_force_flag_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rd_path_containing_s_is_not_flagged`  (lines 601–608)

```
fn cmd_rd_path_containing_s_is_not_flagged()
```

**Purpose**: Ensures a path containing the letter `s` is not mistaken for the `/s` recursive flag. This guards against naive substring matching.

**Data flow**: The test passes `['cmd', '/c', 'rd', 'C:/source']` and asserts `false`.

**Call relations**: It validates the exact-match behavior of `has_recursive_flag_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_bypass_chained_del_is_dangerous`  (lines 611–615)

```
fn cmd_bypass_chained_del_is_dangerous()
```

**Purpose**: Checks that a dangerous `del /f` command chained after a benign command is still detected. Segment splitting across `&` must work.

**Data flow**: The test passes `['cmd', '/c', 'echo', 'hello', '&', 'del', '/f', 'file.txt']` and asserts `true`.

**Call relations**: It exercises command segmentation in `is_dangerous_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_chained_no_space_is_dangerous`  (lines 618–624)

```
fn powershell_chained_no_space_is_dangerous()
```

**Purpose**: Ensures PowerShell force-delete detection works even when commands are chained without spaces after a semicolon. Compact formatting should not evade detection.

**Data flow**: The test passes `Write-Host hi;Remove-Item -Force C:\tmp` and asserts `true`.

**Call relations**: It covers token and separator handling in `has_force_delete_cmdlet`.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_comma_separated_is_dangerous`  (lines 627–633)

```
fn powershell_comma_separated_is_dangerous()
```

**Purpose**: Checks that comma-separated PowerShell tokens like `del,-Force,C:\foo` are still recognized as dangerous. Soft punctuation splitting must catch this form.

**Data flow**: The test passes that script through `is_dangerous_command_windows` and asserts `true`.

**Call relations**: It specifically validates comma handling in `has_force_delete_cmdlet`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_echo_del_is_not_dangerous`  (lines 636–640)

```
fn cmd_echo_del_is_not_dangerous()
```

**Purpose**: Ensures benign text mentioning `del /f` is not mistaken for an actual delete command. Only the first token of a segment is treated as the command name.

**Data flow**: The test passes `['cmd', '/c', 'echo', 'del', '/f']` and asserts `false`.

**Call relations**: It validates the segment-first-token logic in `is_dangerous_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_single_string_argument_is_dangerous`  (lines 643–649)

```
fn cmd_del_single_string_argument_is_dangerous()
```

**Purpose**: Checks that a single-string CMD body containing `del /f file.txt` is tokenized and flagged correctly. This covers common `cmd /c "..."` forms.

**Data flow**: The test passes `['cmd', '/c', 'del /f file.txt']` and asserts `true`.

**Call relations**: It exercises the `shlex_split` branch in `is_dangerous_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_chained_single_string_argument_is_dangerous`  (lines 652–658)

```
fn cmd_del_chained_single_string_argument_is_dangerous()
```

**Purpose**: Ensures a single-string CMD body with a chained dangerous delete is still detected. Tokenization plus segmentation must cooperate.

**Data flow**: The test passes `['cmd', '/c', 'echo hello & del /f file.txt']` and asserts `true`.

**Call relations**: It covers both `shlex_split` and segment splitting.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_no_space_del_is_dangerous`  (lines 661–667)

```
fn cmd_chained_no_space_del_is_dangerous()
```

**Purpose**: Checks that no-space `&` chaining still exposes a dangerous delete command. Embedded operator splitting is required for this case.

**Data flow**: The test passes `['cmd', '/c', 'echo hi&del /f file.txt']` and asserts `true`.

**Call relations**: It specifically exercises `split_embedded_cmd_operators`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_andand_no_space_del_is_dangerous`  (lines 670–676)

```
fn cmd_chained_andand_no_space_del_is_dangerous()
```

**Purpose**: Ensures no-space `&&` chaining still detects a dangerous delete command. Doubled operators must be split correctly.

**Data flow**: The test passes `['cmd', '/c', 'echo hi&&del /f file.txt']` and asserts `true`.

**Call relations**: It covers the doubled-operator branch in `split_embedded_cmd_operators`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_oror_no_space_del_is_dangerous`  (lines 679–685)

```
fn cmd_chained_oror_no_space_del_is_dangerous()
```

**Purpose**: Ensures no-space `||` chaining still detects a dangerous delete command. Alternate doubled operators are also handled.

**Data flow**: The test passes `['cmd', '/c', 'echo hi||del /f file.txt']` and asserts `true`.

**Call relations**: It further validates `split_embedded_cmd_operators`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_url_single_string_is_dangerous`  (lines 688–694)

```
fn cmd_start_url_single_string_is_dangerous()
```

**Purpose**: Checks that a single-string CMD body launching a URL with `start` is flagged. This covers compact wrapper forms.

**Data flow**: The test passes `['cmd', '/c', 'start https://example.com']` and asserts `true`.

**Call relations**: It exercises `shlex_split` plus URL-launch detection in `is_dangerous_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_no_space_rmdir_is_dangerous`  (lines 697–703)

```
fn cmd_chained_no_space_rmdir_is_dangerous()
```

**Purpose**: Ensures no-space chaining also works for dangerous recursive directory removal. Embedded operator splitting must expose `rmdir /s /q`.

**Data flow**: The test passes `['cmd', '/c', 'echo hi&rmdir /s /q testdir']` and asserts `true`.

**Call relations**: It covers the `rd/rmdir` branch after embedded-operator splitting.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_force_uppercase_flag_is_dangerous`  (lines 706–710)

```
fn cmd_del_force_uppercase_flag_is_dangerous()
```

**Purpose**: Verifies that CMD force-flag detection is case-insensitive. Uppercase `/F` should still be dangerous.

**Data flow**: The test passes `['cmd', '/c', 'DEL', '/F', 'file.txt']` and asserts `true`.

**Call relations**: It validates the case-insensitive comparisons in CMD flag helpers.

*Call graph*: 1 external calls (assert!).


##### `tests::cmdexe_r_del_force_is_dangerous`  (lines 713–717)

```
fn cmdexe_r_del_force_is_dangerous()
```

**Purpose**: Checks that `cmd.exe /r del /f ...` is treated like `cmd /c`. Alternate wrapper spellings are supported.

**Data flow**: The test passes `['cmd.exe', '/r', 'del', '/f', 'file.txt']` and asserts `true`.

**Call relations**: It covers executable basename normalization and `/r` handling in `is_dangerous_cmd`.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_quoted_url_single_string_is_dangerous`  (lines 720–726)

```
fn cmd_start_quoted_url_single_string_is_dangerous()
```

**Purpose**: Ensures quoted URL arguments to `start` are still recognized as dangerous. URL trimming must handle quotes.

**Data flow**: The test passes `['cmd', '/c', 'start "https://example.com"']` and asserts `true`.

**Call relations**: It exercises `looks_like_url` on quoted URL tokens.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_title_then_url_is_dangerous`  (lines 729–735)

```
fn cmd_start_title_then_url_is_dangerous()
```

**Purpose**: Checks that `start` with an empty title followed by a URL is still flagged. This is a common CMD `start` calling convention.

**Data flow**: The test passes `['cmd', '/c', 'start "" https://example.com']` and asserts `true`.

**Call relations**: It validates that URL presence anywhere in the segment is sufficient for the `start` heuristic.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_rm_alias_force_is_dangerous`  (lines 738–744)

```
fn powershell_rm_alias_force_is_dangerous()
```

**Purpose**: Ensures the `rm` alias in PowerShell is treated as a dangerous force-delete cmdlet when combined with `-Force`. Alias coverage is intentional.

**Data flow**: The test passes `powershell -Command 'rm test -Force'` and asserts `true`.

**Call relations**: It covers another alias in the delete-cmdlet list.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_benign_force_separate_command_is_not_dangerous`  (lines 747–753)

```
fn powershell_benign_force_separate_command_is_not_dangerous()
```

**Purpose**: Checks that `-Force` on a benign command does not taint a later non-force delete command in another segment. Force-delete detection is segment-local.

**Data flow**: The test passes `Get-ChildItem -Force; Remove-Item test` and asserts `false`.

**Call relations**: It validates the segment separation logic in `has_force_delete_cmdlet`.

*Call graph*: 1 external calls (assert!).


### `shell-command/src/command_safety/is_dangerous_command.rs`

`domain_logic` · `command approval and unmatched-command rendering`

This file contains the negative side of command classification: quick heuristics for commands that are dangerous enough to flag even before broader policy evaluation. The top-level `command_might_be_dangerous` first defers to Windows-specific detection when compiled on Windows, then checks direct argv forms via `is_dangerous_to_call_with_exec`, and finally inspects `bash -lc`/`zsh -lc` wrappers by parsing them into plain command sequences and testing each extracted command individually.

The current Unix-side dangerous set is intentionally small and concrete: `rm -f` and `rm -rf`, including the recursive case when wrapped in `sudo`. The file also provides reusable helpers shared with the safe-command classifier: `executable_name_lookup_key` normalizes executable names, stripping path components and Windows executable suffixes, and `find_git_subcommand` scans a git argv while skipping known global options that may precede the real subcommand. That scan stops at the first non-option positional token, preventing later branch names or arguments from being mistaken for subcommands.

Tests cover the dangerous `rm` cases and the Windows-only PowerShell-word delegation behavior.

#### Function details

##### `command_might_be_dangerous`  (lines 7–29)

```
fn command_might_be_dangerous(command: &[String]) -> bool
```

**Purpose**: Determines whether a tokenized command should be treated as dangerous by heuristic rules. It checks direct argv forms, shell-wrapped plain-command sequences, and Windows-specific dangerous patterns when applicable.

**Data flow**: It takes `&[String]`, optionally calls `windows_dangerous_commands::is_dangerous_command_windows` on Windows, calls `is_dangerous_to_call_with_exec` on the original argv, then tries `parse_shell_lc_plain_commands` and returns `true` if any extracted inner command is dangerous; otherwise it returns `false`.

**Call relations**: It is called by unmatched-command decision rendering. It delegates shell unwrapping to the Bash parser and platform-specific logic to the Windows module.

*Call graph*: calls 3 internal fn (parse_shell_lc_plain_commands, is_dangerous_to_call_with_exec, is_dangerous_command_windows); called by 1 (render_decision_for_unmatched_command).


##### `is_dangerous_powershell_words`  (lines 33–44)

```
fn is_dangerous_powershell_words(command: &[String]) -> bool
```

**Purpose**: Exposes Windows dangerous-command heuristics for already tokenized PowerShell words. On non-Windows builds it always returns `false`.

**Data flow**: It takes `&[String]`; on Windows it forwards to `windows_dangerous_commands::is_dangerous_powershell_words`, and on other platforms it ignores the input and returns `false`.

**Call relations**: It is used by unmatched-command rendering when PowerShell words have already been tokenized separately from a full command invocation.

*Call graph*: calls 1 internal fn (is_dangerous_powershell_words); called by 1 (render_decision_for_unmatched_command).


##### `is_git_global_option_with_value`  (lines 46–57)

```
fn is_git_global_option_with_value(arg: &str) -> bool
```

**Purpose**: Recognizes git global options that consume the following argv token as their value. This is part of correctly locating the real git subcommand.

**Data flow**: It takes one argument string and returns `true` if it matches one of the known value-taking global options such as `-C`, `-c`, `--git-dir`, or `--work-tree`.

**Call relations**: It is used only by `find_git_subcommand` to skip over option/value pairs before subcommand detection.

*Call graph*: called by 1 (find_git_subcommand); 1 external calls (matches!).


##### `is_git_global_option_with_inline_value`  (lines 59–69)

```
fn is_git_global_option_with_inline_value(arg: &str) -> bool
```

**Purpose**: Recognizes git global options whose value is attached inline, such as `--git-dir=.repo` or `-Cpath`. This prevents bypasses through compact option syntax.

**Data flow**: It takes one argument string and returns `true` if it matches any supported `--opt=value` form or a short `-C...`/`-c...` form with extra characters.

**Call relations**: It is another helper for `find_git_subcommand`, allowing that scanner to skip inline-valued global options without consuming the next token.

*Call graph*: called by 1 (find_git_subcommand); 1 external calls (matches!).


##### `executable_name_lookup_key`  (lines 71–95)

```
fn executable_name_lookup_key(raw: &str) -> Option<String>
```

**Purpose**: Normalizes an executable path into the lookup key used by safety and danger classifiers. On Windows it strips common executable suffixes after taking the basename.

**Data flow**: It takes a raw executable string, converts it to a `Path`, extracts the file name and UTF-8 text, and returns an owned normalized name. On Windows it lowercases and strips `.exe`, `.cmd`, `.bat`, or `.com`; on non-Windows it returns the basename unchanged.

**Call relations**: It is shared by `find_git_subcommand` here and by safe-command classification elsewhere so both modules reason about executable names consistently.

*Call graph*: called by 2 (find_git_subcommand, is_safe_to_call_with_exec); 1 external calls (new).


##### `find_git_subcommand`  (lines 101–143)

```
fn find_git_subcommand(
    command: &'a [String],
    subcommands: &[&str],
) -> Option<(usize, &'a str)>
```

**Purpose**: Finds the first git subcommand from a supplied allow-list while correctly skipping known global options and their values. It stops at the first non-option positional token if it is not one of the requested subcommands.

**Data flow**: It takes a tokenized command slice and a slice of candidate subcommand strings, verifies argv[0] normalizes to `git`, iterates arguments after the executable while tracking whether the next token should be skipped as an option value, ignores inline-valued global options, ignores `--` and other option-like tokens, returns `(index, subcommand)` on the first matching positional token, or `None` otherwise.

**Call relations**: It is called by the safe-command module’s git classifier to avoid git-global-option bypasses and branch-name misclassification.

*Call graph*: calls 3 internal fn (executable_name_lookup_key, is_git_global_option_with_inline_value, is_git_global_option_with_value); called by 1 (is_safe_git_command).


##### `is_dangerous_to_call_with_exec`  (lines 145–157)

```
fn is_dangerous_to_call_with_exec(command: &[String]) -> bool
```

**Purpose**: Applies direct argv heuristics for dangerous commands without shell parsing. The current rules focus on forceful deletion commands.

**Data flow**: It takes `&[String]`, inspects the first token, returns `true` for `rm` when the second token is `-f` or `-rf`, recursively unwraps `sudo` by checking the remaining slice, and returns `false` for everything else.

**Call relations**: It is the direct-command predicate used by `command_might_be_dangerous` before and after shell-wrapper parsing.

*Call graph*: called by 1 (command_might_be_dangerous); 1 external calls (matches!).


##### `tests::vec_str`  (lines 163–165)

```
fn vec_str(items: &[&str]) -> Vec<String>
```

**Purpose**: Converts string slices into owned `Vec<String>` values for concise tests. It is a local test helper.

**Data flow**: It takes `&[&str]`, maps each item through `ToString::to_string`, collects into `Vec<String>`, and returns it.

**Call relations**: The danger-classification tests use it to build argv vectors.


##### `tests::rm_rf_is_dangerous`  (lines 168–170)

```
fn rm_rf_is_dangerous()
```

**Purpose**: Verifies that `rm -rf /` is classified as dangerous. This locks in the recursive force-delete heuristic.

**Data flow**: The test builds the argv vector `['rm', '-rf', '/']`, passes it to `command_might_be_dangerous`, and asserts the result is `true`.

**Call relations**: It exercises the direct `is_dangerous_to_call_with_exec` path through the public classifier.

*Call graph*: 1 external calls (assert!).


##### `tests::rm_f_is_dangerous`  (lines 173–175)

```
fn rm_f_is_dangerous()
```

**Purpose**: Verifies that `rm -f /` is also classified as dangerous. The heuristic is not limited to recursive deletion.

**Data flow**: The test builds `['rm', '-f', '/']`, calls `command_might_be_dangerous`, and asserts `true`.

**Call relations**: It covers the second accepted dangerous `rm` flag variant.

*Call graph*: 1 external calls (assert!).


##### `tests::direct_powershell_words_reuse_windows_dangerous_detection`  (lines 178–186)

```
fn direct_powershell_words_reuse_windows_dangerous_detection()
```

**Purpose**: Checks that tokenized PowerShell-word danger detection delegates to the Windows implementation only on Windows builds. Non-Windows builds must not classify such words as dangerous.

**Data flow**: The test builds `['Remove-Item', 'test', '-Force']`, then conditionally asserts `is_dangerous_powershell_words` is `true` on Windows and `false` elsewhere.

**Call relations**: It validates the platform-gated behavior of the public PowerShell-word helper.

*Call graph*: 3 external calls (assert!, cfg!, vec_str).


### `shell-command/src/command_safety/windows_safe_commands.rs`

`domain_logic` · `Windows command approval and policy evaluation`

This file is the Windows counterpart to the Unix-oriented safe-command classifier. Its top-level rule is intentionally narrow: only PowerShell invocations are considered for auto-approval, and only when they can be parsed into discrete command vectors by the AST-backed parser in `powershell_parser`. `is_safe_command_windows` first recognizes PowerShell executables, then `parse_powershell_invocation` accepts a limited wrapper surface: `-Command`, `/Command`, `-c`, inline `-Command:<script>`, a few benign no-arg flags, or direct command tails after benign flags. Opaque or side-effect-prone wrapper options such as `-EncodedCommand`, `-File`, `-ExecutionPolicy`, and unknown switches are rejected outright.

Once a script string is isolated, `parse_powershell_script` delegates to `parse_with_powershell_ast`, which returns a sequence of parsed commands only for supported syntax. Every parsed command must then satisfy `is_safe_powershell_words`. That safelist allows a small set of read-only cmdlets and aliases (`Get-ChildItem`, `Get-Content`, `Select-String`, `Measure-Object`, `Get-Location`, `Test-Path`, `Resolve-Path`, `Select-Object`, `Get-Item`, plus `echo`/`Write-Output`/`Write-Host`), delegates `git` to the shared git safety logic, and applies ripgrep-specific option checks. It also scans every word for nested unsafe cmdlets like `Set-Content`, `Remove-Item`, `Start-Process`, or `Out-File`, so unsafe operations hidden inside parentheses or arguments still fail.

Argument joining for direct-tail invocations uses single-quote escaping via `quote_argument`, preserving whitespace safely before AST parsing. Tests cover full-path PowerShell executables, pipelines, git override rejection, stop-parsing rejection, dynamic argument rejection, and the important distinction that `pwsh` may accept syntax such as `&&` that `powershell.exe` does not.

#### Function details

##### `is_safe_command_windows`  (lines 8–17)

```
fn is_safe_command_windows(command: &[String]) -> bool
```

**Purpose**: Determines whether a Windows command is safely auto-approvable under the PowerShell-only safelist. Non-PowerShell commands are rejected by default.

**Data flow**: It takes `&[String]`, calls `try_parse_powershell_command_sequence`, and returns `true` only if parsing succeeds and every parsed command slice passes `is_safe_powershell_words`; otherwise it returns `false`.

**Call relations**: It is called by the cross-platform `is_known_safe_command` entry point on Windows builds.

*Call graph*: calls 1 internal fn (try_parse_powershell_command_sequence); called by 1 (is_known_safe_command).


##### `try_parse_powershell_command_sequence`  (lines 21–28)

```
fn try_parse_powershell_command_sequence(command: &[String]) -> Option<Vec<Vec<String>>>
```

**Purpose**: Recognizes PowerShell invocations and extracts their parsed command sequence if possible. It is the wrapper gate before AST parsing.

**Data flow**: It takes `&[String]`, splits off the executable, checks it with `is_powershell_executable`, and if it matches delegates the remaining args to `parse_powershell_invocation`; otherwise it returns `None`.

**Call relations**: It is used only by `is_safe_command_windows` to distinguish PowerShell wrappers from everything else.

*Call graph*: calls 2 internal fn (is_powershell_executable, parse_powershell_invocation); called by 1 (is_safe_command_windows).


##### `parse_powershell_invocation`  (lines 31–92)

```
fn parse_powershell_invocation(executable: &str, args: &[String]) -> Option<Vec<Vec<String>>>
```

**Purpose**: Parses the outer PowerShell argv wrapper into a script string and then into discrete commands, rejecting opaque or suspicious wrapper forms. It is intentionally stricter than PowerShell itself.

**Data flow**: It takes the executable path and remaining args, rejects empty args, scans wrapper flags from left to right, handles `-command`/`/command`/`-c` by requiring exactly one following script token and no trailing args, handles inline `-command:` and `/command:` similarly, skips benign flags like `-NoLogo` and `-NoProfile`, rejects explicitly forbidden flags such as `-EncodedCommand`, `-File`, `-WindowStyle`, `-ExecutionPolicy`, and `-WorkingDirectory`, rejects unknown switches, and otherwise joins the remaining args into a script with `join_arguments_as_script` before passing the script to `parse_powershell_script`.

**Call relations**: It is called by `try_parse_powershell_command_sequence` and delegates actual script parsing to `parse_powershell_script`.

*Call graph*: calls 2 internal fn (join_arguments_as_script, parse_powershell_script); called by 1 (try_parse_powershell_command_sequence).


##### `parse_powershell_script`  (lines 96–104)

```
fn parse_powershell_script(executable: &str, script: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: Delegates a PowerShell script string to the AST-backed parser and returns parsed command vectors only on successful structured parsing. Unsupported syntax is rejected with `None`.

**Data flow**: It takes an executable path and script `&str`, calls `parse_with_powershell_ast`, and returns `Some(commands)` only when the outcome is `PowershellParseOutcome::Commands`.

**Call relations**: It is the bridge from wrapper parsing into the helper-process parser in `powershell_parser`.

*Call graph*: calls 1 internal fn (parse_with_powershell_ast); called by 1 (parse_powershell_invocation).


##### `is_powershell_executable`  (lines 107–118)

```
fn is_powershell_executable(exe: &str) -> bool
```

**Purpose**: Recognizes supported PowerShell executable names from either bare names or full paths. It lowercases the basename before comparison.

**Data flow**: It takes an executable string, extracts the basename with `Path::new(...).file_name()`, falls back to the original string if needed, lowercases it, and returns `true` for `powershell`, `powershell.exe`, `pwsh`, or `pwsh.exe`.

**Call relations**: It gates `try_parse_powershell_command_sequence` so only PowerShell wrappers enter the Windows safelist parser.

*Call graph*: called by 1 (try_parse_powershell_command_sequence); 2 external calls (new, matches!).


##### `join_arguments_as_script`  (lines 120–129)

```
fn join_arguments_as_script(args: &[String]) -> String
```

**Purpose**: Reconstructs a PowerShell script string from argv tail tokens when PowerShell is invoked without an explicit `-Command` wrapper. It preserves whitespace-bearing arguments by quoting them.

**Data flow**: It takes `&[String]`, allocates a `Vec<String>` with capacity for all args, copies the first token unchanged, quotes each remaining token with `quote_argument`, joins the pieces with spaces, and returns the resulting script `String`.

**Call relations**: It is used by `parse_powershell_invocation` when non-flag tokens appear directly after benign wrapper flags.

*Call graph*: calls 1 internal fn (quote_argument); called by 1 (parse_powershell_invocation); 1 external calls (with_capacity).


##### `quote_argument`  (lines 131–141)

```
fn quote_argument(arg: &str) -> String
```

**Purpose**: Quotes one argument for safe reconstruction into a PowerShell script string. It uses single quotes and doubles embedded single quotes when whitespace is present.

**Data flow**: It takes `&str`, returns `''` for an empty string, returns the original string unchanged if it contains no whitespace, otherwise returns a formatted single-quoted string with internal `'` replaced by `''`.

**Call relations**: It is called by `join_arguments_as_script` for every argument after the first.

*Call graph*: called by 1 (join_arguments_as_script); 1 external calls (format!).


##### `is_safe_powershell_words`  (lines 145–207)

```
fn is_safe_powershell_words(words: &[String]) -> bool
```

**Purpose**: Checks whether one parsed PowerShell command vector stays within the read-only safelist. It rejects both unsafe top-level cmdlets and nested unsafe cmdlets hidden inside words.

**Data flow**: It takes `&[String]`, rejects empty command vectors, scans every word after trimming surrounding parentheses and leading dashes for nested unsafe cmdlets like `set-content`, `remove-item`, `start-process`, and `out-file`, then normalizes the first word similarly and matches it against the safelist. It returns `true` for allowed read-only cmdlets and aliases, delegates `git` to `is_safe_git_command`, delegates `rg` to `is_safe_ripgrep`, explicitly returns `false` for common side-effecting cmdlets, and returns `false` for everything else.

**Call relations**: It is called on every parsed command by `is_safe_command_windows`, and is also exposed indirectly through the cross-platform safe-command module for already tokenized PowerShell words.

*Call graph*: calls 2 internal fn (is_safe_git_command, is_safe_ripgrep); called by 1 (is_safe_powershell_words); 1 external calls (matches!).


##### `is_safe_ripgrep`  (lines 210–222)

```
fn is_safe_ripgrep(words: &[String]) -> bool
```

**Purpose**: Applies ripgrep-specific option restrictions within PowerShell command vectors. It rejects options that can spawn helper commands or external decompression tools.

**Data flow**: It takes `&[String]`, lowercases each argument after the command name, and returns `false` if any argument is `--search-zip` or `-z`, or matches `--pre`, `--pre=...`, `--hostname-bin`, or `--hostname-bin=...`; otherwise it returns `true`.

**Call relations**: It is called only by `is_safe_powershell_words` when the parsed command name is `rg`.

*Call graph*: called by 1 (is_safe_powershell_words).


##### `tests::vec_str`  (lines 232–234)

```
fn vec_str(args: &[&str]) -> Vec<String>
```

**Purpose**: Converts string slices into owned argv vectors for tests. It is a local helper.

**Data flow**: It takes `&[&str]`, maps each item to `String`, collects into `Vec<String>`, and returns it.

**Call relations**: The Windows safelist tests use it to build command vectors.


##### `tests::recognizes_safe_powershell_wrappers`  (lines 237–267)

```
fn recognizes_safe_powershell_wrappers()
```

**Purpose**: Verifies that common safe PowerShell wrapper forms are accepted, including `-NoLogo`, `-NoProfile`, explicit `-Command`, direct command tails, and `pwsh` parity. It establishes the accepted wrapper surface.

**Data flow**: The test builds several PowerShell argv vectors, optionally including a discovered `pwsh` path, passes each to `is_safe_command_windows`, and asserts `true`.

**Call relations**: It exercises wrapper parsing, AST parsing, and the read-only PowerShell-word safelist together.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 1 external calls (assert!).


##### `tests::accepts_full_path_powershell_invocations`  (lines 270–290)

```
fn accepts_full_path_powershell_invocations()
```

**Purpose**: Checks that full executable paths to PowerShell binaries are recognized and classified correctly. Basename extraction must work for path-based invocations.

**Data flow**: The test returns early off Windows where appropriate, optionally checks a discovered `pwsh` full path, and asserts that both discovered and hard-coded full PowerShell paths are accepted for read-only commands.

**Call relations**: It validates `is_powershell_executable` and the overall Windows safelist path handling.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 2 external calls (assert!, cfg!).


##### `tests::allows_read_only_pipelines_and_git_usage`  (lines 293–333)

```
fn allows_read_only_pipelines_and_git_usage()
```

**Purpose**: Verifies that parsed PowerShell pipelines composed of safe commands remain safe, and that safe git usage is accepted inside PowerShell. It covers multi-command AST output.

**Data flow**: The test discovers `pwsh`, builds several `-Command` scripts involving ripgrep pipelines, `Get-Content | Select-Object`, `git show`, parenthesized `Get-Content`, and `Get-Item | Select-Object`, and asserts each is safe.

**Call relations**: It exercises AST parsing into multiple command vectors and the per-command `is_safe_powershell_words` checks.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 1 external calls (assert!).


##### `tests::rejects_git_global_override_options`  (lines 336–368)

```
fn rejects_git_global_override_options()
```

**Purpose**: Ensures unsafe git global override options remain unsafe even when invoked through PowerShell. Windows PowerShell safety reuses the shared git rules.

**Data flow**: The test discovers `pwsh`, iterates over many unsafe git scripts using `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, and `--super-prefix`, wraps each in a PowerShell command vector, and asserts `is_safe_command_windows` is `false`.

**Call relations**: It validates integration between PowerShell parsing and the shared `is_safe_git_command` logic.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 1 external calls (assert!).


##### `tests::rejects_git_subcommand_options_with_side_effects`  (lines 371–403)

```
fn rejects_git_subcommand_options_with_side_effects()
```

**Purpose**: Checks that git subcommand options with side effects are rejected inside PowerShell as well. This includes output-writing and external-diff/textconv behavior.

**Data flow**: The test maps several git scripts into PowerShell command vectors, collects `(script, bool)` results from `is_safe_command_windows`, and asserts they all evaluate to `false`.

**Call relations**: It covers the shared git subcommand option restrictions through the Windows safelist.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_stop_parsing_git_forms`  (lines 406–413)

```
fn rejects_stop_parsing_git_forms()
```

**Purpose**: Ensures PowerShell stop-parsing forms are not accepted as safe. Unsupported parser constructs must not fall back to permissive token splitting.

**Data flow**: The test passes `git log --% HEAD --output=codex_poc.txt` through `is_safe_command_windows` and asserts `false`.

**Call relations**: It validates the AST parser’s `Unsupported` outcome propagation through `parse_powershell_script`.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_powershell_commands_with_side_effects`  (lines 416–512)

```
fn rejects_powershell_commands_with_side_effects()
```

**Purpose**: Covers a broad set of PowerShell commands and constructs that must remain unsafe, including mutating cmdlets, unsafe ripgrep flags, redirections, call operators, chained safe+unsafe scripts, nested unsafe cmdlets, array expansion, unsupported syntax, sub-expressions, and empty words. It documents the conservative boundaries of the Windows safelist.

**Data flow**: The test builds many PowerShell command vectors and asserts `is_safe_command_windows` returns `false` for each.

**Call relations**: It exercises wrapper rejection, AST parser rejection, nested-unsafe-word scanning, and top-level command safelist rejection.

*Call graph*: 1 external calls (assert!).


##### `tests::accepts_constant_expression_arguments`  (lines 515–527)

```
fn accepts_constant_expression_arguments()
```

**Purpose**: Verifies that constant quoted string arguments are accepted by the AST-backed parser and safelist. Literal strings with spaces should remain safe.

**Data flow**: The test passes `Get-Content 'foo bar'` and `Get-Content "foo bar"` through `is_safe_command_windows` and asserts `true`.

**Call relations**: It covers AST parsing of constant expression arguments and acceptance by `is_safe_powershell_words`.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_dynamic_arguments`  (lines 530–542)

```
fn rejects_dynamic_arguments()
```

**Purpose**: Ensures dynamic PowerShell arguments such as variables and interpolated strings are rejected. The safelist depends on literal AST-derived words.

**Data flow**: The test passes `Get-Content $foo` and `Write-Output "foo $bar"` through `is_safe_command_windows` and asserts `false`.

**Call relations**: It validates that the AST parser does not emit acceptable literal command vectors for dynamic expressions.

*Call graph*: 1 external calls (assert!).


##### `tests::uses_invoked_powershell_variant_for_parsing`  (lines 545–572)

```
fn uses_invoked_powershell_variant_for_parsing()
```

**Purpose**: Checks that parsing semantics depend on the actual invoked PowerShell variant. Syntax accepted by `pwsh` but not by `powershell.exe` should be classified accordingly.

**Data flow**: The test returns early off Windows, defines the script `pwd && ls`, asserts it is unsafe under `powershell.exe -Command`, then if `pwsh` is available asserts the same script is safe under `pwsh -Command`.

**Call relations**: It validates the executable-keyed parser-process cache and the design choice to parse with the real invoked PowerShell variant.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 2 external calls (assert!, cfg!).


### `shell-command/src/command_safety/is_safe_command.rs`

`domain_logic` · `command approval and policy evaluation`

This file is the core read-only command classifier. `is_known_safe_command` first normalizes `zsh` to `bash` so shell-wrapper handling is shared, then consults Windows-specific logic when applicable, then checks direct argv safety with `is_safe_to_call_with_exec`, and finally parses `bash -lc`/`zsh -lc` scripts into plain command sequences and requires every extracted inner command to be individually safe.

The direct safelist is explicit and conservative. Some commands are always accepted by executable name (`cat`, `grep`, `ls`, `pwd`, `wc`, etc.), while others are accepted only if dangerous options are absent: `base64` is unsafe with output-writing flags, `find` is unsafe with `-exec`, `-delete`, and file-writing options, and `rg` is unsafe with flags that spawn helper commands or external decompressors. `sed` is only accepted in the narrow `sed -n <line-spec> [file]` form validated by `is_valid_sed_n_arg`.

Git handling is more nuanced. `is_safe_git_command` uses the shared `find_git_subcommand` scanner to locate `status`, `log`, `diff`, `show`, or `branch` after skipping global options. It then rejects unsafe global overrides (`-C`, `-c`, `--git-dir`, `--paginate`, etc.) and unsafe subcommand options (`--output`, `--ext-diff`, `--textconv`, `--exec`). `git branch` is only safe for clearly read-only listing/query forms. The `GitOptionPattern` enum encodes exact, prefix, and short-inline-value matching so option checks stay declarative. Tests cover many bypass attempts, shell-wrapped forms, Windows path normalization interactions, and a non-Windows regression ensuring safety classification never spawns a repository-local fake PowerShell binary.

#### Function details

##### `is_known_safe_command`  (lines 12–50)

```
fn is_known_safe_command(command: &[String]) -> bool
```

**Purpose**: Determines whether a tokenized command is known read-only enough to auto-approve. It supports direct argv forms, Windows PowerShell wrappers, and restricted shell-wrapper scripts whose inner commands are all safe.

**Data flow**: It takes `&[String]`, clones it into a normalized `Vec<String>` that rewrites `zsh` to `bash`, optionally delegates to `is_safe_command_windows` on Windows, checks the normalized argv with `is_safe_to_call_with_exec`, then tries `parse_shell_lc_plain_commands` and returns `true` only if the parsed sequence is non-empty and every inner command passes `is_safe_to_call_with_exec`.

**Call relations**: It is the top-level safe-command predicate used by unmatched-command decision rendering. It delegates shell parsing to the Bash module and direct executable classification to `is_safe_to_call_with_exec`.

*Call graph*: calls 3 internal fn (parse_shell_lc_plain_commands, is_safe_to_call_with_exec, is_safe_command_windows); called by 1 (render_decision_for_unmatched_command).


##### `is_safe_powershell_words`  (lines 54–65)

```
fn is_safe_powershell_words(command: &[String]) -> bool
```

**Purpose**: Exposes the Windows PowerShell-word safelist for already tokenized PowerShell commands. On non-Windows builds it always returns `false`.

**Data flow**: It takes `&[String]`; on Windows it forwards to `is_safe_powershell_words_windows`, and on other platforms it ignores the input and returns `false`.

**Call relations**: It is used by unmatched-command rendering when PowerShell words have already been extracted separately from a full invocation.

*Call graph*: calls 1 internal fn (is_safe_powershell_words); called by 1 (render_decision_for_unmatched_command).


##### `is_safe_to_call_with_exec`  (lines 67–173)

```
fn is_safe_to_call_with_exec(command: &[String]) -> bool
```

**Purpose**: Classifies direct argv commands as safe or unsafe based on executable name and option-level heuristics. It is the main non-shell safelist implementation.

**Data flow**: It takes `&[String]`, returns `false` for an empty command, normalizes argv[0] with `executable_name_lookup_key`, and matches on the executable name. It returns `true` for a fixed set of read-only commands, conditionally for Linux-only `numfmt` and `tac`, checks option restrictions for `base64`, `find`, and `rg`, delegates git commands to `is_safe_git_command`, accepts only narrow `sed -n` forms validated by `is_valid_sed_n_arg`, and returns `false` otherwise.

**Call relations**: It is called directly by `is_known_safe_command` and indirectly on each parsed inner shell command. It relies on shared executable normalization and git-specific helpers.

*Call graph*: calls 3 internal fn (executable_name_lookup_key, is_safe_git_command, is_valid_sed_n_arg); called by 1 (is_known_safe_command); 2 external calls (cfg!, matches!).


##### `is_safe_git_command`  (lines 175–200)

```
fn is_safe_git_command(command: &[String]) -> bool
```

**Purpose**: Determines whether a git invocation is read-only under a conservative option policy. It allows only selected subcommands and rejects global or subcommand options that can alter behavior or write output.

**Data flow**: It takes `&[String]`, uses `find_git_subcommand` to locate one of `status`, `log`, `diff`, `show`, or `branch`, slices out global args before the subcommand and rejects them if `git_has_unsafe_global_option` is true, slices subcommand args after the subcommand, then for `status/log/diff/show` requires `git_subcommand_args_are_read_only`, and for `branch` additionally requires `git_branch_is_read_only`.

**Call relations**: It is called from `is_safe_to_call_with_exec` for direct git commands and is also reused by the Windows PowerShell safelist so git safety rules stay consistent across shells.

*Call graph*: calls 4 internal fn (find_git_subcommand, git_branch_is_read_only, git_has_unsafe_global_option, git_subcommand_args_are_read_only); called by 2 (is_safe_to_call_with_exec, is_safe_powershell_words); 1 external calls (debug_assert!).


##### `git_branch_is_read_only`  (lines 204–228)

```
fn git_branch_is_read_only(branch_args: &[String]) -> bool
```

**Purpose**: Restricts `git branch` to clearly query-only forms. Any positional argument or unrecognized flag is treated as potentially mutating.

**Data flow**: It takes the subcommand argument slice, returns `true` for no args, otherwise scans each arg string, marks known listing/query flags such as `--list`, `--show-current`, `-a`, `-r`, `-v`, `-vv`, and `--format=...` as read-only indicators, and returns `false` on any other token. It returns `true` only if at least one recognized read-only flag was seen when args are present.

**Call relations**: It is the branch-specific refinement step inside `is_safe_git_command`.

*Call graph*: called by 1 (is_safe_git_command).


##### `GitOptionPattern::matches`  (lines 268–276)

```
fn matches(self, arg: &str) -> bool
```

**Purpose**: Matches one git option argument against a declarative pattern variant. It supports exact equality, short options with inline values, and prefix forms.

**Data flow**: It takes `self` and an argument `&str`, compares according to the enum variant, and returns a boolean indicating whether the argument matches the pattern.

**Call relations**: It is used by `git_matches_option_pattern`, which in turn powers both global and subcommand git option safety checks.


##### `git_matches_option_pattern`  (lines 279–281)

```
fn git_matches_option_pattern(arg: &str, patterns: &[GitOptionPattern]) -> bool
```

**Purpose**: Checks whether a git argument matches any pattern in a supplied pattern list. It is a small helper to keep option scans concise.

**Data flow**: It takes an argument `&str` and a slice of `GitOptionPattern`, iterates the patterns, calls `pattern.matches(arg)` on each, and returns `true` if any match.

**Call relations**: It is used by both `git_has_unsafe_global_option` and `git_subcommand_args_are_read_only`.

*Call graph*: 1 external calls (iter).


##### `git_has_unsafe_global_option`  (lines 283–288)

```
fn git_has_unsafe_global_option(global_args: &[String]) -> bool
```

**Purpose**: Detects whether any git global argument belongs to the unsafe global-option set. These options can redirect repositories, alter helpers, or change paging behavior.

**Data flow**: It takes the global-argument slice `&[String]`, maps each to `&str`, checks each against `UNSAFE_GIT_GLOBAL_OPTIONS` via `git_matches_option_pattern`, and returns `true` if any unsafe option is present.

**Call relations**: It is called by `is_safe_git_command` after the subcommand position has been identified.

*Call graph*: called by 1 (is_safe_git_command).


##### `git_subcommand_args_are_read_only`  (lines 290–295)

```
fn git_subcommand_args_are_read_only(args: &[String]) -> bool
```

**Purpose**: Rejects git subcommand arguments that can write output files or invoke external helpers. It is shared across the allowed read-only git subcommands.

**Data flow**: It takes a subcommand-argument slice `&[String]`, maps each to `&str`, checks each against `UNSAFE_GIT_SUBCOMMAND_OPTIONS` via `git_matches_option_pattern`, and returns `true` only if none match.

**Call relations**: It is used by `is_safe_git_command` for `status`, `log`, `diff`, `show`, and as one half of the `branch` safety decision.

*Call graph*: called by 1 (is_safe_git_command).


##### `is_valid_sed_n_arg`  (lines 304–334)

```
fn is_valid_sed_n_arg(arg: Option<&str>) -> bool
```

**Purpose**: Validates the narrow line-address syntax accepted for safe `sed -n` invocations. Only `Np` or `M,Np` forms made of ASCII digits are allowed.

**Data flow**: It takes `Option<&str>`, returns `false` on `None`, strips a trailing `p`, splits the remaining core on `,`, and returns `true` only for one or two non-empty all-digit parts.

**Call relations**: It is called by `is_safe_to_call_with_exec` to recognize the one special-case `sed` form considered read-only.

*Call graph*: called by 1 (is_safe_to_call_with_exec).


##### `tests::vec_str`  (lines 341–343)

```
fn vec_str(args: &[&str]) -> Vec<String>
```

**Purpose**: Builds owned argv vectors from string slices for tests. It is a local convenience helper.

**Data flow**: It takes `&[&str]`, converts each item to `String`, collects into `Vec<String>`, and returns it.

**Call relations**: Many tests in this module use it to construct command vectors.


##### `tests::known_safe_examples`  (lines 346–377)

```
fn known_safe_examples()
```

**Purpose**: Exercises a representative set of direct commands that should be classified as safe. It includes plain utilities, git queries, base64, sed, find, and Linux-only cases.

**Data flow**: The test builds multiple argv vectors and asserts `is_safe_to_call_with_exec` returns the expected boolean, with conditional expectations for Linux-only commands.

**Call relations**: It validates the main direct-command safelist across several branches of `is_safe_to_call_with_exec`.

*Call graph*: 2 external calls (assert!, cfg!).


##### `tests::git_branch_mutating_flags_are_not_safe`  (lines 380–389)

```
fn git_branch_mutating_flags_are_not_safe()
```

**Purpose**: Ensures mutating `git branch` forms are not auto-approved. Creating or deleting branches must require approval.

**Data flow**: The test passes `git branch -d feature` and `git branch new-branch` into `is_known_safe_command` and asserts both are unsafe.

**Call relations**: It specifically covers `git_branch_is_read_only` through the public safe-command entry point.

*Call graph*: 1 external calls (assert!).


##### `tests::git_branch_global_options_respect_safety_rules`  (lines 392–406)

```
fn git_branch_global_options_respect_safety_rules()
```

**Purpose**: Checks that safe and unsafe `git branch` forms are distinguished correctly, including shell-wrapped variants. It confirms branch safety rules survive wrapper parsing.

**Data flow**: The test asserts `git branch --show-current` is safe, `git branch -d feature` is unsafe, and `bash -lc 'git branch -d feature'` is also unsafe.

**Call relations**: It exercises both direct git classification and shell-wrapper parsing plus inner-command safety checks.

*Call graph*: 1 external calls (assert!).


##### `tests::git_first_positional_is_the_subcommand`  (lines 409–415)

```
fn git_first_positional_is_the_subcommand()
```

**Purpose**: Verifies that later positional arguments are not mistaken for git subcommands. This prevents bypasses like `git checkout status`.

**Data flow**: The test passes `git checkout status` to `is_known_safe_command` and asserts it is unsafe.

**Call relations**: It validates the early-stop behavior in the shared `find_git_subcommand` scanner.

*Call graph*: 1 external calls (assert!).


##### `tests::git_output_flags_are_not_safe`  (lines 418–438)

```
fn git_output_flags_are_not_safe()
```

**Purpose**: Ensures git output-writing flags are rejected for otherwise read-only subcommands. Writing diff/log/show output to files is not auto-approved.

**Data flow**: The test checks several `git log/diff/show --output...` forms with `is_known_safe_command` and asserts all are unsafe.

**Call relations**: It covers `git_subcommand_args_are_read_only` and the unsafe subcommand option pattern list.

*Call graph*: 1 external calls (assert!).


##### `tests::git_global_pagination_flags_are_not_safe`  (lines 441–461)

```
fn git_global_pagination_flags_are_not_safe()
```

**Purpose**: Checks that unsafe git global pagination flags are rejected, including inside shell wrappers. Global options are treated separately from subcommand flags.

**Data flow**: The test passes direct and `bash -lc` forms using `--paginate` and `-p` before the subcommand and asserts all are unsafe.

**Call relations**: It validates `git_has_unsafe_global_option` and shell-wrapper propagation of git safety rules.

*Call graph*: 1 external calls (assert!).


##### `tests::git_subcommand_patch_flags_remain_safe`  (lines 464–475)

```
fn git_subcommand_patch_flags_remain_safe()
```

**Purpose**: Confirms that `-p` remains safe when used as a subcommand argument to `git log`, `git diff`, or `git show`. The same token is unsafe only as a global option.

**Data flow**: The test checks direct and shell-wrapped patch-display forms and asserts they are safe.

**Call relations**: It documents the distinction between global and subcommand argument slices inside `is_safe_git_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::git_global_override_flags_are_not_safe`  (lines 478–527)

```
fn git_global_override_flags_are_not_safe()
```

**Purpose**: Exercises a broad set of git global override options that must force approval. These options can redirect repository context, helper binaries, namespaces, or config.

**Data flow**: The test builds many direct and shell-wrapped git commands using `-C`, `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, and `--super-prefix`, then asserts each is unsafe.

**Call relations**: It thoroughly covers the `UNSAFE_GIT_GLOBAL_OPTIONS` pattern list and the shared subcommand scanner.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::cargo_check_is_not_safe`  (lines 530–532)

```
fn cargo_check_is_not_safe()
```

**Purpose**: Verifies that commands outside the explicit safelist are not auto-approved even if they are often benign. `cargo check` remains unsafe by default.

**Data flow**: The test passes `cargo check` to `is_known_safe_command` and asserts `false`.

**Call relations**: It confirms the classifier is allow-list based rather than trying to infer safety broadly.

*Call graph*: 1 external calls (assert!).


##### `tests::zsh_lc_safe_command_sequence`  (lines 535–537)

```
fn zsh_lc_safe_command_sequence()
```

**Purpose**: Checks that `zsh -lc` wrappers are normalized and classified like Bash wrappers. A simple `ls` script should be safe.

**Data flow**: The test passes `['zsh', '-lc', 'ls']` to `is_known_safe_command` and asserts `true`.

**Call relations**: It covers the `zsh`→`bash` normalization in `is_known_safe_command` plus shell-wrapper parsing.

*Call graph*: 1 external calls (assert!).


##### `tests::unknown_or_partial`  (lines 540–566)

```
fn unknown_or_partial()
```

**Purpose**: Verifies that unknown commands, unsupported git subcommands, invalid sed forms, and unsafe `find` options are all rejected. It exercises several negative branches of the direct safelist.

**Data flow**: The test checks `foo`, `git fetch`, invalid `sed -n xp`, and a list of `find` invocations containing `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, and file-writing options, asserting each is unsafe.

**Call relations**: It covers the default-false behavior of `is_safe_to_call_with_exec` and the option filters for `find` and `sed`.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::base64_output_options_are_unsafe`  (lines 569–581)

```
fn base64_output_options_are_unsafe()
```

**Purpose**: Ensures `base64` is rejected when used with output-writing options. The command is only safe when it does not write to arbitrary files.

**Data flow**: The test iterates over `base64` argv vectors using `-o`, `--output`, `--output=...`, and compact `-o...` forms, asserting `is_safe_to_call_with_exec` returns `false`.

**Call relations**: It validates the `UNSAFE_BASE64_OPTIONS` checks in the direct safelist.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::ripgrep_rules`  (lines 584–615)

```
fn ripgrep_rules()
```

**Purpose**: Checks both safe and unsafe ripgrep invocations. It specifically guards against options that execute helper commands or external decompression tools.

**Data flow**: The test asserts a normal `rg Cargo.toml -n` is safe, then iterates over `--search-zip`, `-z`, `--pre`, `--pre=...`, `--hostname-bin`, and `--hostname-bin=...` forms and asserts each is unsafe.

**Call relations**: It covers the ripgrep-specific branch in `is_safe_to_call_with_exec`.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::windows_powershell_full_path_is_safe`  (lines 618–636)

```
fn windows_powershell_full_path_is_safe()
```

**Purpose**: On Windows, verifies that a discovered full-path PowerShell executable is still recognized as safe for a read-only command. This checks executable basename normalization across paths.

**Data flow**: The test returns early off Windows or if no PowerShell executable is found, otherwise converts the discovered path to string and asserts `is_known_safe_command([powershell, '-Command', 'Get-Location'])` is true.

**Call relations**: It exercises Windows-specific safe-command handling together with path-based executable normalization.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 2 external calls (assert!, cfg!).


##### `tests::windows_git_full_path_is_safe`  (lines 639–648)

```
fn windows_git_full_path_is_safe()
```

**Purpose**: On Windows, verifies that a full path to `git.exe` is recognized as git and classified safely for `status`. This guards the basename extraction logic.

**Data flow**: The test returns early off Windows, otherwise passes a full Git path plus `status` into `is_known_safe_command` and asserts `true`.

**Call relations**: It covers `executable_name_lookup_key` and git safety classification on Windows paths.

*Call graph*: 2 external calls (assert!, cfg!).


##### `tests::bash_lc_safe_examples`  (lines 651–680)

```
fn bash_lc_safe_examples()
```

**Purpose**: Checks representative shell-wrapped scripts that should be accepted as safe. These include simple commands, git status, grep, sed, and find.

**Data flow**: The test passes several `bash -lc <script>` vectors into `is_known_safe_command` and asserts each is safe.

**Call relations**: It validates the integration of shell parsing with direct-command safety checks.

*Call graph*: 1 external calls (assert!).


##### `tests::bash_lc_safe_examples_with_operators`  (lines 683–704)

```
fn bash_lc_safe_examples_with_operators()
```

**Purpose**: Verifies that shell scripts using allowed operators remain safe when every inner command is safe. This includes `||`, `&&`, `;`, and pipelines.

**Data flow**: The test checks shell-wrapped scripts like `grep ... || true`, `ls && pwd`, `echo 'hi' ; ls`, and `ls | wc -l`, asserting each is safe.

**Call relations**: It exercises `parse_shell_lc_plain_commands` plus the all-inner-commands-safe requirement in `is_known_safe_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::bash_lc_unsafe_examples`  (lines 707–743)

```
fn bash_lc_unsafe_examples()
```

**Purpose**: Covers shell-wrapped forms that must remain unsafe, including malformed wrappers, unsafe `find`, dangerous command sequences, subshells, and redirections. It documents several important rejection boundaries.

**Data flow**: The test passes multiple `bash -lc` vectors into `is_known_safe_command` and asserts `false`, with explanatory messages for four-arg wrappers, extra quoting, unsafe `find -delete`, `ls && rm -rf /`, subshells, and `> out.txt` redirection.

**Call relations**: It validates both shell-parser rejection and inner-command safety rejection paths.

*Call graph*: 1 external calls (assert!).


##### `tests::direct_powershell_words_use_windows_safelist`  (lines 746–754)

```
fn direct_powershell_words_use_windows_safelist()
```

**Purpose**: Checks that tokenized PowerShell-word safety delegates to the Windows safelist only on Windows. Non-Windows builds must not classify such words as safe.

**Data flow**: The test builds `['Get-Content', 'Cargo.toml']`, then conditionally asserts `is_safe_powershell_words` is `true` on Windows and `false` elsewhere.

**Call relations**: It covers the platform-gated public helper for already tokenized PowerShell commands.

*Call graph*: 3 external calls (assert!, cfg!, vec_str).


##### `tests::non_windows_safe_classification_does_not_spawn_repo_powershell_path`  (lines 758–801)

```
fn non_windows_safe_classification_does_not_spawn_repo_powershell_path()
```

**Purpose**: Regression test ensuring non-Windows safety classification never executes a repository-local fake `pwsh` binary while trying to classify a command. Classification must be purely lexical on non-Windows platforms.

**Data flow**: The test creates a temporary executable shell script named `pwsh` that would write a marker file if spawned, marks it executable, calls `is_known_safe_command` with that path and a PowerShell-looking command, asserts the result is unsafe and the marker file does not exist, then removes the temp directory.

**Call relations**: It protects against accidental process spawning during classification, especially around PowerShell detection paths.

*Call graph*: 10 external calls (now, assert!, format!, create, create_dir, metadata, remove_dir_all, set_permissions, temp_dir, writeln!).
