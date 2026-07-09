# Sandbox policy generation and command-safety parsing helpers  `stage-14.4`

This stage is shared safety support used before running tools. It helps answer two questions: “What is this command really doing?” and “What should the sandbox allow it to touch?” The legacy policy files define the building blocks for allowed command arguments: argument shapes, option objects, argument types, and a narrow safe form of sed line-printing commands. The sandbox files then turn requested permissions into actual confinement rules. On macOS, seatbelt.rs writes Seatbelt rules for sandbox-exec. On Linux, build.rs makes sure sandbox build checks notice the expected bubblewrap hash.

The shell-command files inspect command text before execution. bash.rs parses only simple Bash or Zsh forms into plain argument lists. powershell.rs and the PowerShell parser helper understand Windows PowerShell scripts without repeatedly starting a new parser. parse_command.rs summarizes common actions, while command_canonicalization.rs normalizes commands so approval decisions can be reused. The command_safety files are the gatekeepers: they recognize safe read-only commands, flag dangerous ones like forceful deletion, and apply stricter Windows-specific safe and dangerous command rules.

## Files in this stage

### Legacy policy argument model
These files define the legacy execution-policy language for command arguments, options, and narrowly validated value types.

### `execpolicy-legacy/src/arg_matcher.rs`

`data_model` · `policy/config loading and argument checking`

This file is about checking command arguments safely. A command like `cat input.txt` or `head -n 10 file.txt` is just a list of strings, but the execution policy needs to understand what each string means: is it a file to read, a file to write, a number, a fixed keyword, or something unknown? `ArgMatcher` is the set of allowed patterns for one position, or sometimes several positions, in that argument list.

The enum works like a set of labels on boxes. A `Literal` means “this exact string must appear.” `ReadableFile` and `WriteableFile` mark file paths with different permissions. `ReadableFiles` means one or more input files, while `ReadableFilesOrCwd` also allows no files, which implies the current working directory is the input. There are special cases for positive integers, safe `sed` commands, and unverified variable-length arguments.

The file also defines `ArgMatcherCardinality`, which says how many command arguments a matcher consumes: exactly one, at least one, or zero or more. Finally, it connects these Rust values to Starlark, the configuration language used by the policy system, so policy scripts can pass either matcher objects or plain strings. Plain strings are treated as literal argument matches.

#### Function details

##### `ArgMatcher::cardinality`  (lines 51–64)

```
fn cardinality(&self) -> ArgMatcherCardinality
```

**Purpose**: This function tells the checker how many command-line arguments a matcher is allowed to cover. For example, a single readable file takes one argument, while a list of readable files can take several.

**Data flow**: It starts with one `ArgMatcher` value. It looks at which kind of matcher it is, then returns a simple count rule: exactly one, at least one, or zero or more. It does not change anything; it only translates the matcher into its size requirement.

**Call relations**: This is used when the policy checker needs to walk through a command's arguments and decide how far each pattern reaches. It does not hand work off to other project functions; it simply returns the cardinality rule that later checking code can rely on.


##### `ArgMatcher::arg_type`  (lines 66–78)

```
fn arg_type(&self) -> ArgType
```

**Purpose**: This function converts an argument matcher into the more general argument type that the rest of the policy system understands. It answers, “if this matcher succeeds, what kind of argument did we find?”

**Data flow**: It takes an `ArgMatcher`, checks its variant, and produces an `ArgType`. A literal matcher becomes a literal argument type with the same string copied into it. File-list matchers become the single readable-file type because each item in the list is still a readable file. Unverified variable arguments become `Unknown`, because the matcher itself does not say what those arguments mean.

**Call relations**: This function sits between pattern matching and later permission reasoning. After a matcher describes what is allowed at a position, this function provides the type label that other policy code can use to decide whether the command reads files, writes files, uses numbers, or contains unknown arguments. Its only notable handoff is constructing the literal argument type when the matcher is a literal string.

*Call graph*: 1 external calls (Literal).


##### `ArgMatcherCardinality::is_exact`  (lines 88–94)

```
fn is_exact(&self) -> Option<usize>
```

**Purpose**: This function answers the narrow question: “does this count rule require an exact number of arguments?” At present, only the `One` rule has an exact count.

**Data flow**: It receives an `ArgMatcherCardinality`. If the rule is exactly one argument, it returns `Some(1)`. If the rule allows a variable number of arguments, it returns `None`, meaning there is no single fixed count.

**Call relations**: This is a convenience helper for code that can take a shortcut when a matcher has a fixed width. It does not call other functions; it simply turns the cardinality enum into an optional number for callers that need one.


##### `ArgMatcher::alloc_value`  (lines 98–100)

```
fn alloc_value(self, heap: Heap<'v>) -> Value<'v>
```

**Purpose**: This function makes an `ArgMatcher` available inside Starlark, the scripting language used for policy definitions. In plain terms, it puts the Rust value into Starlark's memory space so scripts can use it.

**Data flow**: It takes ownership of an `ArgMatcher` and receives a Starlark heap, which is the place where Starlark values are stored. It asks the heap to allocate the matcher as a simple value, then returns the resulting Starlark `Value` handle.

**Call relations**: This is called by the Starlark integration layer when an `ArgMatcher` needs to cross from Rust into policy script land. It hands the actual allocation to the heap's `alloc_simple` operation, because the heap owns the storage rules for Starlark values.

*Call graph*: 1 external calls (alloc_simple).


##### `ArgMatcher::unpack_value_impl`  (lines 111–117)

```
fn unpack_value_impl(value: Value<'v>) -> starlark::Result<Option<Self>>
```

**Purpose**: This function reads a Starlark value and tries to turn it into an `ArgMatcher`. It is what lets policy authors write either a matcher object or a plain string, where the plain string means “match this exact argument.”

**Data flow**: It receives a Starlark `Value`. First it checks whether that value is a Starlark string; if so, it copies the string into an `ArgMatcher::Literal`. If it is not a string, it checks whether the value already contains an `ArgMatcher` and clones it if found. If neither form matches, it returns `None` inside a successful result, meaning “this value was not an argument matcher.”

**Call relations**: This function is used by Starlark's value-unpacking machinery when Rust code expects an `ArgMatcher` from a policy script. Its main special behavior is the string shortcut: it constructs a literal matcher for plain strings, so policy files can stay concise instead of wrapping every fixed argument in an explicit matcher object.

*Call graph*: 1 external calls (Literal).


### `execpolicy-legacy/src/opt.rs`

`data_model` · `policy definition and Starlark value exchange`

This file is a small data model for command-line options. In plain terms, it describes things like “--help is a flag” or “--output needs a string value.” Without this shared shape, policy code would not have a reliable way to talk about which command-line arguments are allowed, required, or expected to carry a value.

The main type is `Opt`, which stores three facts: the option text as it appears on the command line, such as `-h` or `--help`; metadata saying whether it is just a flag or needs a value; and whether the option is required. The companion enum `OptMeta` explains the kind of option. A `Flag` takes no extra value. A `Value(ArgType)` takes one value of a particular argument type.

The file also connects these Rust types to Starlark, a small configuration language used by projects like Buck and Bazel. That means policy scripts can create or receive `Opt` values, and Rust can safely pull them back out. You can think of this as giving the option object a passport so it can cross between Rust code and Starlark scripts without losing its identity.

#### Function details

##### `Opt::new`  (lines 40–46)

```
fn new(opt: String, meta: OptMeta, required: bool) -> Self
```

**Purpose**: Creates a new command-line option description from its pieces. Someone uses this when they know the option spelling, what kind of value it accepts, and whether it must be present.

**Data flow**: It takes an option string, option metadata, and a required/not-required flag. It places those three inputs into a new `Opt` object and returns that object unchanged in meaning.

**Call relations**: This is the simple constructor for the `Opt` data type. Other parts of the policy system can call it when building the list of allowed or expected command-line options.


##### `Opt::name`  (lines 48–50)

```
fn name(&self) -> &str
```

**Purpose**: Returns the option’s command-line spelling, such as `--help`. This gives callers a read-only view of the option name without copying it.

**Data flow**: It reads the `opt` field from an existing `Opt` object and returns it as text borrowed from that object. Nothing is changed.

**Call relations**: This is used whenever surrounding code needs to compare, display, or inspect which command-line option an `Opt` represents.


##### `Opt::unpack_value_impl`  (lines 61–65)

```
fn unpack_value_impl(value: Value<'v>) -> starlark::Result<Option<Self>>
```

**Purpose**: Tries to read an `Opt` object out of a Starlark value. This is needed when Starlark policy code passes a value back into Rust and Rust needs to confirm it really is an option description.

**Data flow**: It receives a generic Starlark `Value`, checks whether that value contains an `Opt`, and if so clones and returns it. If the Starlark value is not an `Opt`, it returns `None`; if Starlark reports an error, that error can be returned.

**Call relations**: This function is part of the bridge from Starlark into Rust. The Starlark runtime calls it when Rust code asks to unpack a script value as an `Opt`.


##### `Opt::alloc_value`  (lines 69–71)

```
fn alloc_value(self, heap: Heap<'v>) -> Value<'v>
```

**Purpose**: Stores an `Opt` object on a Starlark heap so it can be used as a Starlark value. A heap here is the memory area where Starlark keeps values that scripts can refer to.

**Data flow**: It takes ownership of an `Opt` and receives a Starlark heap. It asks the heap to allocate the option as a simple stored value, then returns the resulting Starlark `Value` handle.

**Call relations**: This function is part of the bridge from Rust into Starlark. When Rust needs to hand an `Opt` to Starlark code, this method calls `alloc_simple` to place it into Starlark-managed memory.

*Call graph*: 1 external calls (alloc_simple).


### `execpolicy-legacy/src/arg_type.rs`

`data_model` · `policy construction and argument validation`

Execution policies need to understand command arguments well enough to decide whether a command is safe. For example, an argument might be a fixed word like `-n`, a file that will be read, a file that may be written, or a number. This file gives those categories a shared name: `ArgType`.

Think of `ArgType` like labels on boxes at a security checkpoint. A box labeled “readable file” must not be empty, because an empty filename is not meaningful. A box labeled “positive integer” must contain a number greater than zero. A box labeled “literal” must contain exactly the expected text. A `sed` command gets special checking, because `sed` scripts can do many things and only some are considered safe here.

The important part is that this file does not run commands. It classifies and validates their arguments before other code trusts them. Without this, the policy system would have a much weaker idea of what each command argument means, which could let bad or ambiguous command lines slip through.

It also provides a small helper to ask whether an argument type might write to a file. That matters because file-writing arguments are more dangerous than ordinary flags or read-only inputs.

#### Function details

##### `ArgType::validate`  (lines 32–70)

```
fn validate(&self, value: &str) -> Result<()>
```

**Purpose**: Checks whether a concrete command-line value matches this argument type. It turns a type label like “literal”, “positive integer”, or “safe sed command” into an actual yes-or-no validation step, with a specific error when the value is not acceptable.

**Data flow**: It receives an `ArgType` and a text value from a command line. It compares or parses that text according to the type: literals must match exactly, readable and writeable file names must not be empty, positive integers must parse as numbers greater than zero, and sed commands are passed to the sed-command parser for deeper checking. It returns success when the value fits, or an error explaining what was wrong.

**Call relations**: Two construction routines named `new` call this function when new policy-related values are being created. In the special `SedCommand` case, it hands the text to `parse_sed_command`, because sed syntax needs its own focused safety check rather than a simple string comparison.

*Call graph*: calls 1 internal fn (parse_sed_command); called by 2 (new, new).


##### `ArgType::might_write_file`  (lines 72–81)

```
fn might_write_file(&self) -> bool
```

**Purpose**: Answers the safety question: could an argument of this type cause a file to be written? This helps later policy decisions treat potentially writeable arguments more carefully.

**Data flow**: It reads the current `ArgType`. It returns `true` for `WriteableFile`, and also for `Unknown` because an unknown argument might be a file output. It returns `false` for fixed literals, non-file opaque values, positive integers, readable files, and checked sed commands.

**Call relations**: The call graph provided for this file does not show a specific caller, but this function is designed as a quick question other policy code can ask when deciding whether an argument should be treated as possibly modifying the filesystem.


### `execpolicy-legacy/src/sed_command.rs`

`domain_logic` · `validation`

This file exists as a small safety gate for `sed`, a common text-processing tool. Some `sed` commands can do much more than print text, so this code does not try to understand every possible command. Instead, it only approves one very narrow shape: two positive line numbers separated by a comma, ending with `p`, which means “print these lines.” An everyday analogy is a door guard with a very short guest list: if the command does not exactly match the approved pattern, it is turned away.

The check works by peeling the command apart. First it looks for a final `p`. Then it checks that what comes before can be split into two parts around a comma. Finally, it verifies that both parts are valid whole numbers. If all of that is true, the command is accepted. If anything is missing or malformed, the function returns an error saying the command is not provably safe.

This matters because the surrounding validation code can rely on this file to be deliberately conservative. It may reject commands that a human knows are harmless, but it avoids accidentally approving a command whose behavior is unclear or dangerous.

#### Function details

##### `parse_sed_command`  (lines 4–17)

```
fn parse_sed_command(sed_command: &str) -> Result<()>
```

**Purpose**: This function decides whether a `sed` command is in the one safe form this program currently recognizes: a numeric line range followed by `p`, like `122,202p`. It is used to reject anything more complex or unclear.

**Data flow**: It receives the command as text. It checks whether the text ends in `p`, whether the remaining text contains one comma, and whether both sides of that comma are valid whole numbers. If all checks pass, it returns success with no extra data; otherwise, it returns an error that includes the original command text.

**Call relations**: The broader `validate` flow calls this when it needs to confirm that a requested `sed` command is safe enough to allow. This function does the narrow pattern check and hands back either approval or a clear rejection, so validation can stop unsafe or unsupported commands before they are used.

*Call graph*: called by 1 (validate).


### Sandbox policy construction
These files turn higher-level sandbox permissions into concrete platform-specific confinement artifacts and build-time wiring.

### `linux-sandbox/build.rs`

`config` · `build time`

Rust crates can include a build script, which is a tiny program Cargo runs before compiling the crate. This file uses that hook for one specific purpose: it tells Cargo that the build should be considered out of date if the environment variable CODEX_BWRAP_SHA256 changes. An environment variable is a value supplied from outside the program, often by the shell or build system. Here, the variable name suggests it contains a SHA-256 checksum for bubblewrap, a Linux sandboxing tool. The script does not read or verify the value itself. Instead, it prints a special instruction that Cargo understands: “rerun this build script if this environment variable changes.” Without this, Cargo might reuse an old build result even after the checksum setting changed, which could make the build behave as if it still had the old configuration. Think of it like putting a sticky note on a recipe: if this ingredient label changes, check the recipe again before cooking.

#### Function details

##### `main`  (lines 1–3)

```
fn main()
```

**Purpose**: This is the build script’s entry point. It tells Cargo to rerun the build script whenever the CODEX_BWRAP_SHA256 environment variable changes.

**Data flow**: It takes no direct input from the program. When Cargo runs it, it writes one specially formatted line to standard output; Cargo reads that line and records CODEX_BWRAP_SHA256 as a build dependency. The result is not a normal return value, but a change in Cargo’s rebuild tracking.

**Call relations**: Cargo calls this function automatically before compiling the crate. The function hands its instruction to Cargo by printing it, using Rust’s println! macro, and Cargo uses that instruction later to decide whether the build script needs to run again.

*Call graph*: 1 external calls (println!).


### `sandboxing/src/policy_transforms.rs`

`domain_logic` · `permission setup and sandbox policy calculation`

This file is the permission “adapter” for the sandbox. A sandbox is a safety boundary that limits what the program can read, write, or access on the network. Users or clients may ask for extra access, but those requests arrive in a flexible form: paths may be relative, duplicate rules may appear, and some rules depend on the current working directory. This file cleans that up and turns it into concrete policies the rest of the system can enforce.

The main flow is: normalize extra permissions, merge permissions from different sources, intersect requested permissions with granted permissions, and then produce the effective file-system and network sandbox policies. Think of it like checking several guest lists before opening a door: one list says what was requested, one says what was granted, and the final list says who actually gets in.

The file is careful with deny rules. A deny rule means “even if a broader read is allowed, this part must stay blocked.” It keeps deny rules when they still restrict an accepted grant, including deny rules written as glob patterns, where a pattern like `*.secret` may match many files. It also resolves special paths such as the project root, the system root, or temporary directories when possible.

Without this file, added permissions could be too loose, duplicated, inconsistent, or impossible for the sandbox to enforce correctly.

#### Function details

##### `normalize_additional_permissions`  (lines 19–69)

```
fn normalize_additional_permissions(
    additional_permissions: AdditionalPermissionProfile,
) -> Result<AdditionalPermissionProfile, String>
```

**Purpose**: Cleans up an extra permission profile before it is used. It removes empty sections, makes real file paths more stable, rejects unsupported glob permissions, and removes duplicate file-system entries.

**Data flow**: It receives an `AdditionalPermissionProfile`, which may contain network and file-system permissions. It drops empty network permissions, walks each file-system entry, canonicalizes normal paths when possible while preserving symbolic links, leaves special paths and glob patterns in their own forms, rejects glob entries unless they are deny rules, and removes duplicates. It returns either the cleaned profile or an error message explaining why the profile is invalid.

**Call relations**: This is called when permissions are written for paths, when extra permissions are normalized and validated, and when a call is handled. It prepares permission data before later code merges it or applies it to a sandbox.

*Call graph*: called by 3 (write_permissions_for_paths, normalize_and_validate_additional_permissions, handle_call); 3 external calls (with_capacity, canonicalize_preserving_symlinks, matches!).


##### `merge_permission_profiles`  (lines 71–123)

```
fn merge_permission_profiles(
    base: Option<&AdditionalPermissionProfile>,
    permissions: Option<&AdditionalPermissionProfile>,
) -> Option<AdditionalPermissionProfile>
```

**Purpose**: Combines two extra permission profiles into one. It is used when permissions come from more than one place and the system needs a single combined view.

**Data flow**: It receives an optional base profile and an optional additional profile. If the new profile is missing, it keeps the base. If both exist, it enables network access if either profile explicitly enables it, combines file-system entries without duplicates, and chooses a safe combined glob scan depth. It returns no profile if the result is empty.

**Call relations**: This is used when granted permissions are recorded, when granted turn permissions are applied, when patch permissions are calculated, and in tests around preapproved deny glob behavior. It relies on `merge_permission_entries` for file entries and `merge_glob_scan_max_depth` for glob scanning limits.

*Call graph*: calls 2 internal fn (merge_glob_scan_max_depth, merge_permission_entries); called by 5 (record_granted_permissions, record_granted_permissions, apply_granted_turn_permissions, effective_patch_permissions, relative_deny_glob_grants_remain_preapproved_after_materialization).


##### `intersect_permission_profiles`  (lines 125–195)

```
fn intersect_permission_profiles(
    requested: AdditionalPermissionProfile,
    granted: AdditionalPermissionProfile,
    cwd: &Path,
) -> AdditionalPermissionProfile
```

**Purpose**: Finds the permissions that are both requested and granted. This prevents the system from accepting a grant that goes beyond what was actually asked for.

**Data flow**: It receives a requested profile, a granted profile, and the current working directory. For file-system permissions, it builds a temporary policy from the requested entries, accepts only granted read-capable entries that fit inside that request, materializes entries that depend on the working directory, and keeps deny entries that still restrict the accepted grants. For network permissions, it only enables network access if both requested and granted profiles enable it. It returns the final intersected profile.

**Call relations**: This is used when a client responds to a permission request, when permission responses are normalized, and when checking whether permissions are already preapproved. Internally it coordinates the file-entry checks, deny-rule retention, path resolution, and glob scan depth merging.

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

**Purpose**: Combines the scan-depth limits for glob deny rules. A scan depth is how far the system should look through directories when applying a glob pattern.

**Data flow**: It receives two sets of file-system entries and their optional depth limits. It first asks whether each side actually has deny glob rules. If either side has an unbounded glob scan, the combined result is unbounded. If both have bounded depths, it keeps the larger depth. If only one side has a relevant depth, it uses that one. It returns the merged depth or no limit.

**Call relations**: This is used when permission profiles are merged and when extra file-system permissions are folded into an existing sandbox policy. It depends on `effective_glob_scan_depth` to ignore depth settings that do not matter because there are no glob deny entries.

*Call graph*: calls 1 internal fn (effective_glob_scan_depth); called by 2 (merge_file_system_policy_with_additional_permissions, merge_permission_profiles).


##### `effective_glob_scan_depth`  (lines 217–231)

```
fn effective_glob_scan_depth(
    entries: &[FileSystemSandboxEntry],
    depth: Option<usize>,
) -> Option<GlobScanDepth>
```

**Purpose**: Determines whether a set of entries really needs a glob scan depth. It treats the depth as meaningful only when there is at least one deny rule written as a glob pattern.

**Data flow**: It receives file-system entries and an optional numeric depth. It scans the entries for a deny glob. If none exists, it returns nothing. If one exists, it returns either a bounded depth using the given number or an unbounded marker when no number was provided.

**Call relations**: This helper is called by `merge_glob_scan_max_depth`. It keeps unrelated depth values from affecting profiles that do not use glob deny rules.

*Call graph*: called by 1 (merge_glob_scan_max_depth); 2 external calls (iter, Bounded).


##### `granted_file_system_entry_within_request`  (lines 239–265)

```
fn granted_file_system_entry_within_request(
    requested: &FileSystemPermissions,
    requested_policy: &FileSystemSandboxPolicy,
    requested_read_deny_matcher: Option<&ReadDenyMatcher>,
    grant
```

**Purpose**: Checks whether one granted file-system permission fits inside what was requested. It is a safety check that stops broader-than-requested access from slipping through.

**Data flow**: It receives the requested file-system permissions, the requested policy, an optional read-deny matcher, a granted entry, and the current working directory. It rejects granted entries that cannot read. If the granted path can be resolved to a concrete path, it checks that the path is not denied by the requested deny rules and that the requested access covers the granted access. If the path cannot be resolved, it only accepts an exact matching requested entry with enough access. It returns true or false.

**Call relations**: This helper is part of the intersection flow in `intersect_permission_profiles`. It uses `resolve_permission_path` to turn special paths into real paths and `access_covers` to compare requested access with granted access.

*Call graph*: calls 3 internal fn (resolve_access_with_cwd, access_covers, resolve_permission_path).


##### `retain_constraining_deny_entries`  (lines 267–288)

```
fn retain_constraining_deny_entries(
    source_entries: &[FileSystemSandboxEntry],
    accepted_entries: &[FileSystemSandboxEntry],
    cwd: &Path,
    output_entries: &mut Vec<FileSystemSandboxEntry
```

**Purpose**: Keeps deny rules that still matter after grants have been accepted. This matters because a broad allowed read may still need a smaller blocked area inside it.

**Data flow**: It receives a source list of entries, the already accepted grant entries, the current working directory, and an output list to append to. It looks only at deny entries, keeps the ones that overlap accepted readable grants, materializes working-directory-dependent paths, avoids duplicates in the output list, and returns the deny entries it retained.

**Call relations**: This is used during profile intersection after accepted grants are known. It calls `deny_entry_constrains_accepted_grant` to decide whether a deny rule matters and `materialize_cwd_dependent_entry` before adding retained rules to the final output.

*Call graph*: calls 2 internal fn (deny_entry_constrains_accepted_grant, materialize_cwd_dependent_entry); 2 external calls (new, iter).


##### `deny_entry_constrains_accepted_grant`  (lines 290–312)

```
fn deny_entry_constrains_accepted_grant(
    deny_entry: &FileSystemSandboxEntry,
    accepted_entries: &[FileSystemSandboxEntry],
    cwd: &Path,
) -> bool
```

**Purpose**: Decides whether a deny rule actually restricts any accepted readable grant. If it does not overlap any accepted grant, keeping it would not change the final permission outcome.

**Data flow**: It receives one deny entry, the accepted entries, and the current working directory. For each accepted readable grant, it resolves the grant to a concrete path. If the deny entry is a glob pattern, it estimates the pattern’s fixed path prefix and checks whether that prefix overlaps the grant. If the deny entry is a normal or special path, it resolves it and checks overlap directly. It returns true if any accepted grant is constrained.

**Call relations**: This is called by `retain_constraining_deny_entries`. It is the filter that decides which deny rules should survive into an intersected permission profile.

*Call graph*: called by 1 (retain_constraining_deny_entries); 1 external calls (iter).


##### `glob_static_prefix_path`  (lines 314–333)

```
fn glob_static_prefix_path(pattern: &str, cwd: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the non-wildcard path prefix of a glob pattern. This gives the code a concrete area of the file tree to compare against grants.

**Data flow**: It receives a glob pattern string and the current working directory. It resolves the pattern against that directory, finds the first wildcard character such as `*` or `?`, and keeps the path portion before that wildcard. If the pattern starts with a wildcard or the prefix cannot be made absolute, it returns nothing. Otherwise it returns the absolute prefix path.

**Call relations**: This supports deny-rule overlap checks for glob patterns. It gives `deny_entry_constrains_accepted_grant` a usable path prefix when the full pattern cannot be treated as one concrete path.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); 1 external calls (new).


##### `paths_overlap`  (lines 335–337)

```
fn paths_overlap(left: &Path, right: &Path) -> bool
```

**Purpose**: Checks whether two paths cover some of the same file-tree area. One path overlaps another when either one is inside the other.

**Data flow**: It receives two paths. It checks whether the left path starts with the right path or the right path starts with the left path. It returns true if either is true, otherwise false.

**Call relations**: This is used by the deny-rule overlap logic to decide whether a deny rule could affect an accepted grant.

*Call graph*: 1 external calls (starts_with).


##### `access_covers`  (lines 339–345)

```
fn access_covers(requested: FileSystemAccessMode, granted: FileSystemAccessMode) -> bool
```

**Purpose**: Checks whether requested access is strong enough to include granted access. For example, a request that can read covers a granted read, but deny never counts as a grant.

**Data flow**: It receives a requested access mode and a granted access mode. For a granted read, it checks whether the requested mode can read. For a granted write, it checks whether the requested mode can write. For a granted deny, it returns false. The output is a yes-or-no answer.

**Call relations**: This is called by `granted_file_system_entry_within_request` when deciding whether an accepted grant stays within the original request.

*Call graph*: calls 2 internal fn (can_read, can_write); called by 1 (granted_file_system_entry_within_request).


##### `materialize_cwd_dependent_entry`  (lines 347–370)

```
fn materialize_cwd_dependent_entry(
    entry: &FileSystemSandboxEntry,
    cwd: &Path,
) -> FileSystemSandboxEntry
```

**Purpose**: Turns permission entries that depend on the current working directory into concrete entries when possible. This makes later comparisons and stored permissions more stable.

**Data flow**: It receives a file-system entry and the current working directory. Project-root special paths are resolved into normal absolute paths when possible. Glob patterns are resolved against the working directory so relative patterns become absolute-looking patterns. Other normal or special paths are left unchanged. It returns the materialized entry.

**Call relations**: This is called when accepted grants and retained deny entries are built during intersection. It uses `resolve_permission_path` for special path resolution and absolute-path utilities for glob patterns.

*Call graph*: calls 2 internal fn (resolve_permission_path, resolve_path_against_base); called by 1 (retain_constraining_deny_entries); 1 external calls (clone).


##### `resolve_permission_path`  (lines 372–404)

```
fn resolve_permission_path(path: &FileSystemPath, cwd: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Converts a permission path into a concrete absolute path when that is possible. Some permission paths are symbolic, such as “project root” or “temporary directory,” and this function gives them real locations.

**Data flow**: It receives a permission path and the current working directory. Normal path entries are returned as-is. Glob patterns cannot become one exact path, so they return nothing. Special paths are resolved based on their meaning: root becomes the filesystem root for the current directory, project roots become the current directory or a subpath under it, temporary-directory entries use environment or `/tmp` where valid, and unknown or minimal special paths return nothing. The output is an absolute path or nothing.

**Call relations**: This is used by `granted_file_system_entry_within_request` and `materialize_cwd_dependent_entry`. It is the shared translator from human-friendly or special path forms to concrete paths.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); called by 2 (granted_file_system_entry_within_request, materialize_cwd_dependent_entry); 5 external calls (ancestors, as_path, from, clone, var_os).


##### `merge_permission_entries`  (lines 406–417)

```
fn merge_permission_entries(
    base: &[FileSystemSandboxEntry],
    permissions: &[FileSystemSandboxEntry],
) -> Vec<FileSystemSandboxEntry>
```

**Purpose**: Combines two lists of file-system permission entries without keeping duplicates. It preserves the order in which entries are first seen.

**Data flow**: It receives a base list and an additional list. It walks through both lists in order, copies each entry into a new list only if it is not already there, and returns the new combined list.

**Call relations**: This is called by `merge_permission_profiles` when two profiles both contain file-system permissions.

*Call graph*: called by 1 (merge_permission_profiles); 3 external calls (with_capacity, iter, len).


##### `merge_file_system_policy_with_additional_permissions`  (lines 419–443)

```
fn merge_file_system_policy_with_additional_permissions(
    file_system_policy: &FileSystemSandboxPolicy,
    additional_permissions: &FileSystemPermissions,
) -> FileSystemSandboxPolicy
```

**Purpose**: Adds extra file-system permissions to an existing file-system sandbox policy, but only when the policy is the kind that can be extended safely.

**Data flow**: It receives a current file-system sandbox policy and extra file-system permissions. If the policy is restricted, it clones the policy, appends any non-duplicate extra entries, merges the glob scan depth, and returns the expanded policy. If the policy is unrestricted or controlled by an external sandbox, it simply returns a clone of the original policy.

**Call relations**: This is called by `effective_file_system_sandbox_policy`. It is the point where cleaned extra file permissions are actually folded into the runtime sandbox policy.

*Call graph*: calls 1 internal fn (merge_glob_scan_max_depth); called by 1 (effective_file_system_sandbox_policy); 1 external calls (clone).


##### `effective_file_system_sandbox_policy`  (lines 445–464)

```
fn effective_file_system_sandbox_policy(
    file_system_policy: &FileSystemSandboxPolicy,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> FileSystemSandboxPolicy
```

**Purpose**: Computes the file-system sandbox policy that should actually be used after considering optional extra permissions.

**Data flow**: It receives the base file-system policy and optional extra permissions. If there are no extra permissions, no file-system section, or an empty file-system section, it returns the base policy unchanged. Otherwise it merges the extra file-system permissions into the base policy and returns the result.

**Call relations**: This is used when building sandbox contexts, calculating patch permissions, and producing an effective full permission profile. It hands off the actual merge work to `merge_file_system_policy_with_additional_permissions`.

*Call graph*: calls 1 internal fn (merge_file_system_policy_with_additional_permissions); called by 5 (file_system_sandbox_context, effective_patch_permissions, file_system_sandbox_context_uses_active_attempt, file_system_sandboxed_write_allows_additional_write_root, effective_permission_profile); 1 external calls (clone).


##### `merge_network_access`  (lines 466–476)

```
fn merge_network_access(
    base_network_access: bool,
    additional_permissions: &AdditionalPermissionProfile,
) -> bool
```

**Purpose**: Answers whether network access should be considered enabled after adding extra permissions. Network access is enabled if it was already enabled or if the extra permissions explicitly enable it.

**Data flow**: It receives the base network-access boolean and an extra permission profile. It checks whether the base is already true; if not, it looks for an explicit `enabled: true` in the extra network permissions. It returns the combined yes-or-no result.

**Call relations**: This helper is used by `effective_network_sandbox_policy` to keep the network decision simple and consistent.


##### `effective_network_sandbox_policy`  (lines 478–491)

```
fn effective_network_sandbox_policy(
    network_policy: NetworkSandboxPolicy,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> NetworkSandboxPolicy
```

**Purpose**: Computes the network sandbox policy that should actually be used after considering optional extra permissions.

**Data flow**: It receives the base network policy and optional extra permissions. If the combined result says network access is enabled, it returns an enabled network policy. If extra permissions were present but did not enable network access, it returns a restricted policy. If there were no extra permissions, it keeps the original policy.

**Call relations**: This is used when building sandbox contexts and when producing an effective full permission profile. It uses the same network-merge decision as `merge_network_access`.

*Call graph*: called by 4 (file_system_sandbox_context, file_system_sandbox_context_uses_active_attempt, file_system_sandboxed_write_allows_additional_write_root, effective_permission_profile).


##### `effective_permission_profile`  (lines 493–507)

```
fn effective_permission_profile(
    permission_profile: &PermissionProfile,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> PermissionProfile
```

**Purpose**: Builds a complete effective permission profile from a named profile plus optional extra permissions. It keeps the profile’s enforcement style while changing the file-system and network rules as needed.

**Data flow**: It receives a `PermissionProfile` and optional extra permissions. It converts the profile into runtime file-system and network policies, applies extra file-system permissions, applies extra network permissions, and then converts the result back into a `PermissionProfile` while preserving the original enforcement setting. It returns the finished profile.

**Call relations**: This is called when building a sandbox context for an attempt, when transforming profiles, and in permission-escalation tests. It coordinates `effective_file_system_sandbox_policy` and `effective_network_sandbox_policy` so callers get one updated profile instead of separate policies.

*Call graph*: calls 5 internal fn (enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions, effective_file_system_sandbox_policy, effective_network_sandbox_policy); called by 3 (file_system_sandbox_context_for_attempt, preapproved_additional_permissions_escalate_intercepted_exec, transform).


##### `should_require_platform_sandbox`  (lines 509–529)

```
fn should_require_platform_sandbox(
    file_system_policy: &FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    has_managed_network_requirements: bool,
) -> bool
```

**Purpose**: Decides whether the program should require the operating-system-level sandbox for a given file-system and network setup. This is the final safety gate for whether platform enforcement is needed.

**Data flow**: It receives a file-system policy, a network policy, and a flag saying whether there are managed network requirements. If managed network requirements exist, it requires the platform sandbox. If network access is not enabled, it requires a sandbox unless the file-system policy is handled by an external sandbox. If network access is enabled, it requires a sandbox only for restricted file-system policies that do not already allow full disk writes. It returns true or false.

**Call relations**: This is used when tagging permission profiles, warning about system sandbox support, and selecting the initial sandbox setup. It turns the combined policy state into a simple decision about whether platform sandboxing must be active.

*Call graph*: calls 2 internal fn (has_full_disk_write_access, is_enabled); called by 3 (permission_profile_sandbox_tag, should_warn_about_system_bwrap, select_initial); 1 external calls (matches!).


### `sandboxing/src/seatbelt.rs`

`domain_logic` · `command launch`

macOS has a built-in sandbox system called Seatbelt. A Seatbelt policy is a small rule file that says things like “this process may read here,” “it may write there,” or “it may only connect to this local proxy.” This file is the translator between Codex's higher-level permissions and those low-level macOS rules.

The main job is to build the argument list for `sandbox-exec`: first the generated policy text, then named path parameters, then the actual command to run. The file combines several pieces: fixed base policy snippets, file read/write allowances, explicit deny rules for unreadable glob patterns, and network rules. The network side is careful with proxies. If a managed proxy is configured, it tries to allow only loopback proxy ports, rather than opening the whole network. It can also allow selected Unix domain sockets, which are local socket files used for communication between programs on the same machine.

A key safety theme is “fail closed.” If proxy settings exist but cannot be turned into safe local endpoints, the generated policy does not silently grant wider network access. Paths are also normalized before being passed into Seatbelt, so the policy refers to stable absolute paths instead of ambiguous relative ones.

#### Function details

##### `is_loopback_host`  (lines 31–33)

```
fn is_loopback_host(host: &str) -> bool
```

**Purpose**: Checks whether a host name points back to the same machine. This matters because proxy access is only treated as safe and narrow when it goes through local addresses such as `localhost`, `127.0.0.1`, or `::1`.

**Data flow**: It receives a host string, compares it with the accepted loopback names and addresses, and returns true if it is local or false otherwise. It does not change any outside state.

**Call relations**: When proxy settings are inspected, `proxy_loopback_ports_from_env` asks this helper whether each proxy URL points to the local machine. Only local proxy hosts are turned into Seatbelt network allowances.

*Call graph*: called by 1 (proxy_loopback_ports_from_env).


##### `proxy_scheme_default_port`  (lines 35–41)

```
fn proxy_scheme_default_port(scheme: &str) -> u16
```

**Purpose**: Provides the usual port number for a proxy URL when the URL does not spell one out. For example, HTTPS commonly uses 443 and SOCKS commonly uses 1080.

**Data flow**: It receives a URL scheme such as `https` or `socks5`, chooses the standard fallback port for that scheme, and returns the port number. Unknown schemes fall back to port 80.

**Call relations**: It supports proxy URL parsing by filling in missing port numbers. That lets the surrounding proxy policy code still create a precise sandbox rule even when the environment variable uses a shortened proxy address.


##### `proxy_loopback_ports_from_env`  (lines 43–76)

```
fn proxy_loopback_ports_from_env(env: &HashMap<String, String>) -> Vec<u16>
```

**Purpose**: Finds proxy ports in environment variables, but only for proxies that point to the local machine. This helps the sandbox allow traffic to a local proxy without allowing general internet access.

**Data flow**: It receives a map of environment variable names to values. It looks through the known proxy variables, cleans up each value, parses it as a URL, rejects anything invalid or non-local, chooses an explicit or default port, removes duplicates, and returns the sorted list of local proxy ports.

**Call relations**: `proxy_policy_inputs` uses this when it has a `NetworkProxy` configuration. The resulting ports become the specific loopback destinations allowed by `dynamic_network_policy_for_network`.

*Call graph*: calls 1 internal fn (is_loopback_host); called by 1 (proxy_policy_inputs); 4 external calls (new, parse, proxy_url_env_value, format!).


##### `UnixDomainSocketPolicy::default`  (lines 94–96)

```
fn default() -> Self
```

**Purpose**: Creates the safest default Unix socket policy: no broad socket access and no allowed socket paths. A Unix domain socket is a local communication endpoint represented by a filesystem path.

**Data flow**: It takes no input and returns a `Restricted` socket policy with an empty allowlist. Nothing outside the returned value is changed.

**Call relations**: This default is used when proxy policy inputs are built without special socket permissions. Later helpers expand this only if the network configuration or caller supplies socket paths.

*Call graph*: 1 external calls (vec!).


##### `proxy_policy_inputs`  (lines 105–153)

```
fn proxy_policy_inputs(
    network: Option<&NetworkProxy>,
    extra_allow_unix_sockets: &[AbsolutePathBuf],
) -> ProxyPolicyInputs
```

**Purpose**: Collects all network-proxy-related facts needed to write the Seatbelt network policy. It turns a higher-level proxy configuration into concrete details: local proxy ports, whether proxy variables exist, whether local binding is allowed, and which Unix sockets are allowed.

**Data flow**: It receives an optional `NetworkProxy` and extra Unix socket paths. It normalizes socket paths, asks the proxy to write its environment settings into a temporary map, extracts loopback proxy ports, checks whether proxy variables are present, and builds a socket policy. It returns a `ProxyPolicyInputs` bundle used by later policy builders.

**Call relations**: `create_seatbelt_command_args` calls this before building network rules. The returned bundle is then passed into `dynamic_network_policy_for_network` for text policy generation and into `unix_socket_dir_params` for command-line path definitions.

*Call graph*: calls 1 internal fn (proxy_loopback_ports_from_env); called by 1 (create_seatbelt_command_args); 4 external calls (default, new, has_proxy_url_env_vars, iter).


##### `normalize_path_for_sandbox`  (lines 155–169)

```
fn normalize_path_for_sandbox(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Turns an absolute path into the cleanest absolute form available for use in a sandbox rule. It refuses relative paths because accepting them could make the policy depend on the process's current directory in surprising ways.

**Data flow**: It receives a filesystem path. If the path is not absolute, it returns nothing. If it is absolute, it wraps it as an absolute path and tries to canonicalize it, which means resolving links and `..` where the filesystem allows. It returns the canonical path when possible, otherwise the original absolute path.

**Call relations**: Path-building functions call this before inserting paths into Seatbelt parameters or glob-derived rules. It is an important safety step for `build_seatbelt_access_policy` and `canonicalize_glob_static_prefix_for_sandbox`.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (build_seatbelt_access_policy, canonicalize_glob_static_prefix_for_sandbox); 1 external calls (is_absolute).


##### `unix_socket_path_params`  (lines 171–187)

```
fn unix_socket_path_params(proxy: &ProxyPolicyInputs) -> Vec<UnixSocketPathParam>
```

**Purpose**: Prepares a clean, numbered list of Unix socket paths that the sandbox may use. Numbering is needed because Seatbelt policies refer to external path values through named parameters.

**Data flow**: It receives the proxy policy input bundle. If socket access is unrestricted, it returns an empty list because no per-path parameters are needed. If access is restricted, it removes duplicate allowed paths, sorts them by their string form, assigns each one an index, and returns those indexed path records.

**Call relations**: `unix_socket_policy` uses this list to write socket allow rules, and `unix_socket_dir_params` uses the same list to create the matching `-D` command-line definitions. These two uses must agree on the generated parameter names.

*Call graph*: called by 2 (unix_socket_dir_params, unix_socket_policy); 2 external calls (new, vec!).


##### `unix_socket_path_param_key`  (lines 189–191)

```
fn unix_socket_path_param_key(index: usize) -> String
```

**Purpose**: Builds the parameter name for one allowed Unix socket path. This keeps the policy text and the command-line definitions using the same naming pattern.

**Data flow**: It receives a numeric index and returns a string such as `UNIX_SOCKET_PATH_0`. It does not read or change anything else.

**Call relations**: `unix_socket_policy` calls this while writing Seatbelt rules for each socket path. `unix_socket_dir_params` uses the same naming scheme through the path parameter records so the policy can find the actual paths at runtime.

*Call graph*: called by 1 (unix_socket_policy); 1 external calls (format!).


##### `unix_socket_dir_params`  (lines 193–203)

```
fn unix_socket_dir_params(proxy: &ProxyPolicyInputs) -> Vec<(String, PathBuf)>
```

**Purpose**: Creates the command-line parameter definitions for allowed Unix socket paths. These definitions are how the generated Seatbelt policy receives real filesystem paths without hard-coding them directly into the policy text.

**Data flow**: It receives proxy policy inputs, asks `unix_socket_path_params` for the numbered allowed paths, converts each path into a normal path buffer, and returns key/path pairs. The caller later formats those pairs as `-DKEY=value` arguments.

**Call relations**: `create_seatbelt_command_args` calls this after building the main policy sections. Its output is appended beside file read/write path parameters so `sandbox-exec` can substitute the socket paths into the policy.

*Call graph*: calls 1 internal fn (unix_socket_path_params); called by 1 (create_seatbelt_command_args).


##### `unix_socket_policy`  (lines 208–242)

```
fn unix_socket_policy(proxy: &ProxyPolicyInputs) -> String
```

**Purpose**: Writes the Seatbelt rules that allow Unix domain socket communication. It either allows all Unix sockets when explicitly requested, or allows only sockets under approved paths.

**Data flow**: It receives proxy policy inputs. If no Unix socket access is allowed, it returns an empty string. If all sockets are allowed, it returns broad socket rules. Otherwise, it builds one pair of bind and outbound rules for each allowed socket path parameter and returns the policy text, ending with newlines so it can be appended safely.

**Call relations**: `dynamic_network_policy_for_network` includes this text when network policy needs local socket access. It relies on `unix_socket_path_params` and `unix_socket_path_param_key` so the policy text lines up with the parameter definitions created elsewhere.

*Call graph*: calls 2 internal fn (unix_socket_path_param_key, unix_socket_path_params); called by 1 (dynamic_network_policy_for_network); 3 external calls (new, format!, matches!).


##### `dynamic_network_policy`  (lines 245–255)

```
fn dynamic_network_policy(
    sandbox_policy: &SandboxPolicy,
    enforce_managed_network: bool,
    proxy: &ProxyPolicyInputs,
) -> String
```

**Purpose**: Adapts the older, combined sandbox policy type into the newer network-policy-specific builder. It exists as a compatibility wrapper so callers with a full `SandboxPolicy` can still ask for network Seatbelt text.

**Data flow**: It receives a full sandbox policy, a flag saying whether managed networking must be enforced, and proxy policy inputs. It extracts the network portion from the full policy and passes everything to `dynamic_network_policy_for_network`, then returns that generated policy string.

**Call relations**: This function is a thin bridge into `dynamic_network_policy_for_network`. It is mainly useful for tests or legacy paths that still start from the broader `SandboxPolicy` type.

*Call graph*: calls 2 internal fn (from, dynamic_network_policy_for_network).


##### `dynamic_network_policy_for_network`  (lines 257–319)

```
fn dynamic_network_policy_for_network(
    network_policy: NetworkSandboxPolicy,
    enforce_managed_network: bool,
    proxy: &ProxyPolicyInputs,
) -> String
```

**Purpose**: Creates the Seatbelt network rules for the sandboxed command. It decides between full network access, proxy-only local access, Unix-socket access, or no network access.

**Data flow**: It receives the requested network policy, a managed-network enforcement flag, and proxy details. It checks whether proxy ports, proxy configuration, enforced managed networking, or Unix socket needs require a restricted policy. It then builds allow rules for local binding, DNS when needed, loopback proxy ports, and Unix sockets, or returns broader network rules when full networking is enabled and no proxy restriction applies. If safe proxy endpoints are missing while proxy enforcement is expected, it returns an empty policy rather than opening the network.

**Call relations**: `create_seatbelt_command_args` calls this while assembling the complete Seatbelt policy. The compatibility wrapper `dynamic_network_policy` also delegates to it. It calls `unix_socket_policy` when local socket communication must be included.

*Call graph*: calls 2 internal fn (is_enabled, unix_socket_policy); called by 2 (create_seatbelt_command_args, dynamic_network_policy); 3 external calls (from, new, format!).


##### `root_absolute_path`  (lines 321–326)

```
fn root_absolute_path() -> AbsolutePathBuf
```

**Purpose**: Creates an absolute path object for `/`, the filesystem root. This is used when the policy needs to describe access starting at the whole disk, usually with exclusions carved out.

**Data flow**: It takes no input, converts `/` into the project's absolute path type, and returns it. If that ever failed, it panics because `/` must be absolute on macOS and Unix-like systems.

**Call relations**: `create_seatbelt_command_args` uses this when full-disk read or write access is requested but some unreadable roots still need to be excluded. The root path is then passed into `build_seatbelt_access_policy`.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (new, panic!).


##### `build_seatbelt_access_policy`  (lines 335–390)

```
fn build_seatbelt_access_policy(
    action: &str,
    param_prefix: &str,
    roots: Vec<SeatbeltAccessRoot>,
) -> (String, Vec<(String, PathBuf)>)
```

**Purpose**: Builds Seatbelt allow rules for file reads or writes over one or more approved roots. It can also carve out subpaths and protected metadata names so a broad root does not accidentally expose sensitive project control files.

**Data flow**: It receives an action name such as `file-read*` or `file-write*`, a parameter name prefix, and a list of access roots. For each root, it normalizes the path, creates a parameter for it, adds exclusions for protected subpaths, and adds regex-based exclusions for protected metadata names. It returns two things: the policy text and the path parameters that must be passed to `sandbox-exec`.

**Call relations**: `create_seatbelt_command_args` calls this separately for read and write permissions. It uses `normalize_path_for_sandbox` for stable paths and `seatbelt_protected_metadata_name_regex` when metadata names must be blocked under an otherwise writable root.

*Call graph*: calls 2 internal fn (normalize_path_for_sandbox, seatbelt_protected_metadata_name_regex); called by 1 (create_seatbelt_command_args); 4 external calls (new, new, format!, vec!).


##### `seatbelt_protected_metadata_name_regex`  (lines 392–404)

```
fn seatbelt_protected_metadata_name_regex(root: &AbsolutePathBuf, name: &str) -> String
```

**Purpose**: Creates a regular expression that matches a protected metadata directory or file name directly under a given root, plus everything inside it. A regular expression is a text pattern used here by Seatbelt to recognize paths.

**Data flow**: It receives an absolute root path and a metadata name. It removes trailing slashes from the root except for `/`, escapes both pieces so special characters are treated literally, and returns a pattern that matches exactly `root/name` and its descendants.

**Call relations**: `build_seatbelt_access_policy` calls this when it needs to prevent writes to protected metadata names while still allowing writes elsewhere under the same root.

*Call graph*: calls 1 internal fn (to_string_lossy); called by 1 (build_seatbelt_access_policy); 5 external calls (format!, escape, ends_with, len, pop).


##### `protected_metadata_names_for_writable_root`  (lines 406–422)

```
fn protected_metadata_names_for_writable_root(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    writable_root: &WritableRoot,
    cwd: &Path,
) -> Vec<String>
```

**Purpose**: Decides which metadata names should remain protected inside a writable root. This prevents a write permission from unintentionally allowing changes to important hidden project or system metadata.

**Data flow**: It receives the filesystem sandbox policy, one writable root, and the policy's current working directory. It starts with the names already protected on that writable root, then checks the global protected metadata names. If the broader filesystem policy would not allow writing a particular metadata path, that name is added to the protected list. It returns the completed list of names.

**Call relations**: This helper is used while writable roots are being prepared for `build_seatbelt_access_policy`. Its output becomes regex exclusions inside the generated write policy.

*Call graph*: calls 1 internal fn (can_write_path_with_cwd).


##### `build_seatbelt_unreadable_glob_policy`  (lines 424–456)

```
fn build_seatbelt_unreadable_glob_policy(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
) -> String
```

**Purpose**: Turns unreadable glob patterns into Seatbelt deny rules. A glob is a wildcard path pattern, like `*.pem` or `secret/**`, but Seatbelt needs regular expressions instead.

**Data flow**: It receives the filesystem sandbox policy and current working directory. It asks the policy for unreadable glob patterns, converts each pattern into one or more regular expressions, also tries a normalized version when the non-wildcard prefix can be canonicalized, and writes deny rules for reading and unlink-style deletion. It returns the combined deny policy text, or an empty string if there are no unreadable globs.

**Call relations**: `create_seatbelt_command_args` includes this after the main read and write allow rules. It calls `seatbelt_regex_for_unreadable_glob` for translation and `canonicalize_glob_static_prefix_for_sandbox` to catch paths that resolve differently through symlinks or cleaned prefixes.

*Call graph*: calls 3 internal fn (get_unreadable_globs_with_cwd, canonicalize_glob_static_prefix_for_sandbox, seatbelt_regex_for_unreadable_glob); called by 1 (create_seatbelt_command_args); 4 external calls (new, new, new, format!).


##### `canonicalize_glob_static_prefix_for_sandbox`  (lines 458–482)

```
fn canonicalize_glob_static_prefix_for_sandbox(pattern: &str) -> Option<String>
```

**Purpose**: Normalizes the non-wildcard beginning of a glob pattern, when possible. This helps a deny rule still work when the written path and the filesystem's canonical path differ.

**Data flow**: It receives a glob pattern string. If there are no wildcard characters, it normalizes the whole path. If there are wildcards, it finds the path portion before the first wildcard, normalizes the directory part, and then reattaches the wildcard suffix. It returns the changed pattern when normalization succeeds and actually changes it, otherwise nothing.

**Call relations**: `build_seatbelt_unreadable_glob_policy` calls this for each unreadable glob. When it returns a normalized version, that version is also converted into a Seatbelt regex so the deny policy covers both forms.

*Call graph*: calls 1 internal fn (normalize_path_for_sandbox); called by 1 (build_seatbelt_unreadable_glob_policy); 2 external calls (new, format!).


##### `seatbelt_regex_for_unreadable_glob`  (lines 484–566)

```
fn seatbelt_regex_for_unreadable_glob(pattern: &str) -> Option<String>
```

**Purpose**: Translates a supported glob pattern into a regular expression that Seatbelt can use. This is the bridge between the project's user-friendly wildcard syntax and Seatbelt's pattern language.

**Data flow**: It receives a pattern string. Empty patterns produce no result. For non-empty patterns, it walks character by character, converting `*`, `**/`, `?`, and character classes into regex equivalents while escaping ordinary characters. If the pattern has no wildcards, it treats it as an exact path plus everything below it. It returns the finished anchored regex.

**Call relations**: `build_seatbelt_unreadable_glob_policy` calls this for original and normalized unreadable patterns. The returned regexes are inserted into Seatbelt deny rules for reads and destructive unlink-style writes.

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

**Purpose**: Provides a compatibility path for older callers that still pass a combined sandbox policy. It converts that legacy policy into the newer separate filesystem and network policies, then uses the main command-argument builder.

**Data flow**: It receives the command to run, the older sandbox policy, the policy working directory, the managed-network flag, and an optional network proxy. It derives a filesystem policy for that directory, extracts the network policy, fills in an empty extra-socket list, calls `create_seatbelt_command_args`, and returns the final argument vector.

**Call relations**: This wrapper hands all real work to `create_seatbelt_command_args`. It keeps older code paths working without duplicating the Seatbelt-building logic.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, from, create_seatbelt_command_args).


##### `create_seatbelt_command_args`  (lines 602–741)

```
fn create_seatbelt_command_args(args: CreateSeatbeltCommandArgsParams<'_>) -> Vec<String>
```

**Purpose**: Builds the full list of arguments used to run a command under macOS `sandbox-exec`. This is the central function that combines file, network, proxy, socket, and platform-default rules into one Seatbelt policy.

**Data flow**: It receives the command, filesystem policy, network policy, policy working directory, managed-network flag, optional proxy, and extra allowed Unix sockets. It builds write rules, read rules, deny rules for unreadable globs, proxy inputs, dynamic network rules, and optional platform defaults. It joins those policy sections into one policy string, gathers all path parameters for files and sockets, formats them as `-D` definitions, appends `--`, then appends the original command. It returns the complete argument list for `sandbox-exec`.

**Call relations**: This function is called when the system is about to run a command under the sandbox, and the legacy wrapper delegates to it. It coordinates the helper functions in this file: access-policy builders for files, unreadable-glob deny generation, proxy input collection, network policy generation, and Unix socket parameter creation.

*Call graph*: calls 5 internal fn (build_seatbelt_access_policy, build_seatbelt_unreadable_glob_policy, dynamic_network_policy_for_network, proxy_policy_inputs, unix_socket_dir_params); called by 2 (run_command_under_sandbox, create_seatbelt_command_args_for_legacy_policy); 4 external calls (new, new, format!, vec!).


### Shell parsing foundations
These helpers provide shell-specific parsing and normalization primitives that higher-level command analysis builds on.

### `shell-command/src/bash.rs`

`domain_logic` · `request handling and command safety checks`

Shell commands are tricky because a short string can hide a lot of behavior: redirects can write files, substitutions can run extra commands, variables can change meanings, and parentheses can create subshells. This file acts like a cautious translator. It uses tree-sitter, a parser library that turns source text into a tree of syntax pieces, to inspect Bash-like scripts before accepting them.

The safe path is narrow on purpose. A script is accepted only when it is made of plain commands joined by simple operators such as `&&`, `||`, `;`, or `|`. Each command must be made from literal words, numbers, or simple quoted strings. Anything more powerful, such as `$HOME`, `$(...)`, redirection, assignment prefixes, control flow, or unsupported punctuation, is rejected by returning `None`.

The file also recognizes commands shaped like `bash -lc "..."`, `zsh -lc "..."`, or `sh -c "..."`, extracts the embedded script, and parses it. There is a special path for here-doc scripts, such as `python3 <<'PY' ... PY`, where the code only needs the executable prefix, not the document contents. The tests document the safety boundary: many normal-looking commands are accepted, but anything that could hide extra shell behavior is deliberately refused.

#### Function details

##### `try_parse_shell`  (lines 13–20)

```
fn try_parse_shell(shell_lc_arg: &str) -> Option<Tree>
```

**Purpose**: Parses Bash-like source text into a syntax tree using the Bash grammar. Other functions use this tree so they can inspect the structure of the command instead of guessing from raw text.

**Data flow**: It receives a shell script string. It creates a tree-sitter parser, loads the Bash grammar, and asks the parser to read the script. It returns a parsed tree when parsing succeeds, or `None` when the parser cannot produce one.

**Call relations**: This is the first parsing step for `parse_shell_script_into_commands` and `parse_shell_lc_single_command_prefix`. A higher-level parser named `parse_shell_script` also calls it when it needs the raw syntax tree.

*Call graph*: called by 3 (parse_shell_lc_single_command_prefix, parse_shell_script_into_commands, parse_shell_script); 1 external calls (new).


##### `try_parse_word_only_commands_sequence`  (lines 29–95)

```
fn try_parse_word_only_commands_sequence(tree: &Tree, src: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: Checks whether a parsed shell script is only a safe sequence of plain commands, then extracts each command as a list of words. It is the main safety filter for ordinary shell command strings.

**Data flow**: It receives a syntax tree and the original script text. It walks every node in the tree, rejecting parse errors and any syntax kind or punctuation that is not on a small allow-list. It then extracts each command node into words. The result is a list of command argument lists, or `None` if anything unsafe or unsupported appears.

**Call relations**: After `try_parse_shell` builds a tree, `parse_shell_script_into_commands` and `parse_shell_script` call this function to decide whether the script is simple enough. For each accepted command node, it hands the detailed word extraction to `parse_plain_command_from_node`.

*Call graph*: calls 1 internal fn (parse_plain_command_from_node); called by 2 (parse_shell_script_into_commands, parse_shell_script); 3 external calls (root_node, new, vec!).


##### `parse_shell_script_into_commands`  (lines 98–101)

```
fn parse_shell_script_into_commands(script: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: Combines parsing and safety checking for a plain shell script. Callers use it when they have script text and want safe command argument lists.

**Data flow**: It receives script text. First it asks `try_parse_shell` to build a syntax tree. If that works, it passes the tree and source text to `try_parse_word_only_commands_sequence`. It returns the extracted commands or `None` if either step fails.

**Call relations**: This is the public shortcut used by `parse_shell_lc_plain_commands`, by command-memory analysis, and by the test helper `tests::parse_seq`. It hides the two-stage flow of parse first, then validate.

*Call graph*: calls 2 internal fn (try_parse_shell, try_parse_word_only_commands_sequence); called by 3 (memories_usage_kinds_from_command, parse_shell_lc_plain_commands, parse_seq).


##### `extract_bash_command`  (lines 103–116)

```
fn extract_bash_command(command: &[String]) -> Option<(&str, &str)>
```

**Purpose**: Recognizes command arrays that mean “run this script through bash, zsh, or sh”. It prevents the shell parser from being used on unrelated commands.

**Data flow**: It receives a command as a list of strings. It only accepts exactly three items: a shell path/name, a flag, and a script. The flag must be `-lc` or `-c`, and the shell path must be detected as Bash, Zsh, or Sh. It returns the shell and script as borrowed strings, or `None` if the shape does not match.

**Call relations**: Several higher-level command policy and formatting paths call this before trying to interpret embedded shell text. `parse_shell_lc_plain_commands` and `parse_shell_lc_single_command_prefix` rely on it as their gatekeeper.

*Call graph*: called by 6 (canonicalize_command_for_approval, parse_shell_lc_plain_commands, parse_shell_lc_single_command_prefix, extract_shell_command, parse_shell_lc_commands, format_unified_exec_interaction); 1 external calls (matches!).


##### `parse_shell_lc_plain_commands`  (lines 121–124)

```
fn parse_shell_lc_plain_commands(command: &[String]) -> Option<Vec<Vec<String>>>
```

**Purpose**: Extracts plain commands from a `bash -lc`, `zsh -lc`, or `sh -c` invocation when the embedded script stays within the safe subset. It lets policy code see the real commands hidden inside a shell wrapper.

**Data flow**: It receives a full command array, such as `['bash', '-lc', 'ls && pwd']`. It first uses `extract_bash_command` to find the embedded script. Then it passes that script to `parse_shell_script_into_commands`. It returns the parsed command lists or `None` if the wrapper or script is not acceptable.

**Call relations**: Command approval, execution policy, danger checks, and known-safe checks call this when they need to look through a shell invocation. It delegates shell recognition to `extract_bash_command` and script parsing to `parse_shell_script_into_commands`.

*Call graph*: calls 2 internal fn (extract_bash_command, parse_shell_script_into_commands); called by 6 (canonicalize_command_for_approval, commands_for_exec_policy, commands_for_intercepted_exec_policy, parse_zsh_lc_plain_commands, command_might_be_dangerous, is_known_safe_command).


##### `parse_shell_lc_single_command_prefix`  (lines 128–144)

```
fn parse_shell_lc_single_command_prefix(command: &[String]) -> Option<Vec<String>>
```

**Purpose**: Finds the executable and literal arguments for a single shell command that uses a here-doc. This is useful when a script passes a block of text to one program, such as `python3 <<'PY'`, and policy only needs the program prefix.

**Data flow**: It receives a full shell command array. It extracts the embedded script, parses it, rejects parse errors, requires a here-doc-style redirect, rejects normal file redirects, and requires exactly one command node. It then extracts only safe literal command words. The result is that one command prefix, or `None` if the script contains extra commands or unsafe features.

**Call relations**: Execution policy paths call this after shell extraction when here-doc scripts need special treatment. It coordinates `try_parse_shell`, `has_named_descendant_kind`, `find_single_command_node`, and `parse_heredoc_command_words`.

*Call graph*: calls 5 internal fn (extract_bash_command, find_single_command_node, has_named_descendant_kind, parse_heredoc_command_words, try_parse_shell); called by 3 (commands_for_exec_policy, commands_for_intercepted_exec_policy, parse_shell_lc_single_command_prefix_supports_heredoc).


##### `parse_plain_command_from_node`  (lines 146–202)

```
fn parse_plain_command_from_node(cmd: tree_sitter::Node, src: &str) -> Option<Vec<String>>
```

**Purpose**: Turns one safe `command` node from the syntax tree into the familiar list of command-line arguments. It understands literal words, numbers, simple quotes, and safe quote concatenation.

**Data flow**: It receives one syntax-tree command node and the original script text. It reads each named child in order, extracts the command name and arguments, removes simple quote wrappers, and joins safe concatenated pieces such as `-g"*.py"`. It returns a vector of strings, or `None` if it sees an unsupported child.

**Call relations**: `try_parse_word_only_commands_sequence` calls this after it has already checked the broader script shape. This function then performs the smaller job of converting each individual command node into plain words, using `parse_double_quoted_string` and `parse_raw_string` for quoted text.

*Call graph*: calls 2 internal fn (parse_double_quoted_string, parse_raw_string); called by 1 (try_parse_word_only_commands_sequence); 5 external calls (kind, named_children, walk, new, new).


##### `parse_heredoc_command_words`  (lines 204–239)

```
fn parse_heredoc_command_words(cmd: Node<'_>, src: &str) -> Option<Vec<String>>
```

**Purpose**: Extracts the literal executable prefix from a single command that has a here-doc attachment. It deliberately ignores the here-doc body while still rejecting unsafe argument syntax.

**Data flow**: It receives a command node and source text. It accepts only a literal command name and literal word or number arguments, while allowing here-doc-related syntax nodes to be attached. It returns the collected words if at least one word is found, or `None` if the command contains expansion, assignment-like structure, or unrelated syntax.

**Call relations**: `parse_shell_lc_single_command_prefix` calls this after proving there is exactly one command and that the script uses here-doc syntax. It relies on `is_literal_word_or_number` for word safety and `is_allowed_heredoc_attachment_kind` for the allowed attachment nodes.

*Call graph*: calls 2 internal fn (is_allowed_heredoc_attachment_kind, is_literal_word_or_number); called by 1 (parse_shell_lc_single_command_prefix); 5 external calls (kind, named_children, walk, new, matches!).


##### `is_literal_word_or_number`  (lines 241–247)

```
fn is_literal_word_or_number(node: Node<'_>) -> bool
```

**Purpose**: Checks whether a syntax node is a plain word or number with no hidden child syntax inside it. This blocks things that look like a word but actually contain shell expansion.

**Data flow**: It receives one syntax-tree node. It first checks that the node kind is `word` or `number`, then verifies it has no named children. It returns `true` only for a simple literal token.

**Call relations**: `parse_heredoc_command_words` calls this before accepting command names and arguments in the here-doc special case. It acts as the small safety check for each possible word.

*Call graph*: called by 1 (parse_heredoc_command_words); 3 external calls (named_children, walk, matches!).


##### `is_allowed_heredoc_attachment_kind`  (lines 249–258)

```
fn is_allowed_heredoc_attachment_kind(kind: &str) -> bool
```

**Purpose**: Names the syntax node kinds that are allowed as here-doc or here-string attachments. It keeps that allow-list in one clear place.

**Data flow**: It receives a syntax node kind as text. It compares that kind against the few here-doc-related names that are acceptable. It returns `true` for those names and `false` for everything else.

**Call relations**: `parse_heredoc_command_words` calls this when it sees non-word children attached to a command. This function decides whether those attachments are part of the permitted here-doc shape.

*Call graph*: called by 1 (parse_heredoc_command_words); 1 external calls (matches!).


##### `find_single_command_node`  (lines 260–277)

```
fn find_single_command_node(root: Node<'_>) -> Option<Node<'_>>
```

**Purpose**: Searches a syntax tree and succeeds only if there is exactly one command node. It prevents a here-doc shortcut from hiding a second command.

**Data flow**: It receives the root node of a parsed tree. It walks through named descendants, remembers a command node if it finds one, and immediately fails if it finds another. It returns the single command node or `None`.

**Call relations**: `parse_shell_lc_single_command_prefix` uses this before extracting a here-doc command prefix. It provides the “only one command is present” guarantee needed by that special path.

*Call graph*: called by 1 (parse_shell_lc_single_command_prefix); 1 external calls (vec!).


##### `has_named_descendant_kind`  (lines 279–291)

```
fn has_named_descendant_kind(node: Node<'_>, kind: &str) -> bool
```

**Purpose**: Checks whether a parsed syntax tree contains a named node of a particular kind. It is a simple search tool used for safety decisions.

**Data flow**: It receives a starting node and a target kind name. It walks through the node and all named descendants, returning `true` as soon as it finds the target. If no matching node appears, it returns `false`.

**Call relations**: `parse_shell_lc_single_command_prefix` calls this to require here-doc syntax and to reject normal file redirects. It gives that function quick yes-or-no answers about important syntax features.

*Call graph*: called by 1 (parse_shell_lc_single_command_prefix); 1 external calls (vec!).


##### `parse_double_quoted_string`  (lines 293–309)

```
fn parse_double_quoted_string(node: Node, src: &str) -> Option<String>
```

**Purpose**: Extracts the contents of a double-quoted string only when it contains plain text. It rejects double-quoted strings with variable or command expansion.

**Data flow**: It receives a syntax node and the original source. It verifies the node is a `string`, checks that every named child is only `string_content`, then strips the surrounding double quotes from the raw text. It returns the inside text or `None`.

**Call relations**: `parse_plain_command_from_node` calls this when an argument is written with double quotes. This keeps ordinary quoted text usable while blocking hidden shell behavior inside quotes.

*Call graph*: called by 1 (parse_plain_command_from_node); 4 external calls (kind, named_children, utf8_text, walk).


##### `parse_raw_string`  (lines 311–321)

```
fn parse_raw_string(node: Node, src: &str) -> Option<String>
```

**Purpose**: Extracts the contents of a single-quoted shell string. In shell syntax, single quotes are treated as literal text, so this is a safe quoting form.

**Data flow**: It receives a syntax node and the source text. It verifies the node is a `raw_string`, reads its exact text, strips one leading and trailing single quote, and returns the contents. If the shape is wrong, it returns `None`.

**Call relations**: `parse_plain_command_from_node` calls this for single-quoted arguments and for single-quoted pieces inside concatenated arguments.

*Call graph*: called by 1 (parse_plain_command_from_node); 2 external calls (kind, utf8_text).


##### `tests::parse_seq`  (lines 328–330)

```
fn parse_seq(src: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: Provides a short test helper for parsing shell snippets. It keeps the tests focused on expected behavior rather than repeated setup.

**Data flow**: It receives a source string, passes it to `parse_shell_script_into_commands`, and returns whatever that parser returns.

**Call relations**: Many test cases call this helper when they want to check the ordinary safe-command parser.

*Call graph*: calls 1 internal fn (parse_shell_script_into_commands).


##### `tests::accepts_single_simple_command`  (lines 333–336)

```
fn accepts_single_simple_command()
```

**Purpose**: Verifies that a basic command with one argument is accepted. This confirms the parser works for the simplest useful case.

**Data flow**: It feeds `ls -1` through the test helper and compares the result with one command containing `ls` and `-1`.

**Call relations**: The test runner calls this test. It exercises `tests::parse_seq`, which then reaches the public script parser.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_multiple_commands_with_allowed_operators`  (lines 339–349)

```
fn accepts_multiple_commands_with_allowed_operators()
```

**Purpose**: Verifies that simple commands joined by allowed operators are accepted and separated correctly. This checks the intended safe chaining behavior.

**Data flow**: It parses a script using `&&`, `;`, quotes, and `|`. It expects four separate command lists in source order.

**Call relations**: The test runner calls this to cover the sequence parser and its allowed operator list through `tests::parse_seq`.

*Call graph*: 3 external calls (assert_eq!, parse_seq, vec!).


##### `tests::extracts_double_and_single_quoted_strings`  (lines 352–364)

```
fn extracts_double_and_single_quoted_strings()
```

**Purpose**: Checks that both double-quoted and single-quoted plain strings become normal argument text. It proves quotes are removed without losing spaces.

**Data flow**: It parses `echo "hello world"` and `echo 'hi there'`, then compares each result with an `echo` command whose second argument contains the spaces.

**Call relations**: This test reaches quote parsing through `tests::parse_seq`, indirectly covering `parse_double_quoted_string` and `parse_raw_string`.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_double_quoted_strings_with_newlines`  (lines 367–378)

```
fn accepts_double_quoted_strings_with_newlines()
```

**Purpose**: Confirms that plain double-quoted strings may contain newline characters. This matters for commands such as commit messages.

**Data flow**: It parses a `git commit -m` command whose quoted message spans two lines, then checks that the newline is preserved in the argument.

**Call relations**: The test runner uses this to cover multiline safe string content through the normal parsing path.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_mixed_quote_concatenation`  (lines 381–390)

```
fn accepts_mixed_quote_concatenation()
```

**Purpose**: Checks that adjacent quoted and unquoted pieces can combine into one argument when every piece is literal. This matches common shell behavior for building paths.

**Data flow**: It parses examples that combine single quotes, double quotes, and bare text into `/usr/local/bin`, then compares the parsed output with that single combined argument.

**Call relations**: This test exercises concatenation behavior in `parse_plain_command_from_node` through the public parsing helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_double_quoted_strings_with_expansions`  (lines 393–396)

```
fn rejects_double_quoted_strings_with_expansions()
```

**Purpose**: Verifies that double-quoted strings containing shell expansion are rejected. This prevents variables from being mistaken for fixed text.

**Data flow**: It tries examples containing `${USER}` and `$HOME` inside double quotes. Each parse is expected to return `None`.

**Call relations**: The test runner uses this to confirm `parse_double_quoted_string` rejects non-plain children inside quoted strings.

*Call graph*: 1 external calls (assert!).


##### `tests::accepts_numbers_as_words`  (lines 399–409)

```
fn accepts_numbers_as_words()
```

**Purpose**: Confirms numeric-looking arguments are accepted as ordinary command words. Many real commands use numbers as options or values.

**Data flow**: It parses `echo 123 456` and expects the numbers to appear as string arguments after `echo`.

**Call relations**: This test covers the `number` node path inside the normal command parser.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::rejects_parentheses_and_subshells`  (lines 412–415)

```
fn rejects_parentheses_and_subshells()
```

**Purpose**: Checks that subshell-style syntax is rejected. Parentheses can change execution behavior, so they are outside this file’s safe subset.

**Data flow**: It attempts to parse `(ls)` and a chained command containing a parenthesized group. Both must return `None`.

**Call relations**: The test runner uses this to validate the broad syntax allow-list in `try_parse_word_only_commands_sequence`.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_redirections_and_unsupported_operators`  (lines 418–421)

```
fn rejects_redirections_and_unsupported_operators()
```

**Purpose**: Confirms that output redirection and unsupported background-style operators are rejected. These features could write files or run extra work in ways the plain parser should not collapse.

**Data flow**: It parses `ls > out.txt` and `echo hi & echo bye`. Each parse is expected to fail.

**Call relations**: This test exercises the punctuation and syntax rejection rules in the sequence parser.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_command_and_process_substitutions_and_expansions`  (lines 424–429)

```
fn rejects_command_and_process_substitutions_and_expansions()
```

**Purpose**: Verifies that command substitution, backticks, variables, and quoted variables are rejected. These features can hide values or extra commands.

**Data flow**: It feeds examples such as `$(pwd)`, backtick command substitution, `$HOME`, and `"hi $USER"` to the parser. Every example must return `None`.

**Call relations**: The test runner uses this to confirm that only literal words and simple strings are accepted by the parser stack.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_variable_assignment_prefix`  (lines 432–434)

```
fn rejects_variable_assignment_prefix()
```

**Purpose**: Checks that environment assignment prefixes before commands are rejected. Such prefixes can change how the command runs.

**Data flow**: It tries to parse `FOO=bar ls` and expects parsing to fail.

**Call relations**: This test covers the syntax allow-list and command-node extraction rules through `tests::parse_seq`.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_trailing_operator_parse_error`  (lines 437–439)

```
fn rejects_trailing_operator_parse_error()
```

**Purpose**: Confirms a script ending with an operator is rejected. This protects against accepting incomplete shell syntax.

**Data flow**: It parses `ls &&` and expects `None` because the parse tree has an error.

**Call relations**: The test runner uses this to cover the parse-error check in `try_parse_word_only_commands_sequence`.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_empty_command_position_with_leading_operator`  (lines 442–444)

```
fn rejects_empty_command_position_with_leading_operator()
```

**Purpose**: Checks that a script cannot begin with a chaining operator. There must be a real command where the shell grammar expects one.

**Data flow**: It parses `&& ls` and expects failure.

**Call relations**: This test reaches the parser through `tests::parse_seq` and confirms malformed command sequences are not accepted.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_empty_command_position_with_double_separator`  (lines 447–449)

```
fn rejects_empty_command_position_with_double_separator()
```

**Purpose**: Verifies that doubled separators creating an empty command position are rejected. This avoids treating broken shell syntax as a valid command list.

**Data flow**: It parses `ls ;; pwd` and expects `None`.

**Call relations**: The test runner uses this to confirm parse errors stop the safe-command sequence path.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_empty_command_position_with_empty_pipeline_segment`  (lines 452–454)

```
fn rejects_empty_command_position_with_empty_pipeline_segment()
```

**Purpose**: Checks that a pipeline cannot contain an empty segment. A pipe must connect real commands on both sides.

**Data flow**: It parses `ls | | wc` and expects the parser to reject it.

**Call relations**: This test exercises the parse-error rejection behavior through the public parsing helper.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_zsh_lc_plain_commands`  (lines 457–461)

```
fn parse_zsh_lc_plain_commands()
```

**Purpose**: Verifies that `zsh -lc` shell wrappers are recognized, not only Bash. This matters because the same simple embedded command policy applies to supported shells.

**Data flow**: It builds a command array for `zsh -lc ls`, parses it with `parse_shell_lc_plain_commands`, and expects one command containing `ls`.

**Call relations**: The test runner calls this to cover `extract_bash_command` and the shell-wrapper parsing flow.

*Call graph*: calls 1 internal fn (parse_shell_lc_plain_commands); 2 external calls (assert_eq!, vec!).


##### `tests::accepts_concatenated_flag_and_value`  (lines 464–476)

```
fn accepts_concatenated_flag_and_value()
```

**Purpose**: Checks that a flag directly joined to a double-quoted value is accepted when the value is literal. This supports common patterns such as ripgrep globs.

**Data flow**: It parses `rg -n "foo" -g"*.py"` and expects the last argument to become `-g*.py`.

**Call relations**: This test exercises concatenation support in `parse_plain_command_from_node` through `tests::parse_seq`.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::accepts_concatenated_flag_with_single_quotes`  (lines 479–490)

```
fn accepts_concatenated_flag_with_single_quotes()
```

**Purpose**: Checks the same safe concatenation behavior when the joined value is single-quoted. It confirms both quote styles work for literal pieces.

**Data flow**: It parses `grep -n 'pattern' -g'*.txt'` and expects `-g*.txt` as one argument.

**Call relations**: The test runner uses this to cover the raw-string part of concatenation parsing.

*Call graph*: 2 external calls (assert_eq!, parse_seq).


##### `tests::rejects_concatenation_with_variable_substitution`  (lines 493–497)

```
fn rejects_concatenation_with_variable_substitution()
```

**Purpose**: Verifies that concatenated arguments are rejected if the quoted part contains a variable. The final text would not be known safely ahead of time.

**Data flow**: It tries examples like `-g"$VAR"` and `-g"${VAR}"`. Each is expected to fail.

**Call relations**: This test confirms concatenation still relies on the strict quote parser, rather than blindly joining text.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_concatenation_with_command_substitution`  (lines 500–504)

```
fn rejects_concatenation_with_command_substitution()
```

**Purpose**: Checks that concatenated arguments cannot contain command substitution. This prevents hidden commands from being smuggled inside an argument.

**Data flow**: It parses examples with `$(pwd)` and `$(echo '*.py')` inside a joined quoted value. Both must return `None`.

**Call relations**: The test runner uses this to validate the safety checks inside concatenated string parsing.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_shell_lc_single_command_prefix_supports_heredoc`  (lines 507–523)

```
fn parse_shell_lc_single_command_prefix_supports_heredoc()
```

**Purpose**: Verifies that a single here-doc command can produce a safe executable prefix. It covers both quoted and unquoted here-doc delimiters.

**Data flow**: It builds two `zsh -lc` command arrays that run `python3` with a here-doc body. Each call is expected to return only `python3` as the command prefix.

**Call relations**: This test calls `parse_shell_lc_single_command_prefix`, exercising the special here-doc path used by execution policy.

*Call graph*: calls 1 internal fn (parse_shell_lc_single_command_prefix); 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_multi_command_scripts`  (lines 526–533)

```
fn parse_shell_lc_single_command_prefix_rejects_multi_command_scripts()
```

**Purpose**: Checks that the here-doc prefix shortcut fails when the script contains more than one command. The shortcut is only safe for one command.

**Data flow**: It builds a Bash here-doc script followed by `echo done` and expects `parse_shell_lc_single_command_prefix` to return `None`.

**Call relations**: The test runner uses this to cover `find_single_command_node` through the here-doc parser.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_non_heredoc_redirects`  (lines 536–543)

```
fn parse_shell_lc_single_command_prefix_rejects_non_heredoc_redirects()
```

**Purpose**: Verifies that normal file redirection is not accepted by the here-doc prefix parser. Writing to a file has side effects that should not be hidden.

**Data flow**: It builds `echo hello > /tmp/out.txt` under `bash -lc` and expects no prefix result.

**Call relations**: This test covers the redirect rejection checks in `parse_shell_lc_single_command_prefix`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_heredoc_with_extra_file_redirect`  (lines 546–553)

```
fn parse_shell_lc_single_command_prefix_rejects_heredoc_with_extra_file_redirect()
```

**Purpose**: Checks that a here-doc command is still rejected if it also has a normal file redirect. The allowed special case does not permit extra filesystem writes.

**Data flow**: It builds a `python3` here-doc script that also redirects output to `/tmp/out.txt`. The expected result is `None`.

**Call relations**: The test runner uses this to confirm that `has_named_descendant_kind` catches disallowed file redirects even when a here-doc is present.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_heredoc_with_variable_assignment`  (lines 556–563)

```
fn parse_shell_lc_single_command_prefix_rejects_heredoc_with_variable_assignment()
```

**Purpose**: Verifies that assignment prefixes are not accepted in the here-doc command prefix path. Changing environment variables could change what actually runs.

**Data flow**: It builds a here-doc command with `PATH=...` before `cat` and expects no parsed prefix.

**Call relations**: This test exercises `parse_heredoc_command_words`, which rejects command children outside the literal-word and allowed here-doc attachment set.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_herestring_with_chaining`  (lines 566–573)

```
fn parse_shell_lc_single_command_prefix_rejects_herestring_with_chaining()
```

**Purpose**: Checks that a script with normal redirection and command chaining does not pass through the here-doc prefix parser. It protects against collapsing a multi-step script into one harmless-looking prefix.

**Data flow**: It builds a shell script that writes a file and then reads it with `&&`. The expected prefix result is `None`.

**Call relations**: The test runner calls the here-doc prefix parser and confirms the combined syntax is rejected before any prefix is returned.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_herestring_with_substitution`  (lines 576–583)

```
fn parse_shell_lc_single_command_prefix_rejects_herestring_with_substitution()
```

**Purpose**: Verifies that a here-string containing command substitution is rejected. Even though here-strings are related to input redirection, substitution can run hidden commands.

**Data flow**: It builds `python3 <<< "$(rm -rf /)"` inside a shell command and expects `None`.

**Call relations**: This test covers the strict word-safety checks used by `parse_heredoc_command_words` in the here-doc-style path.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_arithmetic_shift_non_heredoc_script`  (lines 586–593)

```
fn parse_shell_lc_single_command_prefix_rejects_arithmetic_shift_non_heredoc_script()
```

**Purpose**: Checks that arithmetic syntax containing `<<` is not mistaken for a here-doc. The parser must distinguish input redirection from arithmetic shift notation.

**Data flow**: It builds `echo $((1<<2))` under `bash -lc` and expects the here-doc prefix parser to return `None`.

**Call relations**: The test runner uses this to confirm `parse_shell_lc_single_command_prefix` requires real here-doc syntax, not just similar-looking characters.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parse_shell_lc_single_command_prefix_rejects_heredoc_command_with_word_expansion`  (lines 596–603)

```
fn parse_shell_lc_single_command_prefix_rejects_heredoc_command_with_word_expansion()
```

**Purpose**: Verifies that the command prefix of a here-doc may not contain arithmetic expansion. The executable arguments must be literal.

**Data flow**: It builds a `python3` here-doc command with `$((1<<2))` as an argument and expects no parsed prefix.

**Call relations**: This test exercises `is_literal_word_or_number` through `parse_heredoc_command_words`, confirming expanded words are rejected.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `shell-command/src/powershell.rs`

`domain_logic` · `command preparation, safety checking, and shell discovery`

PowerShell commands often arrive wrapped like: “run powershell.exe with these flags, then execute this script text.” This file peels back that wrapper so the rest of the system can see the real script inside. Without it, the project might treat a PowerShell command as one opaque string, which would make safety checks less accurate and output encoding less reliable.

The file does three main jobs. First, it can find the script part of a PowerShell launch, accepting common forms such as `-Command` and `-c`, while rejecting unexpected flags. This is like checking that an envelope is addressed correctly before opening it. Second, it can add a small PowerShell prefix that asks the console to print UTF-8 text, so non-English characters and symbols are less likely to come out garbled. It avoids adding the prefix twice. Third, it can look for usable `powershell.exe` or `pwsh.exe` programs on the machine and test that they really run.

For safety-related code, it also passes the extracted script to a PowerShell parser that turns the script into command-like pieces. That lets higher-level policy code judge what the script is trying to do instead of only seeing “powershell.exe”.

#### Function details

##### `prefix_powershell_script_with_utf8`  (lines 15–33)

```
fn prefix_powershell_script_with_utf8(command: &[String]) -> Vec<String>
```

**Purpose**: Adds a short PowerShell setup line that asks PowerShell to produce UTF-8 output. This helps avoid broken or unreadable text when commands print characters outside basic English.

**Data flow**: It receives a command as a list of strings, such as the executable, flags, and script. It first asks `extract_powershell_command` to find the script body; if the command is not a recognized PowerShell invocation, it returns an unchanged copy. If it is PowerShell, it checks whether the script already starts with the UTF-8 prefix, adds the prefix if needed, and returns a new command list with only the script string changed.

**Call relations**: During command execution setup, `run` calls this before launching PowerShell so output is more consistently readable. It depends on `extract_powershell_command` to avoid changing commands that are not clearly PowerShell, and its behavior is checked by `prefixes_powershell_command_with_best_effort_utf8`.

*Call graph*: calls 1 internal fn (extract_powershell_command); called by 3 (run, run, prefixes_powershell_command_with_best_effort_utf8); 1 external calls (format!).


##### `extract_powershell_command`  (lines 43–71)

```
fn extract_powershell_command(command: &[String]) -> Option<(&str, &str)>
```

**Purpose**: Finds the actual script text inside a PowerShell command-line invocation. Other code uses this when it needs to inspect or modify the script rather than the wrapper around it.

**Data flow**: It receives a list of command arguments. It first checks that there are enough parts, then verifies that the first part looks like a PowerShell executable. It then walks through the flags, accepting only known PowerShell flags used here, and returns the shell name plus the script text when it finds `-Command` or `-c` followed by a script. If anything does not match the expected shape, it returns nothing.

**Call relations**: This is the shared doorway for PowerShell understanding in this file. Safety and parsing paths such as `canonicalize_command_for_approval`, `parse_command_impl`, and `parse_powershell_command_into_plain_commands` call it when they need the script body. `prefix_powershell_script_with_utf8` also calls it before editing a command. Several tests call it with different valid forms to prove that common spellings and paths are recognized.

*Call graph*: called by 8 (canonicalize_command_for_approval, parse_command_impl, parse_powershell_command_into_plain_commands, prefix_powershell_script_with_utf8, extracts_basic_powershell_command, extracts_full_path_powershell_command, extracts_lowercase_flags, extracts_with_noprofile_and_alias); 1 external calls (matches!).


##### `parse_powershell_command_into_plain_commands`  (lines 78–83)

```
fn parse_powershell_command_into_plain_commands(
    command: &[String],
) -> Option<Vec<Vec<String>>>
```

**Purpose**: Turns the script inside a PowerShell wrapper into simpler command-shaped pieces that policy code can reason about. This supports safety checks that need to know what the PowerShell script would run.

**Data flow**: It receives a full command list. It uses `extract_powershell_command` to pull out the executable and script; if that fails, it returns nothing. If extraction succeeds, it passes the executable and script to the PowerShell abstract syntax tree parser, which reads the script structure and returns a list of plain command argument lists when possible.

**Call relations**: `commands_for_exec_policy` calls this when it needs PowerShell commands in a form suitable for execution policy decisions. The parser itself is delegated to `try_parse_powershell_ast_commands`, while this function only unwraps the outer PowerShell launch. Windows-only tests check both a single command and a pipeline of multiple commands.

*Call graph*: calls 1 internal fn (extract_powershell_command); called by 3 (commands_for_exec_policy, parses_multiple_plain_powershell_commands, parses_plain_powershell_commands); 1 external calls (try_parse_powershell_ast_commands).


##### `try_find_powershell_executable_blocking`  (lines 86–88)

```
fn try_find_powershell_executable_blocking() -> Option<AbsolutePathBuf>
```

**Purpose**: Looks for the older Windows PowerShell executable, `powershell.exe`, and returns its absolute path if it can be found and run. “Blocking” means it does the search immediately and waits for any checks to finish.

**Data flow**: It takes no input. It asks `try_find_powershellish_executable_in_path` to search the system PATH for `powershell.exe`, then returns the first usable absolute path or nothing if none is available.

**Call relations**: Tests and parser-process setup code call this when they need a real PowerShell executable for Windows-style command behavior. It keeps the public search function small by handing the actual PATH search and validation to `try_find_powershellish_executable_in_path`.

*Call graph*: calls 1 internal fn (try_find_powershellish_executable_in_path); called by 3 (commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command, parser_process_handles_multiple_requests, parser_process_rejects_stop_parsing_forms).


##### `try_find_pwsh_executable_blocking`  (lines 100–122)

```
fn try_find_pwsh_executable_blocking() -> Option<AbsolutePathBuf>
```

**Purpose**: Looks for PowerShell Core, named `pwsh.exe`, and returns its absolute path if it can find a working copy. PowerShell Core is newer and cross-platform, but it may be installed somewhere that is not directly visible in PATH.

**Data flow**: It takes no input. First it tries to ask `pwsh` itself for `$PSHOME`, the folder where PowerShell lives, by running a small command through `cmd`. If that succeeds, it builds a possible `pwsh.exe` path from that folder and tests whether it runs. If that route fails, it falls back to searching PATH for `pwsh.exe`. The result is either a usable absolute path or nothing.

**Call relations**: Safety and PowerShell-wrapper tests call this when they need to use the same PowerShell variant that would actually be invoked. It uses `is_powershellish_executable_available` to avoid returning a broken executable and falls back to `try_find_powershellish_executable_in_path` when the `$PSHOME` shortcut does not work.

*Call graph*: calls 3 internal fn (is_powershellish_executable_available, try_find_powershellish_executable_in_path, resolve_path_against_base); called by 7 (commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command, windows_powershell_full_path_is_safe, accepts_full_path_powershell_invocations, allows_read_only_pipelines_and_git_usage, recognizes_safe_powershell_wrappers, rejects_git_global_override_options, uses_invoked_powershell_variant_for_parsing); 1 external calls (new).


##### `try_find_powershellish_executable_in_path`  (lines 124–142)

```
fn try_find_powershellish_executable_in_path(candidates: &[&str]) -> Option<AbsolutePathBuf>
```

**Purpose**: Searches the system PATH for one or more possible PowerShell executable names and returns the first one that is both found and runnable. This avoids trusting a file name just because it exists.

**Data flow**: It receives a list of candidate executable names. For each name, it asks the operating system search helper to resolve it from PATH. If a path is found, it runs a small availability test. If the test succeeds, it converts the path into the project’s absolute-path type and returns it. If no candidate passes all checks, it returns nothing.

**Call relations**: Both `try_find_powershell_executable_blocking` and `try_find_pwsh_executable_blocking` call this for the common PATH-search behavior. It hands each found path to `is_powershellish_executable_available` before reporting success.

*Call graph*: calls 2 internal fn (is_powershellish_executable_available, from_absolute_path); called by 2 (try_find_powershell_executable_blocking, try_find_pwsh_executable_blocking); 1 external calls (which).


##### `is_powershellish_executable_available`  (lines 144–151)

```
fn is_powershellish_executable_available(powershell_or_pwsh_exe: &std::path::Path) -> bool
```

**Purpose**: Checks whether a supposed PowerShell executable can actually run a tiny command successfully. This protects callers from using a missing, broken, or unusable shell program.

**Data flow**: It receives a filesystem path. It starts that program with flags that suppress startup extras and asks it to run `Write-Output ok`. If the process starts and exits successfully, it returns true; if starting fails or the command exits with an error, it returns false.

**Call relations**: The search helpers call this before accepting a found `powershell.exe` or `pwsh.exe`. It is the final practical test that turns “there is a file at this path” into “this PowerShell-like program is usable.”

*Call graph*: called by 2 (try_find_powershellish_executable_in_path, try_find_pwsh_executable_blocking); 1 external calls (new).


##### `tests::extracts_basic_powershell_command`  (lines 162–170)

```
fn extracts_basic_powershell_command()
```

**Purpose**: Checks that a simple PowerShell invocation using `-Command` is recognized and that the script text is extracted correctly.

**Data flow**: It builds a small command list for `powershell -Command "Write-Host hi"`. It passes that list to `extract_powershell_command`, unwraps the result, and verifies that the returned script is exactly `Write-Host hi`.

**Call relations**: This test exercises the main successful path through `extract_powershell_command`. It gives confidence that the most basic wrapper form works before more unusual flag combinations are tested.

*Call graph*: calls 1 internal fn (extract_powershell_command); 2 external calls (assert_eq!, vec!).


##### `tests::extracts_lowercase_flags`  (lines 173–182)

```
fn extracts_lowercase_flags()
```

**Purpose**: Checks that lowercase PowerShell flags are accepted. This matters because users and tools may write flags with different capitalization.

**Data flow**: It builds a command list using `-nologo` and `-command`. It sends that list to `extract_powershell_command` and checks that the script body still comes back as `Write-Host hi`.

**Call relations**: This test calls `extract_powershell_command` to confirm that flag matching is case-insensitive for supported flags. It covers a common variation of the same command shape.

*Call graph*: calls 1 internal fn (extract_powershell_command); 2 external calls (assert_eq!, vec!).


##### `tests::extracts_full_path_powershell_command`  (lines 185–194)

```
fn extracts_full_path_powershell_command()
```

**Purpose**: Checks that PowerShell is recognized even when the command uses a full filesystem path instead of just `powershell`. This is important because programs often launch shells by absolute path.

**Data flow**: It chooses a Windows-style full path on Windows and a Unix-style test path elsewhere. It builds a command list with that path, `-Command`, and a script, then asks `extract_powershell_command` to extract the script. The test passes only if the script is returned unchanged.

**Call relations**: This test calls `extract_powershell_command` and depends on shell-type detection accepting full paths. It proves the extraction logic is not limited to bare executable names.

*Call graph*: calls 1 internal fn (extract_powershell_command); 3 external calls (assert_eq!, cfg!, vec!).


##### `tests::extracts_with_noprofile_and_alias`  (lines 197–206)

```
fn extracts_with_noprofile_and_alias()
```

**Purpose**: Checks that the parser accepts a common extra flag, `-NoProfile`, and the short `-c` alias for `-Command`. This matches how PowerShell is often invoked by automation tools.

**Data flow**: It builds a `pwsh` command with `-NoProfile`, `-c`, and a pipeline script. It sends the list to `extract_powershell_command` and verifies that the whole script after `-c` is returned.

**Call relations**: This test calls `extract_powershell_command` to cover a realistic PowerShell Core invocation. It complements the simpler tests by showing that accepted flags before the command body do not block extraction.

*Call graph*: calls 1 internal fn (extract_powershell_command); 2 external calls (assert_eq!, vec!).


##### `tests::prefixes_powershell_command_with_best_effort_utf8`  (lines 209–226)

```
fn prefixes_powershell_command_with_best_effort_utf8()
```

**Purpose**: Checks that PowerShell scripts are prefixed with the UTF-8 output setup when they do not already have it. This protects command output from avoidable character-encoding problems.

**Data flow**: It builds a normal PowerShell command whose script is `Write-Host hi`. It passes the command to `prefix_powershell_script_with_utf8` and checks that the returned command is the same except that the script now starts with the UTF-8 prefix.

**Call relations**: This test calls `prefix_powershell_script_with_utf8`, which in turn relies on PowerShell extraction before changing the script. It verifies the behavior used by command-running code before launching PowerShell.

*Call graph*: calls 1 internal fn (prefix_powershell_script_with_utf8); 2 external calls (assert_eq!, vec!).


##### `tests::does_not_duplicate_utf8_prefix`  (lines 229–237)

```
fn does_not_duplicate_utf8_prefix()
```

**Purpose**: Checks that the UTF-8 setup text is not added twice. This keeps repeated preparation steps from growing the script or changing it unnecessarily.

**Data flow**: It builds a PowerShell command whose script already begins with the UTF-8 prefix. It compares the result of the prefixing behavior with the original command and expects them to be identical.

**Call relations**: This test protects the idempotent behavior of the UTF-8 prefixing path: applying the preparation more than once should have the same effect as applying it once. It sits alongside the test that confirms the prefix is added when missing.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parses_plain_powershell_commands`  (lines 241–251)

```
fn parses_plain_powershell_commands()
```

**Purpose**: Checks that a simple PowerShell script can be unwrapped and converted into a plain command list. This test runs only on Windows, where the PowerShell parser behavior is expected.

**Data flow**: It passes a `powershell.exe -NoProfile -Command "echo hi"` command to `parse_powershell_command_into_plain_commands`. It expects to get one plain command back: `echo` with the argument `hi`.

**Call relations**: This test calls `parse_powershell_command_into_plain_commands`, which first extracts the script and then delegates to the PowerShell script parser. It verifies the simple case used by execution-policy code.

*Call graph*: calls 1 internal fn (parse_powershell_command_into_plain_commands); 1 external calls (assert_eq!).


##### `tests::parses_multiple_plain_powershell_commands`  (lines 255–271)

```
fn parses_multiple_plain_powershell_commands()
```

**Purpose**: Checks that a PowerShell pipeline can be turned into multiple plain command entries. This matters because a script may run more than one command connected by a pipe.

**Data flow**: It passes a command containing `Write-Output foo | Measure-Object` to `parse_powershell_command_into_plain_commands`. It expects two command lists back: one for `Write-Output foo` and one for `Measure-Object`.

**Call relations**: This Windows-only test calls `parse_powershell_command_into_plain_commands` to confirm that the parser can expose each stage of a pipeline. That supports policy checks that need to inspect all commands, not just the first one.

*Call graph*: calls 1 internal fn (parse_powershell_command_into_plain_commands); 1 external calls (assert_eq!).


### `core/src/command_canonicalization.rs`

`domain_logic` · `command approval checking`

When the system asks whether a command has already been approved, it needs a fair way to compare commands. Raw command arguments can vary even when the human meaning is the same. For example, `bash -lc "echo hi"` and `/bin/bash -lc "echo hi"` may be the same request in practice, but their raw text differs. This file solves that by creating a “canonical” version, meaning a normalized version used for comparison.

The main function first looks for simple shell commands that can be safely broken back into their real command words. If there is exactly one plain command inside a shell wrapper, it returns that inner command directly. This makes approval match the actual thing being run, not the wrapper around it.

If the shell script is more complex and cannot safely be reduced to simple command words, the file keeps the script text exactly as written. It adds a special marker such as `__codex_shell_script__` or `__codex_powershell_script__` so that Bash and PowerShell scripts do not accidentally look the same. Think of it like labeling two envelopes before filing them: the contents may both be text, but the label says how that text will be interpreted.

If the command is not recognized as one of these shell forms, it is returned unchanged.

#### Function details

##### `canonicalize_command_for_approval`  (lines 14–38)

```
fn canonicalize_command_for_approval(command: &[String]) -> Vec<String>
```

**Purpose**: This function converts a command’s argument list into the form used for approval-cache matching. It tries to ignore harmless wrapper differences while preserving the exact script text when simplifying it would be unsafe.

**Data flow**: It receives a list of command words, such as the program name and its arguments. First it asks `parse_shell_lc_plain_commands` whether this is a simple shell wrapper around one plain command; if so, it returns that inner command. If not, it asks `extract_bash_command` whether the input is a Bash-style shell script; if it is, it returns a new list with a Bash marker, the shell mode, and the exact script text. If that also does not match, it asks `extract_powershell_command` whether it is a PowerShell script; if so, it returns a PowerShell marker plus the exact script text. If none of those checks apply, it returns a copy of the original command unchanged.

**Call relations**: This function sits in the approval path as the normalizer before commands are compared with cached approval decisions. It delegates the shell-specific detective work to `parse_shell_lc_plain_commands`, `extract_bash_command`, and `extract_powershell_command`; after those helpers identify the command shape, this function decides what stable command list should be handed back for matching.

*Call graph*: calls 3 internal fn (extract_bash_command, parse_shell_lc_plain_commands, extract_powershell_command); 1 external calls (vec!).


### `shell-command/src/parse_command.rs`

`domain_logic` · `request handling`

Commands produced by an AI or typed by a user can be messy: they may be wrapped in bash, chained with pipes, or include helper tools like `head`, `sed`, or `wc`. This file is the project’s translator. It looks at a command and tries to say, in plain terms, “this searches for TODO in src” or “this reads README.md.” Without it, the rest of the system would have to show raw shell text more often, which is harder for users to review and approve.

The parser works like a cautious reader. First it unwraps shell launchers such as `bash -lc` or PowerShell `-Command`, so it can inspect the real script. Then it splits command chains and pipelines into pieces, tracks simple `cd` directory changes, and removes small formatting helpers that do not change the main intent. For example, `rg --files | head -n 40` is summarized as listing files, not as running `head`.

It recognizes many familiar tools: `rg`, `grep`, `git grep`, `find`, `fd`, `ls`, `cat`, `sed -n`, `head`, `tail`, `bat`, and more. When any part looks unclear or potentially mutating, it prefers an `Unknown` summary rather than pretending to understand. The large test block documents many edge cases and protects this delicate behavior.

#### Function details

##### `shlex_join`  (lines 10–13)

```
fn shlex_join(tokens: &[String]) -> String
```

**Purpose**: Turns a list of command words back into one shell-looking command string. It quotes words when needed so the display is close to what a user would type.

**Data flow**: It receives command tokens → asks the shell-quoting library to join them safely → returns the joined command text, or a clear placeholder if a token contains a NUL byte that cannot be represented normally.

**Call relations**: Many higher-level UI and execution paths call this when they need to show a command to a user. Inside this file, parsing helpers also use it to store the original command text in `ParsedCommand` summaries.

*Call graph*: called by 16 (build_command_execution_approval_request_item, build_command_execution_begin_item, build_command_execution_end_item, build_item_from_guardian_event, apply_bespoke_event_handling, command_assessment_action, handle_call, prompt, execve_permission_request_hook_short_circuits_prompt, parse_grep_like (+6 more)); 1 external calls (try_join).


##### `extract_shell_command`  (lines 16–18)

```
fn extract_shell_command(command: &[String]) -> Option<(&str, &str)>
```

**Purpose**: Finds the actual script inside a shell wrapper, whether the wrapper is Bash-like or PowerShell-like. This lets the parser focus on the command being run instead of the program used to launch it.

**Data flow**: It receives the full command argument list → first asks the Bash extractor, then the PowerShell extractor → returns the shell name and inner script if either format matches.

**Call relations**: When the parser gives up, `single_unknown_for_command` uses this to show only the inner script instead of noisy wrapper arguments. Other code also uses it when it needs to strip shell wrappers for display.

*Call graph*: calls 1 internal fn (extract_bash_command); called by 2 (single_unknown_for_command, strip_bash_lc_and_escape).


##### `parse_command`  (lines 30–48)

```
fn parse_command(command: &[String]) -> Vec<ParsedCommand>
```

**Purpose**: This is the public entry point for turning raw command arguments into one or more readable command summaries. It also avoids misleading partial summaries by collapsing the result to one `Unknown` if anything important could not be understood.

**Data flow**: It receives a tokenized command → delegates detailed parsing to `parse_command_impl` → removes consecutive duplicate summaries → if any summary is unknown, replaces everything with one unknown summary for the whole command; otherwise returns the cleaned summaries.

**Call relations**: Execution, approval, shell, and test code call this before showing command intent to users. It sits above all the detailed helpers and applies the final safety rule.

*Call graph*: calls 1 internal fn (parse_command_impl); called by 10 (build_item_from_guardian_event, request_command_approval, execute_user_shell_command, shell, unified_exec, create_expected_elicitation_request_params, assert_parsed, supports_tail_n_last_lines, exec_end_without_begin_uses_event_command, begin_exec_with_source); 2 external calls (with_capacity, vec!).


##### `single_unknown_for_command`  (lines 50–60)

```
fn single_unknown_for_command(command: &[String]) -> ParsedCommand
```

**Purpose**: Builds one safe fallback summary for a command the parser cannot confidently explain. It tries to display the most useful version of the command text.

**Data flow**: It receives the original command tokens → if they contain a shell wrapper, extracts the inner script → otherwise joins the tokens with shell quoting → returns a `ParsedCommand::Unknown` containing that text.

**Call relations**: Only `parse_command` calls this after it detects an unknown piece in the parsed output. It relies on `extract_shell_command` and `shlex_join` to choose readable fallback text.

*Call graph*: calls 2 internal fn (extract_shell_command, shlex_join).


##### `tests::shlex_split_safe`  (lines 71–73)

```
fn shlex_split_safe(s: &str) -> Vec<String>
```

**Purpose**: Provides a forgiving way for tests to turn a command string into tokens. If shell-style splitting fails, it falls back to simple whitespace splitting so the test can still run.

**Data flow**: It receives a command string → tries shell-aware splitting → returns tokens from that split, or tokens split on whitespace if the shell parser rejects the string.

**Call relations**: Many tests use this helper to build realistic token lists before calling `assert_parsed` or `parse_command`.

*Call graph*: 1 external calls (split).


##### `tests::vec_str`  (lines 75–77)

```
fn vec_str(args: &[&str]) -> Vec<String>
```

**Purpose**: Makes test command arguments easier to write by converting string slices into owned strings. It keeps test cases short and readable.

**Data flow**: It receives a list of string references → copies each one into a `String` → returns a vector of strings.

**Call relations**: Most tests that already know the exact argument boundaries use this helper before calling `assert_parsed`.


##### `tests::assert_parsed`  (lines 79–82)

```
fn assert_parsed(args: &[String], expected: Vec<ParsedCommand>)
```

**Purpose**: Checks that the parser returns exactly the expected command summary. It is the main assertion helper for the test suite.

**Data flow**: It receives input tokens and expected parsed commands → runs `parse_command` → compares the actual output with the expected output.

**Call relations**: Nearly every parser behavior test goes through this helper, so failures point to a mismatch in user-visible summaries.

*Call graph*: calls 1 internal fn (parse_command); 1 external calls (assert_eq!).


##### `tests::git_status_is_unknown`  (lines 85–92)

```
fn git_status_is_unknown()
```

**Purpose**: Verifies that a plain `git status` command is not over-interpreted. The parser should only summarize command types it understands well.

**Data flow**: It builds tokens for `git status` → parses them → expects one unknown summary containing the original command.

**Call relations**: This test uses `vec_str` and `assert_parsed` to protect the parser’s conservative fallback behavior.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_git_grep_and_ls_files`  (lines 95–133)

```
fn supports_git_grep_and_ls_files()
```

**Purpose**: Checks that common Git discovery commands are recognized. `git grep` should become a search, and `git ls-files` should become a file listing.

**Data flow**: It turns several Git command strings into tokens → parses each → expects search or list summaries with query and path details where available.

**Call relations**: These cases exercise the `git` branch inside `summarize_main_tokens`, through the normal public `parse_command` route.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::handles_git_pipe_wc`  (lines 136–144)

```
fn handles_git_pipe_wc()
```

**Purpose**: Ensures a pipeline containing an unsupported Git command is not partly summarized as something safer than it is. `git status | wc -l` remains unknown.

**Data flow**: It wraps a pipeline in `bash -lc` → parses it → expects one unknown summary for the inner script.

**Call relations**: This test protects the rule in `parse_command` that unknown pieces collapse the whole command to a single unknown summary.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::bash_lc_redirect_not_quoted`  (lines 147–155)

```
fn bash_lc_redirect_not_quoted()
```

**Purpose**: Checks that a Bash command with output redirection is shown plainly when unknown. This avoids odd quoting in user-facing text.

**Data flow**: It passes `echo foo > bar` through a Bash wrapper → parses it → expects an unknown summary with the inner script as written.

**Call relations**: This exercises shell extraction and fallback display through `assert_parsed`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::handles_complex_bash_command_head`  (lines 158–167)

```
fn handles_complex_bash_command_head()
```

**Purpose**: Confirms that a long mixed Bash script is not simplified into misleading pieces. Version checks and pipelines together are treated as unknown.

**Data flow**: It builds a Bash-wrapped script with several commands → parses it → expects one unknown summary for the full script.

**Call relations**: This guards the cautious behavior of `parse_shell_script` and the final unknown-collapse rule.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_searching_for_navigate_to_route`  (lines 170–181)

```
fn supports_searching_for_navigate_to_route() -> anyhow::Result<()>
```

**Purpose**: Checks that a quoted ripgrep search term is captured correctly. The user should see the search query without extra quote noise.

**Data flow**: It passes `rg -n "navigate-to-route" -S` through Bash → parses it → expects a search summary with that query and no path.

**Call relations**: This flows through Bash extraction, shell parsing, and the `rg` logic in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::handles_complex_bash_command`  (lines 184–194)

```
fn handles_complex_bash_command()
```

**Purpose**: Ensures a search piped into `head` is summarized as the search, not as the formatting step. This matches the user’s real intent.

**Data flow**: It parses a Bash script with `rg` followed by `head` → removes the formatting helper → expects a search summary with the regex query.

**Call relations**: This test depends on `parse_shell_script` and `drop_small_formatting_commands` working together.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_rg_files_with_path_and_pipe`  (lines 197–206)

```
fn supports_rg_files_with_path_and_pipe()
```

**Purpose**: Verifies that `rg --files` with a path is still recognized when piped to another helper. The parser should preserve the useful directory hint.

**Data flow**: It parses `rg --files webview/src | sed -n` → focuses on the file-listing command → expects a list summary with a shortened path of `webview`.

**Call relations**: This exercises pipeline filtering and `short_display_path` through the main parser.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_rg_files_then_head`  (lines 209–218)

```
fn supports_rg_files_then_head()
```

**Purpose**: Checks that limiting file-list output with `head` does not hide the main action. The command is still a file listing.

**Data flow**: It parses a Bash pipeline `rg --files | head -n 50` → drops `head` as a formatting helper → expects a list-files summary.

**Call relations**: This protects `is_small_formatting_command` behavior as used by `parse_shell_script`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::keeps_mutating_xargs_pipeline`  (lines 221–229)

```
fn keeps_mutating_xargs_pipeline()
```

**Purpose**: Ensures a pipeline that edits files through `xargs perl -pi` is not summarized as a harmless search. Mutating commands must remain unknown.

**Data flow**: It parses a Bash pipeline from `rg -l` into an in-place Perl replacement → detects the unsafe later stage → expects one unknown summary.

**Call relations**: This guards the `xargs` mutation detection used when deciding whether a pipeline helper can be dropped.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::collapses_plain_pipeline_when_any_stage_is_unknown`  (lines 232–242)

```
fn collapses_plain_pipeline_when_any_stage_is_unknown()
```

**Purpose**: Checks that an ordinary tokenized pipeline with an unknown or mutating stage collapses to unknown. This prevents partial, misleading summaries.

**Data flow**: It tokenizes a search piped into in-place replacement → parses it → expects one unknown summary for the whole joined command.

**Call relations**: This tests `parse_command_impl` plus the top-level unknown-collapse rule in `parse_command`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::collapses_pipeline_with_helper_when_later_stage_is_unknown`  (lines 245–253)

```
fn collapses_pipeline_with_helper_when_later_stage_is_unknown()
```

**Purpose**: Verifies that a known command followed by helpers and then an unknown command is not summarized as only the known first command.

**Data flow**: It parses `rg --files | nl -ba | foo` → sees an unknown final stage → expects one unknown summary for the whole pipeline.

**Call relations**: This protects the conservative behavior applied after `simplify_once` removes harmless helpers.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::rg_files_with_matches_flags_are_search`  (lines 256–297)

```
fn rg_files_with_matches_flags_are_search()
```

**Purpose**: Checks that ripgrep flags such as `-l` and `--files-with-matches` are treated as searches, not file listings. These flags list matching files, but the user’s action is still searching for text.

**Data flow**: It parses several `rg` and `rga` commands → extracts query and path operands → expects search summaries.

**Call relations**: These cases exercise the ripgrep branch of `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_cat`  (lines 300–310)

```
fn supports_cat()
```

**Purpose**: Verifies that `cat` of one file is recognized as reading that file. This is one of the most common inspection commands.

**Data flow**: It parses `cat webview/README.md` in Bash → extracts the file path and display name → expects a read summary.

**Call relations**: This flows through shell extraction and the `cat` branch of `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::zsh_lc_supports_cat`  (lines 313–323)

```
fn zsh_lc_supports_cat()
```

**Purpose**: Checks that the same file-read recognition works through `zsh -lc`. Bash and zsh wrappers should behave similarly here.

**Data flow**: It parses a zsh-wrapped `cat README.md` → unwraps the script → expects a read summary for README.md.

**Call relations**: This verifies shell wrapper handling before the normal read-command summarizer runs.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_bat`  (lines 326–336)

```
fn supports_bat()
```

**Purpose**: Checks that `bat`, a file viewer, is treated as reading a file even when display options are present.

**Data flow**: It parses `bat --theme TwoDark README.md` → skips the theme option and its value → expects a read summary for README.md.

**Call relations**: This exercises the `bat` branch of `summarize_main_tokens` and its flag-skipping logic.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_batcat`  (lines 339–349)

```
fn supports_batcat()
```

**Purpose**: Verifies support for `batcat`, another name for the `bat` file viewer on some systems.

**Data flow**: It parses `batcat README.md` → identifies the file operand → expects a read summary.

**Call relations**: This protects the shared `bat` and `batcat` handling in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_less`  (lines 352–362)

```
fn supports_less()
```

**Purpose**: Checks that viewing a file with `less` is summarized as reading the file, while ignoring viewer options.

**Data flow**: It parses `less -p TODO README.md` → skips the search-pattern option and value → expects a read summary for README.md.

**Call relations**: This tests the `less` branch and `single_non_flag_operand` support.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_more`  (lines 365–375)

```
fn supports_more()
```

**Purpose**: Checks that viewing a file with `more` is summarized as reading the file.

**Data flow**: It parses `more README.md` → extracts the single file operand → expects a read summary.

**Call relations**: This uses the public parser to cover the `more` branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::cd_then_cat_is_single_read`  (lines 378–387)

```
fn cd_then_cat_is_single_read()
```

**Purpose**: Verifies that a preceding `cd` changes the reported file path for a later read. The summary should show the effective file location.

**Data flow**: It parses `cd foo && cat foo.txt` → records `foo` as the current directory → expects a read path of `foo/foo.txt`.

**Call relations**: This exercises `cd_target`, `join_paths`, and command-chain parsing in `parse_command_impl`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::cd_with_double_dash_then_cat_is_read`  (lines 390–399)

```
fn cd_with_double_dash_then_cat_is_read()
```

**Purpose**: Checks that `cd -- -weird` is understood as changing into a directory whose name starts with a dash. The double dash means later text is not a flag.

**Data flow**: It parses `cd -- -weird && cat foo.txt` → treats `-weird` as the directory → expects a read path inside that directory.

**Call relations**: This protects the special `--` handling in `cd_target`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::cd_with_multiple_operands_uses_last`  (lines 402–411)

```
fn cd_with_multiple_operands_uses_last()
```

**Purpose**: Documents how the parser handles an unusual `cd` with multiple operands. It uses the last non-flag operand as the target.

**Data flow**: It parses `cd dir1 dir2 && cat foo.txt` → records `dir2` as the directory → expects the read path under `dir2`.

**Call relations**: This locks in `cd_target` behavior as used by `parse_command_impl`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bash_cd_then_bar_is_same_as_bar`  (lines 414–422)

```
fn bash_cd_then_bar_is_same_as_bar()
```

**Purpose**: Checks that a leading `cd` inside Bash does not become a separate user-facing summary when followed by an unknown command.

**Data flow**: It parses `bash -lc 'cd foo && bar'` → cannot explain `bar` safely → expects one unknown summary for the script.

**Call relations**: This exercises Bash script parsing, `cd` tracking, and unknown fallback together.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bash_cd_then_cat_is_read`  (lines 425–434)

```
fn bash_cd_then_cat_is_read()
```

**Purpose**: Verifies that `cd` inside a Bash script affects a later file read. The read summary should include the changed directory.

**Data flow**: It parses `bash -lc 'cd foo && cat foo.txt'` → records the directory change → expects a read of `foo/foo.txt`.

**Call relations**: This covers the `cd` path adjustment path in `parse_shell_script`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_ls_with_pipe`  (lines 437–446)

```
fn supports_ls_with_pipe()
```

**Purpose**: Checks that listing files with `ls` remains the main summary when its output is piped to `sed` for display.

**Data flow**: It parses `ls -la | sed -n ...` → drops the display-only `sed` stage → expects a list-files summary.

**Call relations**: This tests pipeline parsing and small formatting command removal.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_eza_exa_tree_du`  (lines 449–478)

```
fn supports_eza_exa_tree_du()
```

**Purpose**: Verifies that several directory-inspection tools are summarized as file listings. This covers modern `ls` alternatives and size/tree views.

**Data flow**: It parses `eza`, `exa`, `tree`, and `du` examples → extracts useful path operands while skipping options → expects list-file summaries.

**Call relations**: These cases exercise several listing branches in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_head_n`  (lines 481–491)

```
fn supports_head_n()
```

**Purpose**: Checks that `head -n` with a file is treated as reading that file. Limiting lines does not change the main action.

**Data flow**: It parses `head -n 50 Cargo.toml` → skips the line-count option → expects a read summary for Cargo.toml.

**Call relations**: This protects the `head` branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_head_file_only`  (lines 494–504)

```
fn supports_head_file_only()
```

**Purpose**: Verifies that `head` with only a file name is also recognized as a file read.

**Data flow**: It parses `head Cargo.toml` → treats the single operand as the file → expects a read summary.

**Call relations**: This tests the simpler path through the `head` summarizer.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_cat_sed_n`  (lines 507–517)

```
fn supports_cat_sed_n()
```

**Purpose**: Checks that `cat file | sed -n range` is summarized as reading the file. The line-range filter is only display shaping.

**Data flow**: It parses the Bash pipeline → identifies the `cat` file read as the meaningful action → expects a read summary for the file.

**Call relations**: This relies on shell pipeline parsing and formatting-helper removal.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_tail_n_plus`  (lines 520–530)

```
fn supports_tail_n_plus()
```

**Purpose**: Verifies that `tail -n +N file`, which starts reading at a line offset, is recognized as reading a file.

**Data flow**: It parses `tail -n +522 README.md` → validates the numeric offset → expects a read summary.

**Call relations**: This tests the `tail` branch in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_tail_n_last_lines`  (lines 533–544)

```
fn supports_tail_n_last_lines()
```

**Purpose**: Checks that `tail -n N file`, which reads the last lines, is also summarized as a file read.

**Data flow**: It builds a Bash-wrapped tail command → calls `parse_command` directly → compares the result with the expected read summary.

**Call relations**: Unlike most tests, it calls `parse_command` and `assert_eq!` directly, but still exercises the public parser path.

*Call graph*: calls 1 internal fn (parse_command); 2 external calls (assert_eq!, vec_str).


##### `tests::supports_tail_file_only`  (lines 547–557)

```
fn supports_tail_file_only()
```

**Purpose**: Verifies that `tail` with only a file name is recognized as reading that file.

**Data flow**: It parses `tail README.md` → treats the single operand as the file → expects a read summary.

**Call relations**: This covers the simple file-only branch of `summarize_main_tokens` for `tail`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_npm_run_build_is_unknown`  (lines 560–567)

```
fn supports_npm_run_build_is_unknown()
```

**Purpose**: Checks that build commands are not guessed as reads, searches, or listings. They remain unknown because they can do many things.

**Data flow**: It parses `npm run build` → finds no known safe summary shape → expects an unknown summary.

**Call relations**: This protects conservative fallback behavior in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_grep_recursive_current_dir`  (lines 570–579)

```
fn supports_grep_recursive_current_dir()
```

**Purpose**: Verifies that recursive `grep` over the current directory is summarized as a search with query and path.

**Data flow**: It parses `grep -R CODEX_SANDBOX_ENV_VAR -n .` → skips flags → expects a search summary for the query in `.`.

**Call relations**: This exercises `parse_grep_like` through the `grep` branch.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_grep_recursive_specific_file`  (lines 582–597)

```
fn supports_grep_recursive_specific_file()
```

**Purpose**: Checks that a recursive grep targeting a specific file reports a useful shortened path. The query must stay separate from the file path.

**Data flow**: It parses a grep command with a file path → extracts the search term and short display path → expects a search summary.

**Call relations**: This covers `parse_grep_like` and `short_display_path` together.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_egrep_and_fgrep`  (lines 600–617)

```
fn supports_egrep_and_fgrep()
```

**Purpose**: Verifies that `egrep` and `fgrep` are treated like `grep` for search summaries.

**Data flow**: It parses examples using both commands → extracts query and path → expects search summaries.

**Call relations**: This protects the grep-like command match in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::grep_files_with_matches_flags_are_search`  (lines 620–653)

```
fn grep_files_with_matches_flags_are_search()
```

**Purpose**: Checks that grep commands which output matching file names are still summarized as searches. The important user intent is finding text.

**Data flow**: It parses grep variants with `-l`, `-L`, and long forms → extracts the query and path → expects search summaries.

**Call relations**: These cases exercise `parse_grep_like` and ensure file-list-looking flags do not change the summary type.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_grep_query_with_slashes_not_shortened`  (lines 656–667)

```
fn supports_grep_query_with_slashes_not_shortened()
```

**Purpose**: Ensures grep patterns that contain slashes are not mistaken for paths and shortened. A pattern like `src/main.rs` may be literal text.

**Data flow**: It parses `grep -R src/main.rs -n .` → preserves the full query string → expects path `.` separately.

**Call relations**: This protects the query-handling rule inside `parse_grep_like`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_grep_weird_backtick_in_query`  (lines 670–679)

```
fn supports_grep_weird_backtick_in_query()
```

**Purpose**: Checks that unusual characters in a grep query are preserved and safely quoted in the displayed command.

**Data flow**: It tokenizes a grep command with a backtick in the query → parses it → expects the query unchanged and the command string safely quoted.

**Call relations**: This exercises `shlex_join` as used by `parse_grep_like`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_cd_and_rg_files`  (lines 682–690)

```
fn supports_cd_and_rg_files()
```

**Purpose**: Verifies that a `cd` before `rg --files` does not create a separate summary. The main action remains listing files.

**Data flow**: It parses `cd codex-rs && rg --files` → records but does not display the `cd` → expects a list-files summary.

**Call relations**: This tests sequence parsing and `cd` simplification in `parse_command_impl`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_single_string_script_with_cd_and_pipe`  (lines 693–703)

```
fn supports_single_string_script_with_cd_and_pipe()
```

**Purpose**: Checks that a realistic Bash script with `cd`, search, and `head` is summarized as the search. The command’s working directory setup should not obscure intent.

**Data flow**: It parses a Bash-wrapped script → ignores the directory setup and output limiter → expects a search summary with query and path.

**Call relations**: This exercises `parse_shell_script`, `cd_target`, and formatting-helper filtering.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_python_walks_files`  (lines 706–715)

```
fn supports_python_walks_files()
```

**Purpose**: Verifies that a Python one-liner which lists directory contents is summarized as listing files. The parser recognizes common filesystem-walking APIs.

**Data flow**: It parses `python -c` containing `os.listdir` → detects file-walking code → expects a list-files summary.

**Call relations**: This covers `python_walks_files` through the Python branch of `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_python3_walks_files`  (lines 718–727)

```
fn supports_python3_walks_files()
```

**Purpose**: Checks the same file-listing detection for `python3`. Python version names should not change the summary.

**Data flow**: It parses a `python3 -c` script using `glob.glob` → detects file listing behavior → expects a list-files summary.

**Call relations**: This tests `is_python_command` and `python_walks_files` together.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::python_without_file_walk_is_unknown`  (lines 730–738)

```
fn python_without_file_walk_is_unknown()
```

**Purpose**: Ensures arbitrary Python code is not guessed as file listing. Only recognized filesystem-walking snippets get that summary.

**Data flow**: It parses `python -c "print('hello')"` → finds no file-walking API → expects an unknown summary.

**Call relations**: This protects the conservative fallback in the Python branch.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::small_formatting_always_true_commands`  (lines 742–749)

```
fn small_formatting_always_true_commands()
```

**Purpose**: Checks that simple pipeline helpers like `wc`, `tr`, and `sort` are always considered formatting-only. These usually shape output rather than define the main action.

**Data flow**: It feeds each helper command, with and without a dummy flag, into `is_small_formatting_command` → expects true.

**Call relations**: This directly tests the helper-classification logic used by `drop_small_formatting_commands`.

*Call graph*: 1 external calls (assert!).


##### `tests::awk_behavior`  (lines 752–762)

```
fn awk_behavior()
```

**Purpose**: Verifies when `awk` is considered just formatting and when it reads a file. An `awk` script alone is formatting; an `awk` command with a data file is a read.

**Data flow**: It checks several `awk` token lists → expects true when no file operand exists and false when a file is present.

**Call relations**: This directly covers `awk_data_file_operand` as used by `is_small_formatting_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::head_behavior`  (lines 765–778)

```
fn head_behavior()
```

**Purpose**: Checks when `head` is a pipeline helper versus a file read. `head -n 40` alone is formatting, but `head -n 40 file` reads a file.

**Data flow**: It passes several `head` forms into `is_small_formatting_command` → expects true only when there is no explicit file operand.

**Call relations**: This protects the `head` logic used to drop helpers from pipelines.

*Call graph*: 1 external calls (assert!).


##### `tests::tail_behavior`  (lines 781–805)

```
fn tail_behavior()
```

**Purpose**: Checks when `tail` is a formatting helper versus a file read. Counts without a file are helpers; counts with a file are reads.

**Data flow**: It tests several `tail` forms with line and byte counts → expects helper classification only when no file operand appears.

**Call relations**: This directly tests the `tail` branch of `is_small_formatting_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::sed_behavior`  (lines 808–833)

```
fn sed_behavior()
```

**Purpose**: Verifies that only clear `sed -n range file` forms are treated as file reads. Other `sed` uses stay formatting-only in pipelines.

**Data flow**: It passes several `sed` token lists into `is_small_formatting_command` → expects false for valid range-plus-file forms and true for ambiguous forms.

**Call relations**: This protects `sed_read_path`, which both classifies helpers and builds read summaries.

*Call graph*: 1 external calls (assert!).


##### `tests::empty_tokens_is_not_small`  (lines 836–839)

```
fn empty_tokens_is_not_small()
```

**Purpose**: Checks that an empty token list is not classified as a formatting command. Empty input should not look like a real helper.

**Data flow**: It creates an empty vector → passes it to `is_small_formatting_command` → expects false.

**Call relations**: This guards a boundary case in the formatting-helper classifier.

*Call graph*: 2 external calls (new, assert!).


##### `tests::supports_nl_then_sed_reading`  (lines 842–852)

```
fn supports_nl_then_sed_reading()
```

**Purpose**: Verifies that numbering a file with `nl` and then filtering lines with `sed` is summarized as reading the file.

**Data flow**: It parses `nl -ba file | sed -n range` → keeps the `nl` file operand as the meaningful read → expects a read summary.

**Call relations**: This exercises the `nl` branch in `summarize_main_tokens` and pipeline helper filtering.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_sed_n`  (lines 855–865)

```
fn supports_sed_n()
```

**Purpose**: Checks that `sed -n range file` is recognized as reading a file. This is a common way to inspect part of a file.

**Data flow**: It parses a Bash-wrapped `sed -n` command → validates the range expression → expects a read summary.

**Call relations**: This covers `sed_read_path` through `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_awk_with_file`  (lines 868–878)

```
fn supports_awk_with_file()
```

**Purpose**: Verifies that `awk` with a data file is summarized as reading that file.

**Data flow**: It parses `awk '{print $1}' Cargo.toml` → identifies the second non-flag operand as the file → expects a read summary.

**Call relations**: This tests `awk_data_file_operand` through the main summarizer.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::filters_out_printf`  (lines 881–892)

```
fn filters_out_printf()
```

**Purpose**: Checks that banner-printing with `printf` is ignored when followed by a real file read. Decorative output should not become the summary.

**Data flow**: It parses a Bash script that prints a header then cats a file → drops `printf` → expects a read summary for the file.

**Call relations**: This protects `is_small_formatting_command` and `drop_small_formatting_commands` behavior.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::drops_yes_in_pipelines`  (lines 895–905)

```
fn drops_yes_in_pipelines()
```

**Purpose**: Verifies that `yes |` before a command is ignored when it is only feeding input. The parser should focus on the primary command.

**Data flow**: It parses `yes | rg --files` → removes the `yes` stage → expects a list-files summary.

**Call relations**: This exercises shell pipeline parsing and helper removal.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::supports_sed_n_then_nl_as_search`  (lines 908–921)

```
fn supports_sed_n_then_nl_as_search()
```

**Purpose**: Checks that reading a file slice with `sed -n` and piping to `nl` is summarized as a file read. The line numbering is not the main action.

**Data flow**: It tokenizes `sed -n range file | nl -ba` → drops trailing numbering helper → expects a read summary for the file.

**Call relations**: This covers `sed_read_path`, `simplify_once`, and the final parser flow.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::preserves_rg_with_spaces`  (lines 924–933)

```
fn preserves_rg_with_spaces()
```

**Purpose**: Ensures a ripgrep query containing spaces stays intact. The parser should not split the user’s search phrase incorrectly.

**Data flow**: It parses `yes | rg -n 'foo bar' -S` → removes the `yes` helper → expects a search query of `foo bar`.

**Call relations**: This tests shell splitting and the ripgrep branch of `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::ls_with_glob`  (lines 936–944)

```
fn ls_with_glob()
```

**Purpose**: Checks that `ls` with an ignore glob is still summarized as listing files. The glob option should not be mistaken for a path.

**Data flow**: It parses `ls -I '*.test.js'` → skips the option value → expects a list-files summary with no path.

**Call relations**: This exercises flag-value skipping for the `ls` branch.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::strips_true_in_sequence`  (lines 947–964)

```
fn strips_true_in_sequence()
```

**Purpose**: Verifies that `true` is removed from command sequences. It is a no-op command, meaning it does nothing useful for the summary.

**Data flow**: It parses commands with `true` before and after `rg --files` → removes `true` → expects only the file-listing summary.

**Call relations**: This protects `simplify_once` as used after tokenized sequence parsing.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::strips_true_inside_bash_lc`  (lines 967–985)

```
fn strips_true_inside_bash_lc()
```

**Purpose**: Checks the same no-op removal inside Bash-wrapped scripts. `true` should not distract from the real command.

**Data flow**: It parses Bash scripts containing `true` with `rg --files` → removes the no-op → expects list-files summaries.

**Call relations**: This covers the `true` simplification path inside `parse_shell_script`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::shorten_path_on_windows`  (lines 988–997)

```
fn shorten_path_on_windows()
```

**Purpose**: Verifies that Windows-style backslash paths are displayed with a useful file name while preserving the original path.

**Data flow**: It parses `cat "pkg\src\main.rs"` → shortens the display name to `main.rs` → expects the stored path to keep the Windows-style separators.

**Call relations**: This tests `short_display_path` and read-summary construction.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::head_with_no_space`  (lines 1000–1009)

```
fn head_with_no_space()
```

**Purpose**: Checks that compact `head -n50 file` syntax is recognized. The parser should handle both spaced and unspaced count flags.

**Data flow**: It parses a Bash-wrapped `head -n50 Cargo.toml` → validates the count → expects a read summary.

**Call relations**: This protects the compact flag logic in the `head` branch.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bash_dash_c_pipeline_parsing`  (lines 1012–1022)

```
fn bash_dash_c_pipeline_parsing()
```

**Purpose**: Verifies that `bash -c` is parsed like `bash -lc` for pipelines. Both forms carry an inner script.

**Data flow**: It parses `bash -c 'rg --files | head -n 1'` → unwraps the script and drops `head` → expects a list-files summary.

**Call relations**: This tests Bash extraction before `parse_shell_script`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::tail_with_no_space`  (lines 1025–1034)

```
fn tail_with_no_space()
```

**Purpose**: Checks compact `tail -n+10 file` syntax. The parser should recognize the offset even without a space.

**Data flow**: It parses a Bash-wrapped compact tail command → validates the numeric offset → expects a read summary.

**Call relations**: This protects the compact flag logic in the `tail` branch.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::grep_with_query_and_path`  (lines 1037–1046)

```
fn grep_with_query_and_path()
```

**Purpose**: Verifies a basic grep command with both query and path. This is the standard search case.

**Data flow**: It parses `grep -R TODO src` → extracts `TODO` as the query and `src` as the path → expects a search summary.

**Call relations**: This exercises `parse_grep_like` through the normal parser.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::supports_ag_ack_pt_rga`  (lines 1049–1082)

```
fn supports_ag_ack_pt_rga()
```

**Purpose**: Checks that several grep-like search tools are recognized. Users may use `ag`, `ack`, `pt`, or `rga` instead of `grep` or `rg`.

**Data flow**: It parses example commands for each tool → extracts query and path → expects search summaries.

**Call relations**: These tests cover both the `ag`/`ack`/`pt` branch and the `rga` handling in `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::ag_ack_pt_files_with_matches_flags_are_search`  (lines 1085–1110)

```
fn ag_ack_pt_files_with_matches_flags_are_search()
```

**Purpose**: Verifies that `-l` with `ag`, `ack`, and `pt` still means a search summary. Listing matching file names is still driven by a text query.

**Data flow**: It parses three commands with `-l` → extracts the search term and path → expects search summaries.

**Call relations**: This protects the search-tool branch from treating `-l` as a plain listing.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::rg_with_equals_style_flags`  (lines 1113–1122)

```
fn rg_with_equals_style_flags()
```

**Purpose**: Checks that long options written as `--flag=value` do not become query or path operands. They should be ignored when extracting meaning.

**Data flow**: It parses `rg --colors=never -n foo src` → skips the equals-style option → expects query `foo` and path `src`.

**Call relations**: This tests `skip_flag_values` behavior inside ripgrep parsing.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::cat_with_double_dash_and_sed_ranges`  (lines 1125–1145)

```
fn cat_with_double_dash_and_sed_ranges()
```

**Purpose**: Verifies two common edge cases: file names that look like flags after `--`, and valid `sed -n` range reads.

**Data flow**: It parses `cat -- ./-strange-file-name` and `sed -n '12,20p' Cargo.toml` → treats both as file reads → checks names and paths.

**Call relations**: This covers `positional_operands` double-dash handling and `sed_read_path` range validation.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::drop_trailing_nl_in_pipeline`  (lines 1148–1157)

```
fn drop_trailing_nl_in_pipeline()
```

**Purpose**: Checks that a trailing `nl` line-numbering stage is removed from a file-listing pipeline. Line numbering is only presentation.

**Data flow**: It parses `rg --files | nl -ba` → drops the `nl` helper → expects a list-files summary.

**Call relations**: This protects `simplify_once` and helper removal behavior.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::ls_with_time_style_and_path`  (lines 1160–1169)

```
fn ls_with_time_style_and_path()
```

**Purpose**: Verifies that `ls` options with values are skipped when finding the listed path. It also documents how display paths are shortened.

**Data flow**: It parses `ls --time-style=long-iso ./dist` → ignores the option → shortens the path display → expects a list-files summary.

**Call relations**: This tests `skip_flag_values` and `short_display_path` through the `ls` summarizer.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::fd_file_finder_variants`  (lines 1172–1190)

```
fn fd_file_finder_variants()
```

**Purpose**: Checks two uses of `fd`: listing files with type filters, and searching by name within a path.

**Data flow**: It parses `fd -t f src/` and `fd main src` → skips type option values → expects list or search summaries as appropriate.

**Call relations**: This directly exercises `parse_fd_query_and_path` through `summarize_main_tokens`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::find_basic_name_filter`  (lines 1193–1202)

```
fn find_basic_name_filter()
```

**Purpose**: Verifies that `find` with a name filter is summarized as a search. The name pattern becomes the query.

**Data flow**: It parses `find . -name '*.rs'` → extracts root path `.` and query `*.rs` → expects a search summary.

**Call relations**: This covers `parse_find_query_and_path`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::find_type_only_path`  (lines 1205–1213)

```
fn find_type_only_path()
```

**Purpose**: Checks that `find` without a name-like filter is summarized as listing files. A type filter alone does not supply a search query.

**Data flow**: It parses `find src -type f` → extracts the root path and no query → expects a list-files summary.

**Call relations**: This exercises the list-files path through `parse_find_query_and_path`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bin_bash_lc_sed`  (lines 1216–1225)

```
fn bin_bash_lc_sed()
```

**Purpose**: Verifies that Bash wrappers are recognized even when invoked by a full path such as `/bin/bash`. The inner `sed` read should still be parsed.

**Data flow**: It tokenizes a full-path Bash command with `sed -n` → unwraps the script → expects a read summary.

**Call relations**: This tests shell extraction before `parse_shell_script`.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::bin_zsh_lc_sed`  (lines 1227–1236)

```
fn bin_zsh_lc_sed()
```

**Purpose**: Checks the same full-path shell handling for zsh. `/bin/zsh -lc` should not block command understanding.

**Data flow**: It tokenizes a full-path zsh command with `sed -n` → unwraps the script → expects a read summary.

**Call relations**: This covers zsh extraction through the public parser.

*Call graph*: 3 external calls (assert_parsed, shlex_split_safe, vec!).


##### `tests::powershell_command_is_stripped`  (lines 1239–1246)

```
fn powershell_command_is_stripped()
```

**Purpose**: Verifies that PowerShell wrappers are stripped for display. The parser does not deeply understand PowerShell, but it can show the inner command.

**Data flow**: It parses `powershell -Command Get-ChildItem` → extracts `Get-ChildItem` → expects an unknown summary for that script text.

**Call relations**: This exercises `extract_powershell_command` through `parse_command_impl`.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::pwsh_with_noprofile_and_c_alias_is_stripped`  (lines 1249–1256)

```
fn pwsh_with_noprofile_and_c_alias_is_stripped()
```

**Purpose**: Checks PowerShell Core (`pwsh`) with common flags and `-c` alias. The meaningful inner command should be shown.

**Data flow**: It parses `pwsh -NoProfile -c Write-Host hi` → extracts the script → expects an unknown summary for `Write-Host hi`.

**Call relations**: This protects PowerShell extraction in the main parser flow.

*Call graph*: 3 external calls (assert_parsed, vec_str, vec!).


##### `tests::powershell_with_path_is_stripped`  (lines 1259–1272)

```
fn powershell_with_path_is_stripped()
```

**Purpose**: Verifies that PowerShell is recognized even when invoked by an absolute executable path. This matters across Windows and Unix-like systems.

**Data flow**: It chooses a platform-appropriate PowerShell path → parses a command with `-NoProfile -c` → expects the inner script as an unknown summary.

**Call relations**: This tests path-tolerant PowerShell extraction through `parse_command`.

*Call graph*: 4 external calls (cfg!, assert_parsed, vec_str, vec!).


##### `parse_command_impl`  (lines 1275–1336)

```
fn parse_command_impl(command: &[String]) -> Vec<ParsedCommand>
```

**Purpose**: Does the main parsing work before the public safety cleanup. It unwraps shells, splits command chains, tracks simple directory changes, summarizes each piece, and simplifies harmless noise.

**Data flow**: It receives tokenized command arguments → tries shell-script parsing or PowerShell extraction first → normalizes wrappers and connectors → summarizes each command segment while applying `cd` to read paths → repeatedly simplifies the result → returns parsed summaries.

**Call relations**: `parse_command` calls this for normal user-facing parsing, and another detector uses it for skill-document reads. It coordinates many lower-level helpers such as `normalize_tokens`, `summarize_main_tokens`, `cd_target`, `join_paths`, and `simplify_once`.

*Call graph*: calls 9 internal fn (cd_target, contains_connectors, join_paths, normalize_tokens, parse_shell_lc_commands, simplify_once, split_on_connectors, summarize_main_tokens, extract_powershell_command); called by 2 (detect_skill_doc_read, parse_command); 3 external calls (from, new, vec!).


##### `simplify_once`  (lines 1338–1394)

```
fn simplify_once(commands: &[ParsedCommand]) -> Option<Vec<ParsedCommand>>
```

**Purpose**: Removes one harmless or distracting summary from a list of parsed commands. It is like tidying a sentence by deleting filler words such as `echo`, `cd`, `true`, or line numbering.

**Data flow**: It receives parsed command summaries → looks for one simplifiable pattern → returns a new shorter list if it found one, or `None` if nothing should be changed.

**Call relations**: `parse_command_impl` and `parse_shell_script` call this in a loop until no more cleanup is possible.

*Call graph*: called by 2 (parse_command_impl, parse_shell_script); 4 external calls (with_capacity, iter, len, split).


##### `is_valid_sed_n_arg`  (lines 1397–1417)

```
fn is_valid_sed_n_arg(arg: Option<&str>) -> bool
```

**Purpose**: Checks whether a `sed -n` script looks like a simple line-range print, such as `10p` or `1,200p`. This keeps the parser from treating arbitrary `sed` scripts as safe file reads.

**Data flow**: It receives an optional argument string → verifies it ends in `p` and contains one or two numeric parts → returns true only for that simple range shape.

**Call relations**: `sed_read_path` calls this when deciding whether a `sed` command reads a file range.

*Call graph*: called by 1 (sed_read_path).


##### `sed_read_path`  (lines 1419–1460)

```
fn sed_read_path(args: &[String]) -> Option<String>
```

**Purpose**: Finds the file path in a safe-looking `sed -n range file` command. It only succeeds for simple line-printing forms.

**Data flow**: It receives `sed` arguments → ignores anything after connectors → checks for `-n` and a valid range script → skips option values → returns the likely file path, or nothing if the command is ambiguous.

**Call relations**: `summarize_main_tokens` uses this to create read summaries for `sed`, and `is_small_formatting_command` uses it to decide whether `sed` is just a pipeline helper.

*Call graph*: calls 3 internal fn (is_valid_sed_n_arg, skip_flag_values, trim_at_connector); called by 2 (is_small_formatting_command, summarize_main_tokens); 1 external calls (matches!).


##### `normalize_tokens`  (lines 1465–1482)

```
fn normalize_tokens(cmd: &[String]) -> Vec<String>
```

**Purpose**: Peels off a few simple wrappers and prefixes from an already-tokenized command. This makes later parsing look at the real command.

**Data flow**: It receives command tokens → removes leading `yes |` or `no |`, or splits a simple `bash/zsh -c/-lc` script into tokens → otherwise returns the original tokens copied.

**Call relations**: `parse_command_impl` calls this before splitting on connectors and summarizing command parts.

*Call graph*: called by 1 (parse_command_impl); 1 external calls (split).


##### `contains_connectors`  (lines 1484–1488)

```
fn contains_connectors(tokens: &[String]) -> bool
```

**Purpose**: Checks whether a token list contains shell connectors such as pipes, `&&`, `||`, or semicolons. These marks mean the command should be split into stages.

**Data flow**: It receives tokens → scans for connector strings → returns true if any are present.

**Call relations**: `parse_command_impl` uses this to decide whether to call `split_on_connectors`.

*Call graph*: called by 1 (parse_command_impl).


##### `split_on_connectors`  (lines 1490–1506)

```
fn split_on_connectors(tokens: &[String]) -> Vec<Vec<String>>
```

**Purpose**: Breaks a token list into separate command chunks at shell connectors. Each chunk can then be summarized on its own.

**Data flow**: It receives tokens → builds groups between `|`, `&&`, `||`, and `;` → returns a vector of non-empty token groups.

**Call relations**: `parse_command_impl` calls this after `contains_connectors` finds connector tokens.

*Call graph*: called by 1 (parse_command_impl); 2 external calls (new, take).


##### `trim_at_connector`  (lines 1508–1514)

```
fn trim_at_connector(tokens: &[String]) -> Vec<String>
```

**Purpose**: Keeps only the part of an argument list before the first connector. This prevents later pipeline text from being mistaken for an argument to the current command.

**Data flow**: It receives tokens → finds the first connector if present → returns a copy of tokens before that point.

**Call relations**: Many command-specific parsers call this before extracting operands, including grep, sed, awk, fd, find, Python, and ripgrep handling.

*Call graph*: called by 7 (awk_data_file_operand, parse_fd_query_and_path, parse_find_query_and_path, parse_grep_like, python_walks_files, sed_read_path, summarize_main_tokens).


##### `short_display_path`  (lines 1521–1532)

```
fn short_display_path(path: &str) -> String
```

**Purpose**: Turns a long path into a short, useful label for display. It skips generic directory names like `src`, `dist`, and `node_modules` when possible.

**Data flow**: It receives a path string → normalizes backslashes, trims trailing slashes, walks path parts from the end while ignoring generic names → returns the first useful part or the trimmed path.

**Call relations**: Search, listing, and read summaries use this through `summarize_main_tokens`, `parse_fd_query_and_path`, and `parse_find_query_and_path`.

*Call graph*: called by 3 (parse_fd_query_and_path, parse_find_query_and_path, summarize_main_tokens).


##### `skip_flag_values`  (lines 1535–1564)

```
fn skip_flag_values(args: &'a [String], flags_with_vals: &[&str]) -> Vec<&'a String>
```

**Purpose**: Filters out command-line flags and the values that belong to specific flags. This helps find real file or query operands.

**Data flow**: It receives argument tokens and a list of flags that take a following value → skips those flags, their values, and `--flag=value` tokens → returns references to the remaining arguments, with `--` marking the rest as positional.

**Call relations**: Several parsers use this before deciding which non-flag words are paths or queries.

*Call graph*: called by 4 (awk_data_file_operand, parse_fd_query_and_path, sed_read_path, summarize_main_tokens); 1 external calls (new).


##### `first_non_flag_operand`  (lines 1566–1571)

```
fn first_non_flag_operand(args: &[String], flags_with_vals: &[&str]) -> Option<String>
```

**Purpose**: Finds the first positional argument after ignoring known flags. It is useful for commands where the first remaining word is usually a path.

**Data flow**: It receives arguments and flags with values → calls `positional_operands` → returns the first operand copied, or nothing.

**Call relations**: `summarize_main_tokens` uses this for listing tools such as `ls`, `tree`, and `du`.

*Call graph*: calls 1 internal fn (positional_operands); called by 1 (summarize_main_tokens).


##### `single_non_flag_operand`  (lines 1573–1580)

```
fn single_non_flag_operand(args: &[String], flags_with_vals: &[&str]) -> Option<String>
```

**Purpose**: Finds a positional argument only when there is exactly one. This avoids calling a command a file read when multiple file-like operands make the meaning unclear.

**Data flow**: It receives arguments and flags with values → gathers positional operands → returns the only operand if exactly one exists, otherwise returns nothing.

**Call relations**: `summarize_main_tokens` uses this for file viewers like `cat`, `bat`, `less`, and `more`.

*Call graph*: calls 1 internal fn (positional_operands); called by 1 (summarize_main_tokens).


##### `positional_operands`  (lines 1582–1614)

```
fn positional_operands(args: &'a [String], flags_with_vals: &[&str]) -> Vec<&'a String>
```

**Purpose**: Extracts arguments that are not flags and not values consumed by known flags. It is the shared tool for finding real command operands.

**Data flow**: It receives argument tokens and flags that consume values → walks left to right, respecting `--` and skipping flags → returns references to the remaining positional operands.

**Call relations**: `first_non_flag_operand` and `single_non_flag_operand` are small wrappers around this function.

*Call graph*: called by 2 (first_non_flag_operand, single_non_flag_operand); 1 external calls (new).


##### `parse_grep_like`  (lines 1616–1671)

```
fn parse_grep_like(main_cmd: &[String], args: &[String]) -> ParsedCommand
```

**Purpose**: Summarizes `grep`-style commands as searches. It carefully separates the pattern being searched for from the path being searched in.

**Data flow**: It receives the full command and its arguments → trims at connectors → handles pattern flags like `-e` and skips option values → chooses a query and optional path → returns a search summary with the joined command text.

**Call relations**: `summarize_main_tokens` calls this for `grep`, `egrep`, `fgrep`, and `git grep`.

*Call graph*: calls 2 internal fn (shlex_join, trim_at_connector); called by 1 (summarize_main_tokens); 1 external calls (new).


##### `awk_data_file_operand`  (lines 1673–1696)

```
fn awk_data_file_operand(args: &[String]) -> Option<String>
```

**Purpose**: Finds the data file in an `awk` command when one is clearly present. This distinguishes `awk` used as a pipeline formatter from `awk` reading a file.

**Data flow**: It receives `awk` arguments → trims at connectors → skips known option values → if a script file is used, picks the first non-flag file; otherwise picks the operand after the inline program → returns the file path if found.

**Call relations**: `is_small_formatting_command` uses this to classify `awk`, and `summarize_main_tokens` uses it to build read summaries.

*Call graph*: calls 2 internal fn (skip_flag_values, trim_at_connector); called by 2 (is_small_formatting_command, summarize_main_tokens).


##### `python_walks_files`  (lines 1698–1715)

```
fn python_walks_files(args: &[String]) -> bool
```

**Purpose**: Detects simple Python one-liners that list or walk files. It only looks for common filesystem API names inside `python -c` scripts.

**Data flow**: It receives Python arguments → finds a `-c` script → searches the script text for APIs like `os.listdir`, `glob.glob`, or `Path.rglob` → returns true if one is found.

**Call relations**: `summarize_main_tokens` calls this after `is_python_command` identifies a Python executable.

*Call graph*: calls 1 internal fn (trim_at_connector); called by 1 (summarize_main_tokens).


##### `is_python_command`  (lines 1717–1723)

```
fn is_python_command(cmd: &str) -> bool
```

**Purpose**: Recognizes common Python executable names. This lets the parser apply Python-specific one-liner detection.

**Data flow**: It receives a command name string → checks exact names like `python` and `python3`, plus versioned names like `python3.11` → returns true or false.

**Call relations**: `summarize_main_tokens` uses this before calling `python_walks_files`.

*Call graph*: called by 1 (summarize_main_tokens).


##### `cd_target`  (lines 1725–1748)

```
fn cd_target(args: &[String]) -> Option<String>
```

**Purpose**: Extracts the target directory from a `cd` command. It understands simple flags and the `--` marker used before names that may start with a dash.

**Data flow**: It receives arguments after `cd` → skips `-L`, `-P`, and other flag-looking tokens → honors `--` by taking the next argument → returns the last usable target directory, if any.

**Call relations**: `parse_command_impl` and `parse_shell_script` call this while tracking the effective directory for later file reads.

*Call graph*: called by 2 (parse_command_impl, parse_shell_script); 1 external calls (matches!).


##### `is_pathish`  (lines 1750–1757)

```
fn is_pathish(s: &str) -> bool
```

**Purpose**: Guesses whether a string looks like a path rather than a search query. It checks for dots, slashes, and Windows backslashes.

**Data flow**: It receives a string → checks for `.` or `..`, relative path prefixes, forward slashes, or backslashes → returns true if it looks path-like.

**Call relations**: `parse_fd_query_and_path` uses this when a single `fd` operand could be either a query or a path.

*Call graph*: called by 1 (parse_fd_query_and_path).


##### `parse_fd_query_and_path`  (lines 1759–1790)

```
fn parse_fd_query_and_path(tail: &[String]) -> (Option<String>, Option<String>)
```

**Purpose**: Extracts the search query and/or path from an `fd` file-finder command. `fd` can mean either “list files here” or “find names matching this.”

**Data flow**: It receives `fd` arguments → trims at connectors and skips flags that take values → inspects remaining non-flag operands → returns optional query and path, shortening paths for display.

**Call relations**: `summarize_main_tokens` calls this for `fd` and then chooses either a search or list-files summary.

*Call graph*: calls 4 internal fn (is_pathish, short_display_path, skip_flag_values, trim_at_connector); called by 1 (summarize_main_tokens).


##### `parse_find_query_and_path`  (lines 1792–1816)

```
fn parse_find_query_and_path(tail: &[String]) -> (Option<String>, Option<String>)
```

**Purpose**: Extracts a root path and common name-like filter from a `find` command. It supports simple, useful summaries without trying to understand all of `find`.

**Data flow**: It receives `find` arguments → trims at connectors → picks the first non-operator positional argument as the path → looks for filters like `-name`, `-path`, or `-regex` → returns optional query and path.

**Call relations**: `summarize_main_tokens` uses this to decide whether `find` is a search or a file listing.

*Call graph*: calls 2 internal fn (short_display_path, trim_at_connector); called by 1 (summarize_main_tokens).


##### `parse_shell_lc_commands`  (lines 1818–1822)

```
fn parse_shell_lc_commands(original: &[String]) -> Option<Vec<ParsedCommand>>
```

**Purpose**: Recognizes Bash-like shell wrapper commands and parses their inner script. It keeps PowerShell out because PowerShell has different syntax.

**Data flow**: It receives original command tokens → asks the Bash extractor for an inner script → if found, passes that script to `parse_shell_script` → returns parsed summaries or nothing.

**Call relations**: `parse_command_impl` calls this first so shell-wrapped commands get full script-aware parsing.

*Call graph*: calls 2 internal fn (extract_bash_command, parse_shell_script); called by 1 (parse_command_impl).


##### `parse_shell_script`  (lines 1825–1951)

```
fn parse_shell_script(script: &str) -> Vec<ParsedCommand>
```

**Purpose**: Parses a Bash-compatible script string into readable command summaries. It understands command sequences and pipelines better than simple token splitting.

**Data flow**: It receives a script string → tries to parse it into a shell syntax tree → extracts word-only commands → drops small formatting helpers → tracks `cd` for read paths → summarizes each main command → simplifies no-ops and adjusts displayed command text → returns parsed summaries, or unknown if parsing fails.

**Call relations**: `parse_shell_lc_commands` calls this for Bash/zsh wrappers, and memory-related code also uses it to classify commands. It coordinates shell parsing, helper filtering, `summarize_main_tokens`, `join_paths`, and `simplify_once`.

*Call graph*: calls 7 internal fn (try_parse_shell, try_parse_word_only_commands_sequence, cd_target, drop_small_formatting_commands, join_paths, simplify_once, summarize_main_tokens); called by 2 (memories_usage_kinds_from_command, parse_shell_lc_commands); 4 external calls (from, new, split, vec!).


##### `is_small_formatting_command`  (lines 1956–2023)

```
fn is_small_formatting_command(tokens: &[String]) -> bool
```

**Purpose**: Decides whether a command is just shaping output in a pipeline rather than being the main action. Examples include `wc`, `head` without a file, and simple `sed` filters.

**Data flow**: It receives command tokens → checks the command name and argument shape → returns true for harmless formatting helpers and false for commands that clearly read files or may mutate data.

**Call relations**: `drop_small_formatting_commands` uses this when cleaning shell-script pipelines. Its decisions are heavily covered by tests because they affect what users see.

*Call graph*: calls 3 internal fn (awk_data_file_operand, is_mutating_xargs_command, sed_read_path).


##### `is_mutating_xargs_command`  (lines 2025–2027)

```
fn is_mutating_xargs_command(tokens: &[String]) -> bool
```

**Purpose**: Detects whether an `xargs` command appears to run a file-changing subcommand. This prevents unsafe pipelines from being dismissed as harmless formatting.

**Data flow**: It receives command tokens → extracts the subcommand run by `xargs` → checks whether that subcommand looks mutating → returns true or false.

**Call relations**: `is_small_formatting_command` calls this before deciding whether `xargs` can be dropped as a helper.

*Call graph*: calls 1 internal fn (xargs_subcommand); called by 1 (is_small_formatting_command).


##### `xargs_subcommand`  (lines 2029–2053)

```
fn xargs_subcommand(tokens: &[String]) -> Option<&[String]>
```

**Purpose**: Finds the command that `xargs` will run after its own options. This is needed to decide whether the pipeline might edit files.

**Data flow**: It receives tokens starting with `xargs` → skips known `xargs` options and their values → returns the remaining subcommand tokens, or nothing if none are found.

**Call relations**: `is_mutating_xargs_command` calls this, then passes the result to the mutating-subcommand check.

*Call graph*: called by 1 (is_mutating_xargs_command); 1 external calls (matches!).


##### `xargs_is_mutating_subcommand`  (lines 2055–2065)

```
fn xargs_is_mutating_subcommand(tokens: &[String]) -> bool
```

**Purpose**: Checks whether an `xargs` subcommand is a known in-place editing pattern. It focuses on common tools like Perl, Ruby, sed, and ripgrep replacement.

**Data flow**: It receives subcommand tokens → looks at the command name and its flags → returns true for known mutation patterns such as in-place edit flags or `rg --replace`.

**Call relations**: This is used through `is_mutating_xargs_command` to keep dangerous-looking pipelines from being treated as formatting-only.

*Call graph*: calls 1 internal fn (xargs_has_in_place_flag).


##### `xargs_has_in_place_flag`  (lines 2067–2071)

```
fn xargs_has_in_place_flag(tokens: &[String]) -> bool
```

**Purpose**: Detects in-place edit flags in command arguments. These flags mean the command may change files instead of only printing output.

**Data flow**: It receives argument tokens → scans for `-i`, `-pi`, or combined forms starting with those prefixes → returns true if found.

**Call relations**: `xargs_is_mutating_subcommand` uses this for Perl, Ruby, and sed subcommands.

*Call graph*: called by 1 (xargs_is_mutating_subcommand).


##### `drop_small_formatting_commands`  (lines 2073–2076)

```
fn drop_small_formatting_commands(mut commands: Vec<Vec<String>>) -> Vec<Vec<String>>
```

**Purpose**: Removes pipeline helper commands from a list of command token groups. This leaves the parser focused on the command that produced the meaningful data.

**Data flow**: It receives a list of command token lists → keeps only those that are not classified as small formatting helpers → returns the filtered list.

**Call relations**: `parse_shell_script` calls this after extracting commands from a shell script.

*Call graph*: called by 1 (parse_shell_script).


##### `summarize_main_tokens`  (lines 2078–2503)

```
fn summarize_main_tokens(main_cmd: &[String]) -> ParsedCommand
```

**Purpose**: Turns one command, already separated from surrounding shell syntax, into a `ParsedCommand` summary. This is where most command-specific knowledge lives.

**Data flow**: It receives tokens for one command → matches the program name against known tools → extracts query, path, or file information while skipping flags → returns `Search`, `ListFiles`, `Read`, or `Unknown`.

**Call relations**: `parse_command_impl` and `parse_shell_script` call this for each command segment. It delegates specialized parsing to helpers such as `parse_grep_like`, `parse_fd_query_and_path`, `parse_find_query_and_path`, `sed_read_path`, and `awk_data_file_operand`.

*Call graph*: calls 13 internal fn (awk_data_file_operand, first_non_flag_operand, is_python_command, parse_fd_query_and_path, parse_find_query_and_path, parse_grep_like, python_walks_files, sed_read_path, shlex_join, short_display_path (+3 more)); called by 2 (parse_command_impl, parse_shell_script); 3 external calls (from, new, matches!).


##### `is_abs_like`  (lines 2505–2518)

```
fn is_abs_like(path: &str) -> bool
```

**Purpose**: Checks whether a path is absolute, including Unix, Windows drive-letter, and Windows network-share styles. Absolute paths should not be joined onto a current directory.

**Data flow**: It receives a path string → asks the standard path library and also checks Windows-specific text patterns → returns true if the path is absolute-like.

**Call relations**: `join_paths` calls this before deciding whether to combine a base directory with a relative path.

*Call graph*: called by 1 (join_paths); 1 external calls (new).


##### `join_paths`  (lines 2520–2530)

```
fn join_paths(base: &str, rel: &str) -> String
```

**Purpose**: Combines a tracked current directory with a relative file path. It leaves absolute paths alone.

**Data flow**: It receives a base path and a second path → if the second path is absolute-like, returns it unchanged → otherwise pushes it onto the base path and returns the combined string.

**Call relations**: `parse_command_impl` and `parse_shell_script` use this after seeing `cd` commands so later read summaries point to the effective file path.

*Call graph*: calls 1 internal fn (is_abs_like); called by 2 (parse_command_impl, parse_shell_script); 1 external calls (from).


### Command safety classification
These files organize and implement cross-platform safe and dangerous command detection, including the PowerShell AST helper used on Windows.

### `shell-command/src/command_safety/mod.rs`

`orchestration` · `cross-cutting`

This file does not contain the safety checks itself. Instead, it organizes the command-safety toolbox so the rest of the project can use it through one clear place. Think of it like the index page of a handbook: it points to the chapters that know how to spot dangerous commands, how to recognize safe ones, and how to understand PowerShell commands.

It declares a private PowerShell parser module, then makes two public modules available: one for detecting dangerous commands and one for checking safe commands. On Windows only, it also includes a Windows-specific list or set of rules for commands considered safe. That conditional loading matters because command behavior can be different across operating systems.

The file also re-exports `try_parse_powershell_ast_commands` for use inside this crate. In plain terms, that gives nearby code a shared way to ask, “Can we break this PowerShell text into understandable command pieces?” Without this module, other parts of the system would have to know the internal file layout and platform details themselves, making command safety harder to use and easier to misuse.


### `shell-command/src/command_safety/powershell_parser.rs`

`io_transport` · `during command safety checks, whenever a PowerShell script needs parsing`

PowerShell has its own syntax rules, and guessing those rules in Rust would be risky. This file solves that by launching PowerShell itself with a bundled helper script, then sending scripts to that helper and reading back a simple answer: either a list of commands and arguments, “unsupported,” or “failed.” This matters for command safety because the rest of the system needs to know what a PowerShell command will actually run before deciding whether it is safe.

The file works like a clerk at a translation desk. Rust writes a request as one line of JSON to the helper process’s standard input, and the helper writes one JSON response line to standard output. Each request gets an id number, so Rust can tell if the answer belongs to the question it just asked. Scripts are encoded as PowerShell expects: UTF-16 little-endian bytes, then Base64 text.

To avoid slow repeated startups, the file caches one long-lived parser process per PowerShell executable path, such as powershell.exe or pwsh.exe. A mutex, which is a lock that lets only one caller use the shared cache at a time, protects these processes. If a cached process dies or its communication breaks, the code drops it and retries once with a fresh process. When a parser process is no longer needed, it is killed and waited on so it does not linger.

#### Function details

##### `parse_with_powershell_ast`  (lines 27–35)

```
fn parse_with_powershell_ast(executable: &str, script: &str) -> PowershellParseOutcome
```

**Purpose**: Asks a cached PowerShell parser process to parse a script using PowerShell’s own abstract syntax tree, which is PowerShell’s structured view of the script. This is the main shared entry point for getting a trustworthy parse result.

**Data flow**: It receives the PowerShell executable path and the script text. It opens the global cache of parser processes, protected by a lock, then passes that cache plus the request details to parse_with_cached_process. It returns a PowershellParseOutcome: parsed commands, unsupported syntax, or failure.

**Call relations**: This is called by try_parse_powershell_ast_commands when callers only want command lists, and by parse_powershell_script in the wider command safety flow. It delegates the real cache lookup, process startup, retry, and parsing work to parse_with_cached_process.

*Call graph*: calls 1 internal fn (parse_with_cached_process); called by 2 (try_parse_powershell_ast_commands, parse_powershell_script); 1 external calls (new).


##### `try_parse_powershell_ast_commands`  (lines 37–45)

```
fn try_parse_powershell_ast_commands(
    executable: &str,
    script: &str,
) -> Option<Vec<Vec<String>>>
```

**Purpose**: Provides a simpler interface for callers that only care about successfully extracted commands. It hides the difference between unsupported PowerShell syntax and parser failure by returning no result for either case.

**Data flow**: It receives an executable path and script text, then calls parse_with_powershell_ast. If the outcome contains commands, it returns them wrapped in Some. If the outcome is unsupported or failed, it returns None.

**Call relations**: This function is a convenience wrapper around parse_with_powershell_ast. It is useful for code that can fall back to another approach when the PowerShell parser cannot provide a clean command list.

*Call graph*: calls 1 internal fn (parse_with_powershell_ast).


##### `parse_with_cached_process`  (lines 54–89)

```
fn parse_with_cached_process(
    parser_processes: &mut HashMap<String, PowershellParserProcess>,
    executable: &str,
    script: &str,
) -> PowershellParseOutcome
```

**Purpose**: Finds or starts the right long-lived PowerShell parser process, sends the script to it, and retries once if the cached process appears broken. This keeps parsing fast without trusting a stale child process forever.

**Data flow**: It receives the mutable process cache, the PowerShell executable path, and script text. It uses the executable path as the cache key, starts a new PowershellParserProcess if needed, and asks that process to parse the script. If the first attempt fails because the process is unusable, it removes the cached process and tries once more. It returns commands, unsupported, or failed.

**Call relations**: parse_with_powershell_ast calls this after locking the shared cache. When a parser process is missing, this function calls PowershellParserProcess::spawn. Once it has a process, it hands the script to that process’s parse method.

*Call graph*: calls 1 internal fn (spawn); called by 1 (parse_with_powershell_ast).


##### `encode_powershell_base64`  (lines 91–97)

```
fn encode_powershell_base64(script: &str) -> String
```

**Purpose**: Converts text into the Base64 format PowerShell expects for encoded commands and payloads. PowerShell’s encoded-command mode uses UTF-16 little-endian text, not ordinary UTF-8.

**Data flow**: It receives a Rust string. It turns each character into UTF-16 units, stores those units as little-endian bytes, and Base64-encodes the bytes. It returns the encoded string.

**Call relations**: PowershellParserProcess::parse uses this to encode each script being checked before sending it to the helper process. encoded_parser_script also uses the same conversion indirectly to prepare the bundled parser script.

*Call graph*: called by 1 (parse); 1 external calls (with_capacity).


##### `encoded_parser_script`  (lines 99–103)

```
fn encoded_parser_script() -> &'static str
```

**Purpose**: Provides the bundled PowerShell helper script in the encoded form needed to start PowerShell with -EncodedCommand. It computes this once and reuses it.

**Data flow**: It reads the built-in powershell_parser.ps1 source text. On first use, it Base64-encodes that script in PowerShell’s expected format and stores it. Later calls return a reference to the same encoded string.

**Call relations**: PowershellParserProcess::spawn calls this when launching the helper process. This keeps startup arguments ready without re-encoding the helper script for every new child process.

*Call graph*: called by 1 (spawn); 1 external calls (new).


##### `PowershellParserProcess::spawn`  (lines 115–148)

```
fn spawn(executable: &str) -> std::io::Result<Self>
```

**Purpose**: Starts a new PowerShell child process running the bundled parser helper script. It prepares the pipes that Rust will use to send parse requests and read responses.

**Data flow**: It receives a PowerShell executable path. It starts that executable with flags that disable profiles and interactive behavior, passes the encoded helper script, opens standard input and output as pipes, and discards standard error. If either pipe cannot be captured, it kills the child and returns an error. On success, it returns a PowershellParserProcess with request id tracking set to zero.

**Call relations**: parse_with_cached_process calls this when there is no usable cached process. The Windows tests also call it directly to verify the helper can answer multiple requests and reject unsupported syntax. It relies on encoded_parser_script, take_child_stdin, take_child_stdout, and kill_child.

*Call graph*: calls 4 internal fn (encoded_parser_script, kill_child, take_child_stdin, take_child_stdout); called by 3 (parse_with_cached_process, parser_process_handles_multiple_requests, parser_process_rejects_stop_parsing_forms); 3 external calls (null, piped, new).


##### `PowershellParserProcess::parse`  (lines 150–184)

```
fn parse(&mut self, script: &str) -> std::io::Result<PowershellParseOutcome>
```

**Purpose**: Sends one script to an already-running parser process and reads one answer back. It is the core request-and-response conversation with the PowerShell helper.

**Data flow**: It receives script text and uses the process’s next request id. It Base64-encodes the script, wraps the id and payload in JSON, writes that JSON line to the child process, then reads one response line. It parses the response JSON, checks that the response id matches the request id, and converts the response into a PowershellParseOutcome. It also advances the next request id.

**Call relations**: parse_with_cached_process calls this after finding or creating a parser process. Inside, it uses encode_powershell_base64, serialize_request, deserialize_response, and the process’s stdin/stdout streams. If it detects broken output, end-of-file, or mismatched ids, the caller can discard the cached process.

*Call graph*: calls 3 internal fn (deserialize_response, encode_powershell_base64, serialize_request); 6 external calls (read_line, flush, write_all, new, new, format!).


##### `PowershellParserProcess::drop`  (lines 188–190)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the external PowerShell process when the Rust wrapper is destroyed. This prevents helper processes from being left running in the background.

**Data flow**: It receives the parser process being dropped. It calls kill_child on the stored child process. Nothing is returned; the side effect is process cleanup.

**Call relations**: Rust calls this automatically when a PowershellParserProcess leaves the cache or is otherwise dropped. It hands the actual kill-and-wait work to kill_child.

*Call graph*: calls 1 internal fn (kill_child).


##### `take_child_stdin`  (lines 193–200)

```
fn take_child_stdin(child: &mut Child) -> std::io::Result<ChildStdin>
```

**Purpose**: Takes ownership of the child process’s input pipe so Rust can write parser requests to it. If the pipe is missing, it turns that into a clear input/output error.

**Data flow**: It receives a mutable child process. It removes the child’s stdin handle from the child structure and returns it. If there is no stdin pipe, it returns a BrokenPipe error explaining that the parser child did not expose stdin.

**Call relations**: PowershellParserProcess::spawn calls this immediately after launching PowerShell. If this fails, spawn kills the child because the parser process would be unusable without an input pipe.

*Call graph*: called by 1 (spawn).


##### `take_child_stdout`  (lines 202–209)

```
fn take_child_stdout(child: &mut Child) -> std::io::Result<BufReader<ChildStdout>>
```

**Purpose**: Takes ownership of the child process’s output pipe and wraps it in a buffered reader, which makes reading one response line at a time efficient and simple.

**Data flow**: It receives a mutable child process. It removes the child’s stdout handle, wraps it in BufReader, and returns it. If stdout is missing, it returns a BrokenPipe error explaining the problem.

**Call relations**: PowershellParserProcess::spawn calls this after taking stdin. If this fails, spawn kills the child because Rust would have no way to read parser responses.

*Call graph*: called by 1 (spawn).


##### `serialize_request`  (lines 211–218)

```
fn serialize_request(request: &PowershellParserRequest) -> std::io::Result<String>
```

**Purpose**: Turns a parser request into JSON text so it can be sent over the child process pipe. JSON is used here as a simple, line-based message format.

**Data flow**: It receives a PowershellParserRequest containing an id and encoded script payload. It asks serde_json to convert it to a string. On success it returns the JSON text; on failure it returns an input/output error with context.

**Call relations**: PowershellParserProcess::parse calls this before writing to the PowerShell helper. The resulting text is followed by a newline so the helper can read one complete request.

*Call graph*: called by 1 (parse); 1 external calls (to_string).


##### `deserialize_response`  (lines 220–227)

```
fn deserialize_response(response_line: &str) -> std::io::Result<PowershellParserResponse>
```

**Purpose**: Turns one JSON response line from the PowerShell helper back into a Rust response structure. This is how the file checks what the helper said.

**Data flow**: It receives a line of response text. It asks serde_json to parse it into a PowershellParserResponse. On success it returns the structured response; on failure it returns an input/output error that includes the parse problem.

**Call relations**: PowershellParserProcess::parse calls this after reading from the child process. The parsed response is then checked for the right request id and converted into a higher-level outcome.

*Call graph*: called by 1 (parse); 1 external calls (from_str).


##### `PowershellParserResponse::into_outcome`  (lines 244–259)

```
fn into_outcome(self) -> PowershellParseOutcome
```

**Purpose**: Converts the raw helper response into the result type used by the rest of this Rust code. It also rejects suspicious or empty command data instead of treating it as a valid parse.

**Data flow**: It consumes a response containing a status string and optional command lists. If the status is ok, it accepts the commands only when there is at least one command, every command has at least one word, and no word is empty. Valid commands become PowershellParseOutcome::Commands. Empty or malformed command data becomes Unsupported. A status of unsupported becomes Unsupported, and any other status becomes Failed.

**Call relations**: PowershellParserProcess::parse calls this after confirming the response id matches the request. This function is the final gate between the helper process’s raw message and the safer outcome used by callers.


##### `kill_child`  (lines 262–265)

```
fn kill_child(child: &mut Child)
```

**Purpose**: Stops a PowerShell helper process and waits for it to finish. Waiting matters because it lets the operating system fully clean up the child process.

**Data flow**: It receives a mutable child process handle. It asks the operating system to kill the process, then waits for it to exit. It ignores errors because cleanup should not cause a new failure path while already recovering or dropping.

**Call relations**: PowershellParserProcess::drop calls this during normal cleanup. PowershellParserProcess::spawn also calls it if startup only partially succeeds and the new child cannot be used.

*Call graph*: called by 2 (drop, spawn); 2 external calls (kill, wait).


##### `tests::parser_process_handles_multiple_requests`  (lines 274–298)

```
fn parser_process_handles_multiple_requests()
```

**Purpose**: Checks that one parser process can answer more than one request in a row. This protects the caching behavior, because caching only works if the long-lived helper keeps speaking the protocol correctly.

**Data flow**: The test looks for an installed PowerShell executable. If none is found, it exits quietly. Otherwise it starts a parser process, sends one script, checks the parsed command result, sends a second script through the same process, and checks that result too.

**Call relations**: This Windows-only test calls PowershellParserProcess::spawn directly and uses the process’s parse method through the parser value. It supports the design used by parse_with_cached_process, where one child process is reused for repeated safety checks.

*Call graph*: calls 2 internal fn (spawn, try_find_powershell_executable_blocking); 1 external calls (assert_eq!).


##### `tests::parser_process_rejects_stop_parsing_forms`  (lines 301–312)

```
fn parser_process_rejects_stop_parsing_forms()
```

**Purpose**: Checks that the parser reports PowerShell stop-parsing syntax as unsupported. Stop-parsing syntax can change how later text is interpreted, so treating it as a normal command list would be unsafe.

**Data flow**: The test looks for an installed PowerShell executable. If none is found, it exits quietly. Otherwise it starts a parser process, sends a script using the stop-parsing marker, and verifies that the outcome is Unsupported.

**Call relations**: This Windows-only test calls PowershellParserProcess::spawn and then parses a specific risky form. It confirms that the helper response is converted into the conservative outcome expected by the safety-checking flow.

*Call graph*: calls 2 internal fn (spawn, try_find_powershell_executable_blocking); 1 external calls (assert_eq!).


### `shell-command/src/command_safety/windows_dangerous_commands.rs`

`domain_logic` · `command safety check before execution`

Windows has several ways to run something indirectly. A command might call PowerShell, CMD, Explorer, rundll32, mshta, or a browser, and those tools can then open a web page or delete files. This file is a safety filter for that situation. It is like a gatekeeper checking a package label before letting it into the building: it does not fully understand every possible script, but it looks for clear warning signs.

The main entry point first checks whether the command is a PowerShell command. If so, it tries to turn the script text into simple words and looks for dangerous patterns, such as Start-Process with an http or https URL, ShellExecute-style calls, browser launches, or Remove-Item with -Force. Next it checks CMD commands. It looks past CMD options such as /c, splits command chains like "echo hi & del /f file", and flags URL launches or forceful deletion commands. Finally, it checks direct launches of GUI tools, such as msedge.exe or explorer.exe with a URL.

The code is deliberately "best effort." It is not a complete PowerShell or CMD interpreter. Instead, it catches common high-risk forms while avoiding obvious false alarms, such as Explorer opening a local folder or a path that merely contains the letter f.

#### Function details

##### `is_dangerous_command_windows`  (lines 8–21)

```
fn is_dangerous_command_windows(command: &[String]) -> bool
```

**Purpose**: This is the main Windows safety question: given a command as a list of words, should it be treated as dangerous? It checks PowerShell, CMD, and direct Windows GUI launches in that order.

**Data flow**: It receives the full command list, starting with the program name. It asks the PowerShell checker first, then the CMD checker, then the direct-launch checker. It returns true as soon as one checker finds danger, otherwise it returns false.

**Call relations**: The broader command safety layer calls this through command_might_be_dangerous when it needs a Windows-specific answer. This function then delegates to is_dangerous_powershell, is_dangerous_cmd, and is_direct_gui_launch so each Windows command style can be inspected in its own way.

*Call graph*: calls 3 internal fn (is_dangerous_cmd, is_dangerous_powershell, is_direct_gui_launch); called by 1 (command_might_be_dangerous).


##### `is_dangerous_powershell`  (lines 23–38)

```
fn is_dangerous_powershell(command: &[String]) -> bool
```

**Purpose**: This function checks whether a command is a PowerShell or pwsh invocation that contains risky behavior. It filters out non-PowerShell commands before doing any script-specific inspection.

**Data flow**: It receives the command list, separates the executable name from the rest, and checks whether the executable is PowerShell. If it is, it parses the PowerShell arguments into a flat list of script words, then asks the word-level checker whether those words are dangerous. It returns a yes/no answer.

**Call relations**: is_dangerous_command_windows calls this first because PowerShell can hide risky actions inside one script string. It uses is_powershell_executable to confirm the program, parse_powershell_invocation to extract script words, and is_dangerous_powershell_words to inspect those words.

*Call graph*: calls 3 internal fn (is_dangerous_powershell_words, is_powershell_executable, parse_powershell_invocation); called by 1 (is_dangerous_command_windows).


##### `is_dangerous_powershell_words`  (lines 40–90)

```
fn is_dangerous_powershell_words(words: &[String]) -> bool
```

**Purpose**: This function inspects already-parsed PowerShell words for warning signs. It looks for URL-opening commands, ShellExecute-style calls, browser launches, Explorer URL launches, mshta URL launches, and forceful delete operations.

**Data flow**: It receives a list of words from a PowerShell script. It lowercases and unquotes them for easier comparison, checks whether any word looks like an http or https URL, then searches for risky command names or delete-plus-force combinations. It returns true if it finds one of those patterns.

**Call relations**: is_dangerous_powershell hands parsed script tokens to this function. It relies on args_have_url to detect web links, is_browser_executable to recognize common browsers, and has_force_delete_cmdlet to catch destructive PowerShell deletion patterns.

*Call graph*: calls 3 internal fn (args_have_url, has_force_delete_cmdlet, is_browser_executable); called by 2 (is_dangerous_powershell_words, is_dangerous_powershell); 1 external calls (matches!).


##### `is_dangerous_cmd`  (lines 92–157)

```
fn is_dangerous_cmd(command: &[String]) -> bool
```

**Purpose**: This function checks commands run through Windows CMD, especially commands passed after /c or /r. It catches shell launches of URLs and forceful or recursive deletion commands.

**Data flow**: It receives the full command list, confirms the executable is cmd or cmd.exe, skips CMD startup switches until it reaches the command body, and breaks that body into simpler tokens. It then examines each command segment separated by &, &&, |, or ||. It returns true if a segment starts a URL, force-deletes a file, or removes a directory recursively and quietly.

**Call relations**: is_dangerous_command_windows calls this after the PowerShell check. It uses executable_basename to identify CMD and split_embedded_cmd_operators to notice chained commands even when operators are stuck to nearby text.

*Call graph*: calls 1 internal fn (executable_basename); called by 1 (is_dangerous_command_windows); 1 external calls (split).


##### `is_direct_gui_launch`  (lines 159–188)

```
fn is_direct_gui_launch(command: &[String]) -> bool
```

**Purpose**: This function catches direct use of Windows programs that can open web links without going through PowerShell or CMD. Examples include Explorer, mshta, rundll32 with url.dll, and common browsers.

**Data flow**: It receives the command list, extracts the executable name, and looks through the remaining arguments for an http or https URL. If the executable is one of the known URL-opening programs and a URL is present, it returns true. Otherwise it returns false.

**Call relations**: is_dangerous_command_windows calls this as the final fallback after structured PowerShell and CMD checks. It uses executable_basename, args_have_url, and is_browser_executable to make the decision.

*Call graph*: calls 3 internal fn (args_have_url, executable_basename, is_browser_executable); called by 1 (is_dangerous_command_windows); 1 external calls (matches!).


##### `split_embedded_cmd_operators`  (lines 190–223)

```
fn split_embedded_cmd_operators(token: &str) -> Vec<String>
```

**Purpose**: This helper separates CMD chaining symbols from neighboring text. That matters because CMD allows compact forms like "echo hi&del", where the dangerous command is hidden after an ampersand.

**Data flow**: It receives one token of text. It scans for &, &&, |, and ||, cuts the text around those operators, removes empty pieces, and returns a list of cleaner pieces. The returned list can then be examined command by command.

**Call relations**: The CMD checker uses this after basic command splitting, so chained commands can be noticed even when there are no spaces around the operator.

*Call graph*: 1 external calls (new).


##### `has_force_delete_cmdlet`  (lines 225–290)

```
fn has_force_delete_cmdlet(tokens: &[String]) -> bool
```

**Purpose**: This function looks for PowerShell delete commands used with the -Force option in the same command segment. That combination is risky because it can remove protected or read-only files more aggressively.

**Data flow**: It receives normalized PowerShell tokens. It divides them into rough command segments at hard separators like semicolons, pipes, ampersands, or newlines, then splits punctuation such as braces and commas inside each segment. For each segment, it checks whether a delete command and -Force appear together. It returns true only when both are found in the same segment.

**Call relations**: is_dangerous_powershell_words calls this after URL-related checks. It is what lets the PowerShell safety path catch commands like Remove-Item test -Force while avoiding a separate harmless -Force used with another command.

*Call graph*: called by 1 (is_dangerous_powershell_words); 3 external calls (new, new, vec!).


##### `has_force_flag_cmd`  (lines 293–295)

```
fn has_force_flag_cmd(args: &[String]) -> bool
```

**Purpose**: This helper checks whether a CMD command includes the exact /f force flag. It is used for del and erase commands, where /f means force deletion of read-only files.

**Data flow**: It receives the arguments in one CMD command segment. It scans them case-insensitively for /f and returns true if that exact flag is present. It does not treat ordinary paths containing the letter f as a match.

**Call relations**: The CMD danger check uses this when it has found a del or erase command. It supplies the small flag-specific answer needed to decide whether that segment should be blocked.


##### `has_recursive_flag_cmd`  (lines 298–300)

```
fn has_recursive_flag_cmd(args: &[String]) -> bool
```

**Purpose**: This helper checks whether a CMD directory-removal command includes /s, the recursive flag. Recursive removal is risky because it can delete a whole folder tree.

**Data flow**: It receives the arguments in one CMD command segment. It scans them case-insensitively for the exact /s flag and returns true if it is present.

**Call relations**: The CMD danger check uses this for rd and rmdir segments. It is combined with has_quiet_flag_cmd so the code only flags the especially dangerous recursive-and-quiet form.


##### `has_quiet_flag_cmd`  (lines 303–305)

```
fn has_quiet_flag_cmd(args: &[String]) -> bool
```

**Purpose**: This helper checks whether a CMD directory-removal command includes /q, the quiet flag. Quiet mode is risky because it suppresses confirmation prompts.

**Data flow**: It receives the arguments in one CMD command segment. It scans them case-insensitively for the exact /q flag and returns true if it is present.

**Call relations**: The CMD danger check uses this together with has_recursive_flag_cmd for rd and rmdir. Together they identify commands such as rmdir /s /q, which can remove a directory tree without asking.


##### `args_have_url`  (lines 307–309)

```
fn args_have_url(args: &[String]) -> bool
```

**Purpose**: This helper answers a simple question: does any argument contain an http or https URL? Many dangerous Windows launch paths become risky only when a web link is involved.

**Data flow**: It receives a list of argument strings. It checks each one with looks_like_url and returns true as soon as one argument looks like a valid web URL. If none do, it returns false.

**Call relations**: PowerShell and direct GUI launch checks call this when deciding whether a launch command is web-facing. It centralizes URL detection so the same rules are used in multiple safety paths.

*Call graph*: called by 2 (is_dangerous_powershell_words, is_direct_gui_launch).


##### `looks_like_url`  (lines 311–334)

```
fn looks_like_url(token: &str) -> bool
```

**Purpose**: This function decides whether one piece of text is an http or https URL, even if it has common shell punctuation around it. It helps avoid missing URLs wrapped in quotes, parentheses, or a trailing semicolon.

**Data flow**: It receives one token. It trims common surrounding characters, or starts from the first embedded http:// or https:// substring if one appears inside a larger token. It then asks the URL parser whether the result is a valid URL and returns true only for http and https schemes.

**Call relations**: args_have_url uses this for each argument it scans. It provides the more careful URL recognition needed by the PowerShell and GUI launch checks.

*Call graph*: 3 external calls (new, parse, matches!).


##### `executable_basename`  (lines 336–341)

```
fn executable_basename(exe: &str) -> Option<String>
```

**Purpose**: This helper extracts just the program name from an executable path and lowercases it. That lets the safety checks treat C:\Windows\System32\cmd.exe and cmd.exe as the same program.

**Data flow**: It receives an executable path string. It asks the path library for the final file-name part, converts it to text if possible, lowercases it, and returns it. If the path has no usable file name, it returns none.

**Call relations**: is_dangerous_cmd and is_direct_gui_launch use this before comparing executable names. Other helpers also build on this pattern to recognize PowerShell and browser executables reliably.

*Call graph*: called by 2 (is_dangerous_cmd, is_direct_gui_launch); 1 external calls (new).


##### `is_powershell_executable`  (lines 343–348)

```
fn is_powershell_executable(exe: &str) -> bool
```

**Purpose**: This function recognizes Windows PowerShell and modern PowerShell executable names. It accepts both powershell and pwsh, with or without .exe.

**Data flow**: It receives an executable path or name. It extracts the lowercased basename and compares it with the known PowerShell names. It returns true for recognized PowerShell executables and false otherwise.

**Call relations**: is_dangerous_powershell calls this before trying to parse PowerShell-specific arguments. This prevents ordinary commands from being misread as scripts.

*Call graph*: called by 1 (is_dangerous_powershell); 1 external calls (matches!).


##### `is_browser_executable`  (lines 350–362)

```
fn is_browser_executable(name: &str) -> bool
```

**Purpose**: This helper recognizes common browser executable names. A browser started with a URL is considered a direct web launch.

**Data flow**: It receives a lowercased executable name. It compares it with known browser names such as chrome, msedge, firefox, and iexplore, with or without .exe. It returns a boolean answer.

**Call relations**: is_dangerous_powershell_words uses it when a PowerShell script appears to directly invoke a browser. is_direct_gui_launch uses it when the original command itself starts a browser.

*Call graph*: called by 2 (is_dangerous_powershell_words, is_direct_gui_launch); 1 external calls (matches!).


##### `parse_powershell_invocation`  (lines 368–408)

```
fn parse_powershell_invocation(args: &[String]) -> Option<ParsedPowershell>
```

**Purpose**: This function extracts the script words from a PowerShell command line. It supports explicit forms like -Command "..." as well as a plain remaining command.

**Data flow**: It receives the arguments after the PowerShell executable. It skips common PowerShell startup options, looks for -Command, /Command, -c, or command text attached after a colon, and splits the script string into shell-like tokens. If it cannot parse safely or sees extra unexpected arguments after a command string, it returns none.

**Call relations**: is_dangerous_powershell calls this after confirming the executable is PowerShell. Its output is handed to is_dangerous_powershell_words for the actual safety decision.

*Call graph*: called by 1 (is_dangerous_powershell); 1 external calls (split).


##### `tests::vec_str`  (lines 414–416)

```
fn vec_str(items: &[&str]) -> Vec<String>
```

**Purpose**: This small test helper turns a list of string literals into owned String values. It keeps the tests short and readable.

**Data flow**: It receives a slice of text references. It copies each item into a String and returns a vector of those strings, matching the input shape expected by the safety checker.

**Call relations**: The test cases use this helper when building sample command lines. It is only active during tests.


##### `tests::powershell_start_process_url_is_dangerous`  (lines 419–426)

```
fn powershell_start_process_url_is_dangerous()
```

**Purpose**: This test proves that PowerShell Start-Process with a web URL is flagged as dangerous.

**Data flow**: It builds a PowerShell command containing Start-Process and https://example.com, passes it to the Windows danger checker, and expects the answer to be true.

**Call relations**: During the test run, this calls the public checker in the same way production code would. It protects the PowerShell URL-launch rule from being accidentally weakened.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_start_process_url_with_trailing_semicolon_is_dangerous`  (lines 429–435)

```
fn powershell_start_process_url_with_trailing_semicolon_is_dangerous()
```

**Purpose**: This test checks that a PowerShell URL launch is still caught when written like a function call and followed by a semicolon.

**Data flow**: It creates a PowerShell -Command string containing Start-Process('https://example.com'); and asserts that the safety checker returns true.

**Call relations**: It exercises the URL cleanup and PowerShell token scanning path. The test guards against missing URLs because of nearby punctuation.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_start_process_local_is_not_flagged`  (lines 438–444)

```
fn powershell_start_process_local_is_not_flagged()
```

**Purpose**: This test makes sure that starting a local program with PowerShell is not automatically treated as dangerous.

**Data flow**: It builds a command that runs Start-Process notepad.exe, sends it through the checker, and expects false because no URL or forceful deletion is present.

**Call relations**: It balances the URL-launch tests by checking a harmless-looking Start-Process case. This helps keep the filter from blocking ordinary local launches too broadly.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_with_url_is_dangerous`  (lines 447–454)

```
fn cmd_start_with_url_is_dangerous()
```

**Purpose**: This test verifies that CMD's start command with a web URL is considered dangerous.

**Data flow**: It builds cmd /c start https://example.com, runs the checker, and expects true.

**Call relations**: It exercises the CMD parsing path through the main Windows checker. It protects the rule for classic CMD-based URL launching.

*Call graph*: 1 external calls (assert!).


##### `tests::msedge_with_url_is_dangerous`  (lines 457–462)

```
fn msedge_with_url_is_dangerous()
```

**Purpose**: This test checks that directly starting Microsoft Edge with a URL is flagged.

**Data flow**: It creates a command whose executable is msedge.exe and whose argument is an https URL. It expects the danger checker to return true.

**Call relations**: It goes through the direct GUI launch path. The test confirms that browser launches do not need to be wrapped in PowerShell or CMD to be caught.

*Call graph*: 1 external calls (assert!).


##### `tests::explorer_with_directory_is_not_flagged`  (lines 465–470)

```
fn explorer_with_directory_is_not_flagged()
```

**Purpose**: This test confirms that Explorer opening a local directory is not treated like Explorer opening a web URL.

**Data flow**: It builds explorer.exe . and expects the checker to return false because the argument is a local path, not a web link.

**Call relations**: It exercises the direct GUI launch path and guards against an overbroad Explorer rule.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_is_dangerous`  (lines 475–481)

```
fn powershell_remove_item_force_is_dangerous()
```

**Purpose**: This test verifies that PowerShell Remove-Item with -Force is flagged as dangerous.

**Data flow**: It creates a PowerShell command that removes a test item with -Force, sends it to the checker, and expects true.

**Call relations**: It exercises the PowerShell force-delete detection path. The test protects the core destructive-command rule.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_recurse_force_is_dangerous`  (lines 484–490)

```
fn powershell_remove_item_recurse_force_is_dangerous()
```

**Purpose**: This test checks that Remove-Item with both -Recurse and -Force is dangerous.

**Data flow**: It builds a PowerShell command that removes an item recursively and forcefully, then asserts that the checker returns true.

**Call relations**: It confirms that adding -Recurse does not hide or interfere with detection of -Force on a delete command.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_ri_alias_force_is_dangerous`  (lines 493–499)

```
fn powershell_ri_alias_force_is_dangerous()
```

**Purpose**: This test verifies that the PowerShell alias ri is treated as a delete command when paired with -Force.

**Data flow**: It builds a pwsh command using ri test -Force and expects the checker to return true.

**Call relations**: It exercises both the pwsh executable recognition and alias detection inside the PowerShell delete checker.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_without_force_is_not_flagged`  (lines 502–508)

```
fn powershell_remove_item_without_force_is_not_flagged()
```

**Purpose**: This test ensures that Remove-Item without -Force is not flagged by this particular rule.

**Data flow**: It sends a PowerShell Remove-Item test command to the checker and expects false because the force flag is absent.

**Call relations**: It helps keep the force-delete rule precise. The test checks that the code looks for the risky combination, not just the delete command name.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_force_is_dangerous`  (lines 512–516)

```
fn cmd_del_force_is_dangerous()
```

**Purpose**: This test verifies that CMD del /f is flagged as dangerous.

**Data flow**: It builds cmd /c del /f test.txt, runs the checker, and expects true.

**Call relations**: It exercises the CMD command-body scanner and the exact /f flag check for file deletion.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_erase_force_is_dangerous`  (lines 519–523)

```
fn cmd_erase_force_is_dangerous()
```

**Purpose**: This test checks the erase command, which is another CMD name for deleting files, when used with /f.

**Data flow**: It builds cmd /c erase /f test.txt and expects the checker to return true.

**Call relations**: It confirms that the CMD delete rule covers both del and erase.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_without_force_is_not_flagged`  (lines 526–530)

```
fn cmd_del_without_force_is_not_flagged()
```

**Purpose**: This test makes sure a plain CMD del command is not flagged as a force delete.

**Data flow**: It builds cmd /c del test.txt and expects false because /f is missing.

**Call relations**: It guards against making the CMD delete rule too broad. The checker should require the force flag for this case.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rd_recursive_is_dangerous`  (lines 533–537)

```
fn cmd_rd_recursive_is_dangerous()
```

**Purpose**: This test verifies that CMD rd /s /q is flagged because it can remove a directory tree without asking.

**Data flow**: It creates cmd /c rd /s /q test, runs the checker, and expects true.

**Call relations**: It exercises the CMD directory-removal rule that combines recursive and quiet flags.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rd_without_quiet_is_not_flagged`  (lines 540–544)

```
fn cmd_rd_without_quiet_is_not_flagged()
```

**Purpose**: This test checks that rd /s without /q is not caught by the quiet recursive-removal rule.

**Data flow**: It builds cmd /c rd /s test and expects false because the quiet flag is absent.

**Call relations**: It keeps the directory-removal detection specific to the /s and /q combination.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rmdir_recursive_is_dangerous`  (lines 547–551)

```
fn cmd_rmdir_recursive_is_dangerous()
```

**Purpose**: This test verifies that rmdir /s /q is treated the same as rd /s /q.

**Data flow**: It creates cmd /c rmdir /s /q test and expects the checker to return true.

**Call relations**: It confirms that the CMD directory-removal rule covers both command spellings.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_path_recurse_force_is_dangerous`  (lines 555–561)

```
fn powershell_remove_item_path_recurse_force_is_dangerous()
```

**Purpose**: This test covers a full Remove-Item form using -Path, -Recurse, and -Force.

**Data flow**: It builds a PowerShell command with Remove-Item -Path 'test' -Recurse -Force and expects true.

**Call relations**: It protects a real-world scenario where the delete target is supplied with -Path. The PowerShell delete checker must still find the delete command and force flag in the same segment.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_with_semicolon_is_dangerous`  (lines 564–570)

```
fn powershell_remove_item_force_with_semicolon_is_dangerous()
```

**Purpose**: This test checks that a force delete before another PowerShell command is still caught.

**Data flow**: It builds Remove-Item test -Force; Write-Host done, sends it to the checker, and expects true.

**Call relations**: It exercises command-segment splitting in the PowerShell delete checker. The semicolon should separate commands without hiding the dangerous first segment.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_inside_block_is_dangerous`  (lines 573–579)

```
fn powershell_remove_item_force_inside_block_is_dangerous()
```

**Purpose**: This test verifies that a force delete inside a PowerShell block is detected.

**Data flow**: It builds if ($true) { Remove-Item test -Force} and expects the checker to return true.

**Call relations**: It checks the PowerShell token cleanup around braces. The delete checker must see through simple punctuation around command blocks.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_remove_item_force_inside_brackets_is_dangerous`  (lines 582–588)

```
fn powershell_remove_item_force_inside_brackets_is_dangerous()
```

**Purpose**: This test verifies that a force delete wrapped in brackets and parentheses is still detected.

**Data flow**: It builds [void]( Remove-Item test -Force)] and expects true.

**Call relations**: It exercises the soft-punctuation splitting used by the PowerShell delete checker, making sure brackets do not hide the command.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_path_containing_f_is_not_flagged`  (lines 591–598)

```
fn cmd_del_path_containing_f_is_not_flagged()
```

**Purpose**: This test ensures that a file path containing the letter f is not mistaken for the /f force flag.

**Data flow**: It builds cmd /c del C:/foo/bar.txt and expects false because there is no exact /f argument.

**Call relations**: It protects the exact-flag behavior used by the CMD force-delete check.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_rd_path_containing_s_is_not_flagged`  (lines 601–608)

```
fn cmd_rd_path_containing_s_is_not_flagged()
```

**Purpose**: This test ensures that a directory path containing the letter s is not mistaken for the /s recursive flag.

**Data flow**: It builds cmd /c rd C:/source and expects false because there is no exact /s argument.

**Call relations**: It guards against false positives in the CMD recursive-removal flag check.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_bypass_chained_del_is_dangerous`  (lines 611–615)

```
fn cmd_bypass_chained_del_is_dangerous()
```

**Purpose**: This test verifies that a dangerous CMD command after an ampersand is still caught.

**Data flow**: It builds cmd /c echo hello & del /f file.txt and expects true.

**Call relations**: It exercises the CMD segment scanning for chained commands. The checker must not stop after the harmless echo command.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_chained_no_space_is_dangerous`  (lines 618–624)

```
fn powershell_chained_no_space_is_dangerous()
```

**Purpose**: This test checks that PowerShell catches a force delete after a semicolon even when there is no space after the semicolon.

**Data flow**: It builds Write-Host hi;Remove-Item -Force C:\tmp and expects the checker to return true.

**Call relations**: It protects the PowerShell segment-splitting logic for compact command chains.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_comma_separated_is_dangerous`  (lines 627–633)

```
fn powershell_comma_separated_is_dangerous()
```

**Purpose**: This test verifies that comma-separated PowerShell tokens can still reveal a delete command and -Force.

**Data flow**: It builds del,-Force,C:\foo and expects true.

**Call relations**: It exercises the soft-punctuation splitting inside the PowerShell delete checker, especially comma handling.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_echo_del_is_not_dangerous`  (lines 636–640)

```
fn cmd_echo_del_is_not_dangerous()
```

**Purpose**: This test ensures that echoing the words del /f is not treated as actually running del /f.

**Data flow**: It builds cmd /c echo del /f and expects false.

**Call relations**: It checks that the CMD scanner pays attention to command segments and their first word, rather than flagging any appearance of the text del and /f.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_single_string_argument_is_dangerous`  (lines 643–649)

```
fn cmd_del_single_string_argument_is_dangerous()
```

**Purpose**: This test checks that CMD commands passed as one string are still parsed well enough to catch del /f.

**Data flow**: It builds cmd /c "del /f file.txt" as a single command-body argument and expects true.

**Call relations**: It exercises the shell-like splitting used when CMD receives the whole body as one string.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_chained_single_string_argument_is_dangerous`  (lines 652–658)

```
fn cmd_del_chained_single_string_argument_is_dangerous()
```

**Purpose**: This test verifies that a chained dangerous CMD command inside one command string is caught.

**Data flow**: It builds cmd /c "echo hello & del /f file.txt" and expects true.

**Call relations**: It combines single-string parsing with command-chain scanning in the CMD checker.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_no_space_del_is_dangerous`  (lines 661–667)

```
fn cmd_chained_no_space_del_is_dangerous()
```

**Purpose**: This test checks the compact CMD form where an ampersand is stuck directly to nearby text.

**Data flow**: It builds cmd /c "echo hi&del /f file.txt" and expects true.

**Call relations**: It specifically protects split_embedded_cmd_operators, which separates operators even without surrounding spaces.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_andand_no_space_del_is_dangerous`  (lines 670–676)

```
fn cmd_chained_andand_no_space_del_is_dangerous()
```

**Purpose**: This test verifies that the compact && chain operator does not hide a force delete.

**Data flow**: It builds cmd /c "echo hi&&del /f file.txt" and expects the checker to return true.

**Call relations**: It exercises operator splitting for && inside the CMD checker.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_oror_no_space_del_is_dangerous`  (lines 679–685)

```
fn cmd_chained_oror_no_space_del_is_dangerous()
```

**Purpose**: This test verifies that the compact || chain operator does not hide a force delete.

**Data flow**: It builds cmd /c "echo hi||del /f file.txt" and expects true.

**Call relations**: It exercises operator splitting for || inside the CMD checker.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_url_single_string_is_dangerous`  (lines 688–694)

```
fn cmd_start_url_single_string_is_dangerous()
```

**Purpose**: This test checks that CMD start with a URL is caught even when the command body is one string.

**Data flow**: It builds cmd /c "start https://example.com" and expects true.

**Call relations**: It covers the combination of CMD single-string parsing and URL-launch detection.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_chained_no_space_rmdir_is_dangerous`  (lines 697–703)

```
fn cmd_chained_no_space_rmdir_is_dangerous()
```

**Purpose**: This test verifies that compact CMD chaining cannot hide rmdir /s /q.

**Data flow**: It builds cmd /c "echo hi&rmdir /s /q testdir" and expects the checker to return true.

**Call relations**: It exercises both embedded-operator splitting and the recursive quiet directory-removal rule.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_del_force_uppercase_flag_is_dangerous`  (lines 706–710)

```
fn cmd_del_force_uppercase_flag_is_dangerous()
```

**Purpose**: This test confirms that CMD command and flag matching is case-insensitive.

**Data flow**: It builds cmd /c DEL /F file.txt and expects true.

**Call relations**: It protects the case-insensitive comparisons used by the CMD force-delete checker.

*Call graph*: 1 external calls (assert!).


##### `tests::cmdexe_r_del_force_is_dangerous`  (lines 713–717)

```
fn cmdexe_r_del_force_is_dangerous()
```

**Purpose**: This test verifies that cmd.exe with /r is treated like a command-running CMD invocation.

**Data flow**: It builds cmd.exe /r del /f file.txt and expects the checker to return true.

**Call relations**: It exercises CMD executable-name recognition and support for /r as a command-body marker.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_quoted_url_single_string_is_dangerous`  (lines 720–726)

```
fn cmd_start_quoted_url_single_string_is_dangerous()
```

**Purpose**: This test checks that a quoted URL after CMD start is still detected.

**Data flow**: It builds cmd /c "start \"https://example.com\"" and expects true.

**Call relations**: It protects URL detection after shell-like splitting and quote handling.

*Call graph*: 1 external calls (assert!).


##### `tests::cmd_start_title_then_url_is_dangerous`  (lines 729–735)

```
fn cmd_start_title_then_url_is_dangerous()
```

**Purpose**: This test covers CMD start's common empty-title form before a URL.

**Data flow**: It builds cmd /c "start \"\" https://example.com" and expects true.

**Call relations**: It ensures that the URL detection scans the whole start segment, not just the first argument after start.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_rm_alias_force_is_dangerous`  (lines 738–744)

```
fn powershell_rm_alias_force_is_dangerous()
```

**Purpose**: This test verifies that the PowerShell alias rm is treated as a delete command when used with -Force.

**Data flow**: It builds powershell -Command "rm test -Force" and expects the checker to return true.

**Call relations**: It protects alias coverage in the PowerShell force-delete detector.

*Call graph*: 1 external calls (assert!).


##### `tests::powershell_benign_force_separate_command_is_not_dangerous`  (lines 747–753)

```
fn powershell_benign_force_separate_command_is_not_dangerous()
```

**Purpose**: This test ensures that -Force on one PowerShell command does not make a later delete command look forceful.

**Data flow**: It builds Get-ChildItem -Force; Remove-Item test and expects false because -Force and Remove-Item are in different command segments.

**Call relations**: It guards the segment-aware behavior of has_force_delete_cmdlet. The checker should only flag delete and -Force when they belong to the same command segment.

*Call graph*: 1 external calls (assert!).


### `shell-command/src/command_safety/is_dangerous_command.rs`

`domain_logic` · `command review before execution`

This file helps the system avoid running commands that could cause obvious damage. Its job is not to understand every possible shell trick. Instead, it catches a small set of high-risk cases before they reach the point where the program would execute them. Think of it like a warning label scanner: it does not inspect the whole factory, but it notices labels that say “explosive.”

The main entry point, `command_might_be_dangerous`, receives an already-split command, such as `["rm", "-rf", "/"]`. On Windows, it first asks a Windows-specific checker about dangerous commands. Then it checks Unix-style cases in this file, especially `rm -f` and `rm -rf`. It also understands a common wrapper form: `bash -lc "some script"`. In that case, it asks the shell parser to break the inner script into plain commands, then checks each one.

The file also contains helpers for recognizing Git subcommands safely. Git allows global options before the real subcommand, such as `git -C repo status`, so the helper skips those correctly. This matters because safety checks elsewhere must not be fooled by options placed before the actual Git action.

Tests at the bottom confirm that forceful remove commands are marked dangerous and that PowerShell danger checks behave differently on Windows and non-Windows systems.

#### Function details

##### `command_might_be_dangerous`  (lines 7–29)

```
fn command_might_be_dangerous(command: &[String]) -> bool
```

**Purpose**: Decides whether a command should be treated as potentially dangerous before the system runs it. It catches direct dangerous commands and also dangerous commands hidden inside a simple `bash -lc` script.

**Data flow**: It receives a list of command words, such as the executable name followed by its arguments. On Windows it first passes the words to the Windows danger checker. Then it checks the command directly with `is_dangerous_to_call_with_exec`. If the command is a supported `bash -lc` form, it parses the inner script into separate commands and checks each one. It returns `true` if any check finds danger, otherwise `false`.

**Call relations**: This function is called by `render_decision_for_unmatched_command` when the system is deciding what to do with a command it does not already recognize as safe. It delegates the detailed checks to the Windows-specific checker when available, to `is_dangerous_to_call_with_exec` for simple direct commands, and to `parse_shell_lc_plain_commands` when a Bash wrapper may be hiding the real command.

*Call graph*: calls 3 internal fn (parse_shell_lc_plain_commands, is_dangerous_to_call_with_exec, is_dangerous_command_windows); called by 1 (render_decision_for_unmatched_command).


##### `is_dangerous_powershell_words`  (lines 33–44)

```
fn is_dangerous_powershell_words(command: &[String]) -> bool
```

**Purpose**: Checks whether already-split PowerShell words look dangerous, mainly for Windows command safety decisions. On non-Windows systems it always says they are not dangerous because the Windows-specific PowerShell rules are not active there.

**Data flow**: It receives PowerShell command words. On Windows, it forwards them to the Windows danger-detection code and returns that answer. On other operating systems, it ignores the words and returns `false`.

**Call relations**: This function is called by `render_decision_for_unmatched_command` when that broader decision code needs PowerShell-specific danger detection. It acts as a small platform bridge: real checking happens in the Windows module, while non-Windows builds get a harmless stub result.

*Call graph*: calls 1 internal fn (is_dangerous_powershell_words); called by 1 (render_decision_for_unmatched_command).


##### `is_git_global_option_with_value`  (lines 46–57)

```
fn is_git_global_option_with_value(arg: &str) -> bool
```

**Purpose**: Recognizes Git global options that take their value from the next word. This helps later code skip over options like `-C repo` so it can find the real Git subcommand.

**Data flow**: It receives one argument string from a Git command. It compares that string against a fixed set of Git options known to require a following value. It returns `true` when the argument is one of those options, otherwise `false`.

**Call relations**: This helper is used by `find_git_subcommand` while scanning through a Git command. When it returns `true`, the scanner knows to skip the next word because that next word is an option value, not the Git subcommand.

*Call graph*: called by 1 (find_git_subcommand); 1 external calls (matches!).


##### `is_git_global_option_with_inline_value`  (lines 59–69)

```
fn is_git_global_option_with_inline_value(arg: &str) -> bool
```

**Purpose**: Recognizes Git global options where the option and its value are written as one word, such as `--git-dir=/tmp/repo` or `-Crepo`. This prevents those option words from being mistaken for the Git subcommand.

**Data flow**: It receives one argument string. It checks whether the string starts with one of several Git option prefixes that include their value inline. It returns `true` for a match and `false` otherwise.

**Call relations**: This helper is called by `find_git_subcommand` during its scan. If it says an argument is an inline global option, the scanner skips that word and keeps looking for the first real non-option Git command.

*Call graph*: called by 1 (find_git_subcommand); 1 external calls (matches!).


##### `executable_name_lookup_key`  (lines 71–95)

```
fn executable_name_lookup_key(raw: &str) -> Option<String>
```

**Purpose**: Turns an executable path into the plain command name used for comparison. For example, it can reduce a path like `/usr/bin/git` to `git`.

**Data flow**: It receives a raw executable string, which may be just a name or a full path. It extracts the final path component. On Windows, it lowercases the name and removes common executable endings like `.exe`, `.cmd`, `.bat`, or `.com`; on other systems it keeps the file name as-is. It returns the cleaned-up name, or nothing if the name cannot be read as text.

**Call relations**: This helper is used by `find_git_subcommand` to decide whether the command really starts with Git. It is also used by `is_safe_to_call_with_exec` elsewhere, so both safety and danger-related code compare executable names in the same way.

*Call graph*: called by 2 (find_git_subcommand, is_safe_to_call_with_exec); 1 external calls (new).


##### `find_git_subcommand`  (lines 101–143)

```
fn find_git_subcommand(
    command: &'a [String],
    subcommands: &[&str],
) -> Option<(usize, &'a str)>
```

**Purpose**: Finds the actual Git subcommand, such as `status` or `clone`, even when Git-wide options appear before it. This avoids being fooled by commands like `git -C some/repo status`.

**Data flow**: It receives a full command word list and a list of Git subcommands to look for. First it checks that the executable name is `git`. Then it walks through the later words, skipping known global options and their values. When it reaches the first real non-option word, it returns its position and text if it is one of the requested subcommands. If the command is not Git, or the first real subcommand is not one of the requested names, it returns nothing.

**Call relations**: This function is called by `is_safe_git_command` in the safe-command side of the system. It relies on `executable_name_lookup_key` to recognize Git and on the two Git option helpers to skip over global options correctly before deciding what the user is actually asking Git to do.

*Call graph*: calls 3 internal fn (executable_name_lookup_key, is_git_global_option_with_inline_value, is_git_global_option_with_value); called by 1 (is_safe_git_command).


##### `is_dangerous_to_call_with_exec`  (lines 145–157)

```
fn is_dangerous_to_call_with_exec(command: &[String]) -> bool
```

**Purpose**: Checks a simple already-tokenized command for known dangerous direct execution patterns. At present, it flags forceful `rm` deletion and also looks through `sudo` to the command being run with elevated privileges.

**Data flow**: It receives command words. If the first word is `rm`, it looks at the next word and returns `true` for `-f` or `-rf`. If the first word is `sudo`, it repeats the same check on the rest of the command after `sudo`. For anything else, it returns `false`.

**Call relations**: This is the direct Unix-style danger checker used by `command_might_be_dangerous`. The outer function calls it on the original command and also on commands parsed out of a `bash -lc` script.

*Call graph*: called by 1 (command_might_be_dangerous); 1 external calls (matches!).


##### `tests::vec_str`  (lines 163–165)

```
fn vec_str(items: &[&str]) -> Vec<String>
```

**Purpose**: Builds test command inputs without making each test repeat string-conversion code. It is a small convenience helper for the tests in this file.

**Data flow**: It receives a list of string slices, which are lightweight references to text. It converts each one into an owned `String` and returns a vector of those strings, matching the input shape used by the real command-checking functions.

**Call relations**: The test functions call this helper when they need to pass sample commands to the safety checks. It keeps the tests focused on the command behavior rather than Rust string setup.


##### `tests::rm_rf_is_dangerous`  (lines 168–170)

```
fn rm_rf_is_dangerous()
```

**Purpose**: Verifies that `rm -rf /` is treated as dangerous. This protects the basic safety rule for recursive force deletion.

**Data flow**: It builds the sample command words for `rm -rf /`, passes them to `command_might_be_dangerous`, and asserts that the answer is `true`. The test changes no lasting state.

**Call relations**: This test exercises the public danger-checking path, which then reaches `is_dangerous_to_call_with_exec`. It confirms that callers such as `render_decision_for_unmatched_command` can rely on this obvious destructive command being flagged.

*Call graph*: 1 external calls (assert!).


##### `tests::rm_f_is_dangerous`  (lines 173–175)

```
fn rm_f_is_dangerous()
```

**Purpose**: Verifies that `rm -f /` is treated as dangerous. This checks the file’s rule for force deletion without the recursive flag.

**Data flow**: It builds the sample command words for `rm -f /`, passes them to `command_might_be_dangerous`, and asserts that the result is `true`. It only observes the checker’s answer.

**Call relations**: This test goes through the same public function used by the rest of the program. It confirms that the lower-level `is_dangerous_to_call_with_exec` rule is visible through the normal command danger API.

*Call graph*: 1 external calls (assert!).


##### `tests::direct_powershell_words_reuse_windows_dangerous_detection`  (lines 178–186)

```
fn direct_powershell_words_reuse_windows_dangerous_detection()
```

**Purpose**: Checks that direct PowerShell danger detection is wired to Windows-specific rules on Windows, and disabled elsewhere. This keeps platform behavior explicit.

**Data flow**: It builds a sample PowerShell command, `Remove-Item test -Force`. If the test is running on Windows, it expects `is_dangerous_powershell_words` to return `true`; on other systems, it expects `false`. The output is the test pass or failure.

**Call relations**: This test calls `is_dangerous_powershell_words`, which forwards to the Windows checker only on Windows builds. It confirms that `render_decision_for_unmatched_command` will get platform-appropriate PowerShell danger answers.

*Call graph*: 3 external calls (assert!, cfg!, vec_str).


### `shell-command/src/command_safety/windows_safe_commands.rs`

`domain_logic` · `command approval / request handling`

This file is a safety gate for running commands on Windows. Windows has several ways to start programs and scripts, and some can hide dangerous behavior. To avoid guessing, this file takes a conservative approach: only PowerShell or pwsh invocations are considered, and even then only a small list of read-only commands is allowed. Think of it like a museum guard who only lets visitors into marked public rooms, not locked doors or unknown hallways.

The flow starts with the full command as a list of words, such as the executable name and its arguments. The code first checks that the executable is PowerShell. It then looks for a script passed through options like -Command, or treats remaining non-option arguments as the script. That script is parsed using a PowerShell parser, not simple string splitting, so tricky syntax such as redirection, dynamic variables, or unsupported constructs can be refused safely.

After parsing, each command in a pipeline is checked against a read-only safelist: listing files, reading files, searching text, counting results, asking Git safe questions, and using ripgrep with safe options. Known write-like commands, process-starting commands, encoded scripts, script files, and unknown switches are rejected. Without this file, the system might accidentally treat a destructive Windows command as harmless.

#### Function details

##### `is_safe_command_windows`  (lines 8–17)

```
fn is_safe_command_windows(command: &[String]) -> bool
```

**Purpose**: This is the main Windows safety check. It answers one question: can this command be run automatically, or should it be treated as unsafe?

**Data flow**: It receives the command as separate strings, such as the program name and each argument. It tries to parse the command as a PowerShell invocation; if parsing works, it checks every parsed command against the read-only safelist. It returns true only when all parsed pieces are safe, and false for non-PowerShell commands or anything uncertain.

**Call relations**: The broader command-safety system calls this when it needs a Windows-specific decision. This function delegates the careful PowerShell parsing to try_parse_powershell_command_sequence, then uses the per-command safety rules to make the final yes-or-no decision.

*Call graph*: calls 1 internal fn (try_parse_powershell_command_sequence); called by 1 (is_known_safe_command).


##### `try_parse_powershell_command_sequence`  (lines 21–28)

```
fn try_parse_powershell_command_sequence(command: &[String]) -> Option<Vec<Vec<String>>>
```

**Purpose**: This function checks whether the command actually starts with a supported PowerShell executable. If it does, it turns the invocation into one or more parsed command word lists.

**Data flow**: It reads the first word as the executable and the rest as arguments. If the executable name is powershell, powershell.exe, pwsh, or pwsh.exe, it passes the remaining arguments onward for parsing. It returns parsed command sequences on success, or nothing if the command is not PowerShell.

**Call relations**: is_safe_command_windows calls this as its first filter. It uses is_powershell_executable to recognize PowerShell, then hands real PowerShell invocations to parse_powershell_invocation.

*Call graph*: calls 2 internal fn (is_powershell_executable, parse_powershell_invocation); called by 1 (is_safe_command_windows).


##### `parse_powershell_invocation`  (lines 31–92)

```
fn parse_powershell_invocation(executable: &str, args: &[String]) -> Option<Vec<Vec<String>>>
```

**Purpose**: This function understands the safe shapes of a PowerShell command line. It accepts simple inline commands and rejects forms that are opaque, unnecessary, or risky for read-only checks.

**Data flow**: It receives the PowerShell executable name and its arguments. It skips a few harmless flags, accepts command text passed through -Command or similar forms, rejects dangerous options like encoded commands or script files, and can rebuild a script from remaining plain arguments. It returns parsed command sequences, or nothing if the invocation shape is not trusted.

**Call relations**: try_parse_powershell_command_sequence calls this after confirming the executable is PowerShell. When it finds script text, it sends that text to parse_powershell_script; when plain arguments must be treated as a script, it uses join_arguments_as_script first.

*Call graph*: calls 2 internal fn (join_arguments_as_script, parse_powershell_script); called by 1 (try_parse_powershell_command_sequence).


##### `parse_powershell_script`  (lines 96–104)

```
fn parse_powershell_script(executable: &str, script: &str) -> Option<Vec<Vec<String>>>
```

**Purpose**: This function turns a PowerShell script string into structured command pieces. It relies on the real PowerShell-aware parser so the safety checker does not have to guess from raw text.

**Data flow**: It receives the executable variant and a script string. It calls the PowerShell abstract syntax tree parser, which means a parser that understands PowerShell code structure rather than just spaces. If the parser reports normal commands, those are returned; otherwise the script is rejected.

**Call relations**: parse_powershell_invocation calls this whenever it has identified the script portion of a PowerShell invocation. It hands off to parse_with_powershell_ast, and only passes successful command lists back to the safety-checking path.

*Call graph*: calls 1 internal fn (parse_with_powershell_ast); called by 1 (parse_powershell_invocation).


##### `is_powershell_executable`  (lines 107–118)

```
fn is_powershell_executable(exe: &str) -> bool
```

**Purpose**: This function recognizes whether a program name points to a supported PowerShell binary. It works with both bare names and full paths.

**Data flow**: It receives an executable string, extracts the file name if the string is a path, lowercases it, and compares it with known PowerShell names. It returns true for powershell, powershell.exe, pwsh, and pwsh.exe, and false for anything else.

**Call relations**: try_parse_powershell_command_sequence calls this before doing any deeper parsing. It acts as the front-door check that keeps direct CMD commands or unrelated programs out of the automatic-safe path.

*Call graph*: called by 1 (try_parse_powershell_command_sequence); 2 external calls (new, matches!).


##### `join_arguments_as_script`  (lines 120–129)

```
fn join_arguments_as_script(args: &[String]) -> String
```

**Purpose**: This function rebuilds a PowerShell script string from separate command-line arguments when PowerShell was invoked without an explicit -Command flag. It preserves the first word as the command and quotes later words when needed.

**Data flow**: It receives a slice of argument strings. It copies the first argument as-is, quotes later arguments that contain spaces, joins everything with spaces, and returns the rebuilt script string.

**Call relations**: parse_powershell_invocation uses this when it reaches plain non-flag arguments. It relies on quote_argument to make space-containing arguments safe to reparse as part of a script.

*Call graph*: calls 1 internal fn (quote_argument); called by 1 (parse_powershell_invocation); 1 external calls (with_capacity).


##### `quote_argument`  (lines 131–141)

```
fn quote_argument(arg: &str) -> String
```

**Purpose**: This helper prepares one argument to be included in a rebuilt PowerShell script. It adds single quotes only when an argument needs them.

**Data flow**: It receives one argument string. Empty arguments become two single quotes, arguments without whitespace are returned unchanged, and arguments with whitespace are wrapped in single quotes with internal single quotes doubled. The result is a PowerShell-friendly text form of the argument.

**Call relations**: join_arguments_as_script calls this for arguments after the first one. It keeps rebuilt scripts from accidentally changing meaning when file names or values contain spaces.

*Call graph*: called by 1 (join_arguments_as_script); 1 external calls (format!).


##### `is_safe_powershell_words`  (lines 145–207)

```
fn is_safe_powershell_words(words: &[String]) -> bool
```

**Purpose**: This function decides whether one parsed PowerShell command is read-only and allowed. It is the main safelist for PowerShell command names and selected external tools.

**Data flow**: It receives one command as parsed words, with the command name first. It rejects empty commands, checks all words for nested dangerous cmdlets, normalizes the command name, and compares it with known safe or unsafe commands. It returns true for allowed read-only commands, including safe Git and ripgrep usage, and false otherwise.

**Call relations**: This is used during the final safety pass after parsing has broken a PowerShell script into command pieces. For Git commands it hands the details to is_safe_git_command, and for ripgrep commands it hands the option check to is_safe_ripgrep.

*Call graph*: calls 2 internal fn (is_safe_git_command, is_safe_ripgrep); called by 1 (is_safe_powershell_words); 1 external calls (matches!).


##### `is_safe_ripgrep`  (lines 210–222)

```
fn is_safe_ripgrep(words: &[String]) -> bool
```

**Purpose**: This function checks whether an rg, or ripgrep, command avoids options that can run other programs. Ripgrep is normally a read-only search tool, but a few options can make it unsafe.

**Data flow**: It receives the parsed rg command words. It skips the command name, lowercases each option, and looks for forbidden options such as --pre, --hostname-bin, --search-zip, or -z. It returns true when none of those risky options appear, and false when one does.

**Call relations**: is_safe_powershell_words calls this after recognizing rg as the command. This keeps the general PowerShell safelist simple while giving ripgrep its own detailed option check.

*Call graph*: called by 1 (is_safe_powershell_words).


##### `tests::vec_str`  (lines 232–234)

```
fn vec_str(args: &[&str]) -> Vec<String>
```

**Purpose**: This small test helper converts borrowed string literals into owned String values. It makes the tests easier to read because they can write command examples as simple text slices.

**Data flow**: It receives a slice of string literals. It copies each item into a String and returns a vector of those Strings, matching the input shape expected by the safety functions.

**Call relations**: The test functions use this helper whenever they build example commands. It has no role in production behavior.


##### `tests::recognizes_safe_powershell_wrappers`  (lines 237–267)

```
fn recognizes_safe_powershell_wrappers()
```

**Purpose**: This test checks that normal safe PowerShell wrapper forms are accepted. It covers common flags and simple read-only commands.

**Data flow**: It builds several PowerShell command examples, including file listing, Git status, and file reading. Each example is sent into is_safe_command_windows, and the test expects true. If pwsh is available on the machine, it also checks that pwsh works the same way.

**Call relations**: This test exercises the main safety entry point through realistic wrapper commands. It uses try_find_pwsh_executable_blocking when it needs a real pwsh path for the local Windows environment.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 1 external calls (assert!).


##### `tests::accepts_full_path_powershell_invocations`  (lines 270–290)

```
fn accepts_full_path_powershell_invocations()
```

**Purpose**: This test proves that the checker recognizes PowerShell even when it is named by a full filesystem path. That matters because callers may not invoke powershell.exe by a short name.

**Data flow**: It builds commands where the first word is a full path to PowerShell or pwsh. The commands are read-only, so the test expects is_safe_command_windows to return true. On non-Windows platforms, it skips path-sensitive checks.

**Call relations**: This test focuses on is_powershell_executable through the public safety function. It may call try_find_pwsh_executable_blocking to locate a real pwsh installation.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 2 external calls (assert!, cfg!).


##### `tests::allows_read_only_pipelines_and_git_usage`  (lines 293–333)

```
fn allows_read_only_pipelines_and_git_usage()
```

**Purpose**: This test checks that useful read-only pipelines are allowed. It includes searching, counting, selecting output, reading files, and safe Git inspection.

**Data flow**: It finds pwsh, builds several PowerShell -Command examples containing pipelines or Git commands, and sends each to is_safe_command_windows. Each example should return true because it reads information without changing files or processes.

**Call relations**: This test runs through the full path: PowerShell invocation parsing, PowerShell AST parsing, per-command safelist checks, and Git-specific safety checks.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 1 external calls (assert!).


##### `tests::rejects_git_global_override_options`  (lines 336–368)

```
fn rejects_git_global_override_options()
```

**Purpose**: This test checks that Git options capable of changing Git’s environment or behavior are not treated as automatically safe. Such options can make an apparently read-only Git command run unexpected helpers or read from attacker-controlled locations.

**Data flow**: It creates a list of Git commands using risky global options such as configuration overrides, custom git directories, work trees, exec paths, namespaces, and super-prefixes. Each command is wrapped in PowerShell and passed to is_safe_command_windows. The expected result is false for every case.

**Call relations**: This test reaches the Git-specific safety logic through the Windows PowerShell safety path. It uses try_find_pwsh_executable_blocking so the examples can run against a real pwsh executable when available.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 1 external calls (assert!).


##### `tests::rejects_git_subcommand_options_with_side_effects`  (lines 371–403)

```
fn rejects_git_subcommand_options_with_side_effects()
```

**Purpose**: This test checks that dangerous Git subcommand options are rejected. These are options that can write files or run external filters even when the Git command looks like it is only inspecting history.

**Data flow**: It builds several PowerShell-wrapped Git examples, records whether each one is considered safe, and compares the collected results with the expected all-false list. A mismatch means a risky Git form slipped through.

**Call relations**: This test exercises is_safe_command_windows and, through it, the Git safety checker. It uses an equality assertion so the failure output clearly shows which Git example behaved differently.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_stop_parsing_git_forms`  (lines 406–413)

```
fn rejects_stop_parsing_git_forms()
```

**Purpose**: This test verifies that PowerShell’s stop-parsing marker is not allowed to hide unsafe Git arguments. The stop-parsing marker can change how following text is interpreted.

**Data flow**: It builds a PowerShell command containing a Git log invocation with --% and a risky output option. It sends the command into is_safe_command_windows and expects false.

**Call relations**: This test checks the full parser-and-safelist path for a known tricky syntax form. It helps ensure unsafe Git arguments cannot bypass normal parsing.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_powershell_commands_with_side_effects`  (lines 416–512)

```
fn rejects_powershell_commands_with_side_effects()
```

**Purpose**: This test covers many PowerShell patterns that should never be auto-approved because they can write files, start commands, redirect output, or use confusing syntax. It is a broad guard against accidental loosening of the safety rules.

**Data flow**: It builds many example PowerShell commands, including Remove-Item, Set-Content, unsafe ripgrep options, redirection, call operators, chained safe-and-unsafe commands, nested unsafe commands, array expansion, unsupported operators, sub-expressions, and empty parsed commands. Each is sent to is_safe_command_windows, and each must return false.

**Call relations**: This test stresses both the PowerShell parser and is_safe_powershell_words. It confirms that unsafe syntax is rejected before or during the per-command safelist check.

*Call graph*: 1 external calls (assert!).


##### `tests::accepts_constant_expression_arguments`  (lines 515–527)

```
fn accepts_constant_expression_arguments()
```

**Purpose**: This test checks that simple quoted literal arguments are accepted. File names with spaces should be safe when they are fixed text, not dynamic code.

**Data flow**: It creates PowerShell commands that read files named with quoted strings. The commands go into is_safe_command_windows, and the expected result is true.

**Call relations**: This test exercises the parser’s ability to accept constant expressions and pass them to the safelist as ordinary command words. It protects useful read-only cases from being blocked too aggressively.

*Call graph*: 1 external calls (assert!).


##### `tests::rejects_dynamic_arguments`  (lines 530–542)

```
fn rejects_dynamic_arguments()
```

**Purpose**: This test checks that variable-based arguments are rejected. Dynamic values can hide what command will really run or what file will be touched.

**Data flow**: It creates PowerShell commands that use variables directly or inside strings. Each command is checked with is_safe_command_windows, and the expected result is false.

**Call relations**: This test depends on the PowerShell parser refusing dynamic expressions for this safety path. It confirms that only clearly known command words and literal arguments reach the safelist.

*Call graph*: 1 external calls (assert!).


##### `tests::uses_invoked_powershell_variant_for_parsing`  (lines 545–572)

```
fn uses_invoked_powershell_variant_for_parsing()
```

**Purpose**: This test checks that the parser uses the same PowerShell variant that the user invoked. Windows PowerShell and modern pwsh can understand different syntax, so safety must be judged using the right rules.

**Data flow**: On Windows, it builds a command chain using syntax that differs between powershell.exe and pwsh. It expects the powershell.exe form to be rejected and, if pwsh is available, the pwsh form to be accepted.

**Call relations**: This test runs through is_safe_command_windows and parse_powershell_script, with try_find_pwsh_executable_blocking used to locate pwsh. It guards against parsing a command with the wrong PowerShell dialect.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 2 external calls (assert!, cfg!).


### `shell-command/src/command_safety/is_safe_command.rs`

`domain_logic` · `command approval / request handling`

When an automated tool wants to run a shell command, some commands are clearly low-risk, while others can change files, run hidden programs, or delete data. This file is the project’s conservative “known safe” checklist. It does not try to prove that every possible command is harmless. Instead, it recognizes a small set of commands and options that are expected to only read information.

The main entry point takes an already-split command, such as `["git", "status"]`. It normalizes a few cases, such as treating `zsh` like `bash`, then checks platform-specific Windows rules if needed. After that it checks a built-in allow-list: commands like `ls`, `cat`, `grep`, `pwd`, and selected forms of `git`, `find`, `rg`, `base64`, and `sed`.

The important detail is that options matter. For example, `find` can be safe when it searches, but unsafe when it uses `-delete` or `-exec`. `git log` is usually read-only, but Git options that change the working directory, invoke pagers, write output files, or use external helpers are rejected. The file also supports simple `bash -lc "..."` scripts if they are just plain commands joined by basic shell operators like `&&`, `||`, `;`, or `|`. Think of it like a bouncer with a short guest list: familiar names still get checked for dangerous baggage.

#### Function details

##### `is_known_safe_command`  (lines 12–50)

```
fn is_known_safe_command(command: &[String]) -> bool
```

**Purpose**: Decides whether a whole command line is known to be safe enough to auto-approve. This is the main safety question asked before an unmatched command is allowed to run without extra user approval.

**Data flow**: It receives a list of command words, changes `zsh` to `bash` for this check, then tries several safety paths: Windows-specific safe commands, direct executable allow-list checks, and simple `bash -lc` command sequences. It returns `true` only if one of those paths proves the command is in the narrow safe set; otherwise it returns `false`.

**Call relations**: When `render_decision_for_unmatched_command` needs to decide what to do with a command, it calls this function. This function then hands the work to the platform-specific Windows checker, the direct command checker, or the shell-script parser depending on what shape the command has.

*Call graph*: calls 3 internal fn (parse_shell_lc_plain_commands, is_safe_to_call_with_exec, is_safe_command_windows); called by 1 (render_decision_for_unmatched_command).


##### `is_safe_powershell_words`  (lines 54–65)

```
fn is_safe_powershell_words(command: &[String]) -> bool
```

**Purpose**: Checks whether already-split PowerShell words are safe according to the Windows PowerShell allow-list. On non-Windows systems it deliberately says no.

**Data flow**: It receives PowerShell command words. On Windows, it passes those words to the Windows-specific checker and returns that result; elsewhere it ignores the words and returns `false`.

**Call relations**: This is another safety question used by `render_decision_for_unmatched_command`. It keeps PowerShell safety rules behind a platform boundary so that non-Windows systems do not accidentally treat a PowerShell-looking path as safe.

*Call graph*: calls 1 internal fn (is_safe_powershell_words); called by 1 (render_decision_for_unmatched_command).


##### `is_safe_to_call_with_exec`  (lines 67–173)

```
fn is_safe_to_call_with_exec(command: &[String]) -> bool
```

**Purpose**: Checks whether a directly executed command is on the safe allow-list, including its options. It is the core rulebook for non-shell commands.

**Data flow**: It receives command words, looks at the first word as the executable name, normalizes that name for lookup, then matches it against known safe commands. For commands with risky options, such as `base64`, `find`, `rg`, `git`, and `sed`, it inspects the remaining words before returning `true`; unknown or risky forms return `false`.

**Call relations**: The main command checker calls this for direct commands and for each plain command extracted from `bash -lc`. When it sees Git it delegates to `is_safe_git_command`, and when it sees the special safe `sed -n ...p` shape it asks `is_valid_sed_n_arg` to verify the print range.

*Call graph*: calls 3 internal fn (executable_name_lookup_key, is_safe_git_command, is_valid_sed_n_arg); called by 1 (is_known_safe_command); 2 external calls (cfg!, matches!).


##### `is_safe_git_command`  (lines 175–200)

```
fn is_safe_git_command(command: &[String]) -> bool
```

**Purpose**: Decides whether a Git command is only reading information, such as status, logs, diffs, shows, or safe branch listing. It blocks Git forms that can change state, run helpers, or write output.

**Data flow**: It receives all Git command words, finds the first real Git subcommand while skipping allowed-looking global option positions, then checks any global arguments for unsafe options. It then checks the subcommand’s own arguments for write-like or external-execution options, and applies extra strict rules for `git branch`.

**Call relations**: The direct command checker calls this whenever the executable is Git, and the call graph also shows it participating in the PowerShell safety path. It relies on the shared Git subcommand finder, then hands global options to `git_has_unsafe_global_option`, subcommand options to `git_subcommand_args_are_read_only`, and branch-specific arguments to `git_branch_is_read_only`.

*Call graph*: calls 4 internal fn (find_git_subcommand, git_branch_is_read_only, git_has_unsafe_global_option, git_subcommand_args_are_read_only); called by 2 (is_safe_to_call_with_exec, is_safe_powershell_words); 1 external calls (debug_assert!).


##### `git_branch_is_read_only`  (lines 204–228)

```
fn git_branch_is_read_only(branch_args: &[String]) -> bool
```

**Purpose**: Separates safe `git branch` queries from branch-changing commands. Listing branches is allowed; creating, deleting, or renaming branches is not.

**Data flow**: It receives only the arguments after `git branch`. With no arguments it returns `true`, because that lists branches. With arguments, it accepts only clearly read-only flags such as `--list`, `--show-current`, `--all`, or `--format=...`; any unknown flag or branch name makes it return `false`.

**Call relations**: `is_safe_git_command` calls this only after it has already identified the subcommand as `branch` and checked the general Git safety rules. This function is the final stricter filter for the one Git subcommand whose plain positional arguments can easily mean mutation.

*Call graph*: called by 1 (is_safe_git_command).


##### `GitOptionPattern::matches`  (lines 268–276)

```
fn matches(self, arg: &str) -> bool
```

**Purpose**: Checks whether one command-line argument matches a stored Git option pattern. It supports exact option names, short options with attached values, and long-option prefixes.

**Data flow**: It receives one pattern and one argument string. Depending on the pattern kind, it compares equality, checks for a short option followed by extra text, or checks whether the argument starts with a prefix, then returns `true` or `false`.

**Call relations**: This is the small matching rule used by the Git option scanning helpers. It lets the rest of the file describe unsafe Git options in a compact table instead of repeating string-comparison code.


##### `git_matches_option_pattern`  (lines 279–281)

```
fn git_matches_option_pattern(arg: &str, patterns: &[GitOptionPattern]) -> bool
```

**Purpose**: Checks whether a Git argument matches any pattern in a given unsafe-option list. It answers the simple question, “Is this argument one of the dangerous forms we know about?”

**Data flow**: It receives one argument and a list of Git option patterns. It tries the argument against each pattern and returns `true` as soon as any pattern matches; otherwise it returns `false`.

**Call relations**: The Git global-option and subcommand-option checkers use this as their shared scanner. It sits between the high-level Git safety rules and the low-level `GitOptionPattern::matches` comparison.

*Call graph*: 1 external calls (iter).


##### `git_has_unsafe_global_option`  (lines 283–288)

```
fn git_has_unsafe_global_option(global_args: &[String]) -> bool
```

**Purpose**: Detects Git global options that make an otherwise read-only command too risky to auto-approve. These include options that change directories, configuration, execution paths, namespaces, pagination, or work trees.

**Data flow**: It receives the words that appear between `git` and the Git subcommand. It checks each word against the unsafe global option patterns and returns `true` if any risky option is present.

**Call relations**: `is_safe_git_command` calls this after finding the Git subcommand but before approving any Git operation. If this function finds a risky global option, the Git command is rejected immediately.

*Call graph*: called by 1 (is_safe_git_command).


##### `git_subcommand_args_are_read_only`  (lines 290–295)

```
fn git_subcommand_args_are_read_only(args: &[String]) -> bool
```

**Purpose**: Checks Git subcommand arguments for options that can write files or invoke external tools. It is used for read-only-looking subcommands such as `log`, `diff`, and `show`.

**Data flow**: It receives the arguments after the Git subcommand. It searches for unsafe subcommand options like `--output`, `--ext-diff`, `--textconv`, and `--exec`, returning `false` if any are found and `true` otherwise.

**Call relations**: `is_safe_git_command` uses this as the common argument filter for approved Git subcommands. For `git branch`, its result is combined with the stricter branch-only check.

*Call graph*: called by 1 (is_safe_git_command).


##### `is_valid_sed_n_arg`  (lines 304–334)

```
fn is_valid_sed_n_arg(arg: Option<&str>) -> bool
```

**Purpose**: Verifies the one narrow `sed` script shape this file considers safe: printing a single line or a line range, such as `10p` or `1,5p`. This allows simple viewing without allowing general `sed` editing scripts.

**Data flow**: It receives an optional string. If the string is missing, does not end in `p`, has too many comma-separated parts, or contains non-digits in the line numbers, it returns `false`; otherwise it returns `true`.

**Call relations**: `is_safe_to_call_with_exec` calls this when checking the special case `sed -n ...`. It keeps the `sed` allow-list intentionally tiny instead of accepting arbitrary `sed` programs.

*Call graph*: called by 1 (is_safe_to_call_with_exec).


##### `tests::vec_str`  (lines 341–343)

```
fn vec_str(args: &[&str]) -> Vec<String>
```

**Purpose**: Creates test command vectors without making each test write repetitive string conversion code. It is only a convenience helper for the tests in this file.

**Data flow**: It receives a slice of string literals. It converts each one into an owned `String` and returns them as a `Vec<String>`, matching the input type expected by the safety functions.

**Call relations**: The test cases use this helper before calling the safety checks. It has no role in production command approval.


##### `tests::known_safe_examples`  (lines 346–377)

```
fn known_safe_examples()
```

**Purpose**: Confirms that ordinary read-only commands are accepted. It covers basic Unix-style tools, safe Git examples, safe `find`, safe `sed`, and Linux-only commands.

**Data flow**: The test builds many sample commands and sends them into the direct safety checker. It expects `true` for safe examples, with different expectations for `numfmt` and `tac` depending on the operating system.

**Call relations**: The Rust test runner calls this during testing. It protects the intended allow-list from being accidentally narrowed or changed across platforms.

*Call graph*: 2 external calls (assert!, cfg!).


##### `tests::git_branch_mutating_flags_are_not_safe`  (lines 380–389)

```
fn git_branch_mutating_flags_are_not_safe()
```

**Purpose**: Checks that branch deletion and branch creation are not auto-approved. This protects against treating all `git branch` commands as harmless.

**Data flow**: The test sends `git branch -d feature` and `git branch new-branch` into the main safety checker. It expects both to return `false`.

**Call relations**: The Rust test runner calls this to exercise the branch-specific rules inside `is_safe_git_command` and `git_branch_is_read_only`.

*Call graph*: 1 external calls (assert!).


##### `tests::git_branch_global_options_respect_safety_rules`  (lines 392–406)

```
fn git_branch_global_options_respect_safety_rules()
```

**Purpose**: Verifies that safe branch queries are allowed while mutating branch commands are rejected, both directly and through `bash -lc`. It checks that shell wrapping does not bypass Git branch safety.

**Data flow**: The test feeds safe and unsafe branch commands to `is_known_safe_command`. It expects `--show-current` to pass, and deletion examples to fail.

**Call relations**: The Rust test runner calls this to cover the path where `is_known_safe_command` may either check Git directly or parse a simple shell command first.

*Call graph*: 1 external calls (assert!).


##### `tests::git_first_positional_is_the_subcommand`  (lines 409–415)

```
fn git_first_positional_is_the_subcommand()
```

**Purpose**: Ensures the Git parser treats the first non-option word as the subcommand. This prevents a later word like `status` from making `git checkout status` look safe.

**Data flow**: The test passes `git checkout status` to the main safety checker. It expects `false` because `checkout` is the real subcommand and is not in the read-only allow-list.

**Call relations**: The Rust test runner calls this to validate the shared Git subcommand-finding behavior used by `is_safe_git_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::git_output_flags_are_not_safe`  (lines 418–438)

```
fn git_output_flags_are_not_safe()
```

**Purpose**: Checks that Git commands with output-writing flags are rejected. A command that writes to a file is not treated as read-only.

**Data flow**: The test builds `git log`, `git diff`, and `git show` examples using `--output` or `--output=...`. Each is sent to the main safety checker and expected to return `false`.

**Call relations**: The Rust test runner calls this to guard the unsafe Git subcommand option list used by `git_subcommand_args_are_read_only`.

*Call graph*: 1 external calls (assert!).


##### `tests::git_global_pagination_flags_are_not_safe`  (lines 441–461)

```
fn git_global_pagination_flags_are_not_safe()
```

**Purpose**: Confirms that Git global pagination options are rejected. Even though paging output sounds harmless, Git pagers can involve external commands and configuration.

**Data flow**: The test checks direct and `bash -lc` forms of `git --paginate log -1` and `git -p log -1`. It expects all of them to be unsafe.

**Call relations**: The Rust test runner calls this to make sure `git_has_unsafe_global_option` applies before subcommand approval, including when the command is inside a simple shell script.

*Call graph*: 1 external calls (assert!).


##### `tests::git_subcommand_patch_flags_remain_safe`  (lines 464–475)

```
fn git_subcommand_patch_flags_remain_safe()
```

**Purpose**: Makes sure `-p` is still allowed when it is a subcommand option meaning “show patch,” not a global pagination flag. This keeps the Git rules precise instead of over-blocking useful read-only commands.

**Data flow**: The test sends `git log -p`, `git diff -p`, `git show -p`, and a shell-wrapped version into the main safety checker. It expects all to return `true`.

**Call relations**: The Rust test runner calls this to protect the distinction between unsafe global Git options and safe subcommand-level patch flags.

*Call graph*: 1 external calls (assert!).


##### `tests::git_global_override_flags_are_not_safe`  (lines 478–527)

```
fn git_global_override_flags_are_not_safe()
```

**Purpose**: Checks that Git global options which alter configuration, paths, namespaces, work trees, or helper locations are rejected. These options can make a read-only-looking command behave in surprising ways.

**Data flow**: The test feeds many Git commands with global override options into the main safety checker. It expects each one to return `false`, including direct commands and simple `bash -lc` commands.

**Call relations**: The Rust test runner calls this to thoroughly exercise the unsafe global Git option patterns and the shell-command path that eventually reaches the same Git checks.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::cargo_check_is_not_safe`  (lines 530–532)

```
fn cargo_check_is_not_safe()
```

**Purpose**: Confirms that `cargo check` is not auto-approved by this allow-list. Even common developer commands can run build scripts or otherwise do more than read files.

**Data flow**: The test sends `cargo check` to the main safety checker and expects `false`.

**Call relations**: The Rust test runner calls this to document and preserve the conservative boundary of the safe-command list.

*Call graph*: 1 external calls (assert!).


##### `tests::zsh_lc_safe_command_sequence`  (lines 535–537)

```
fn zsh_lc_safe_command_sequence()
```

**Purpose**: Checks that a simple `zsh -lc` command is treated like the equivalent `bash -lc` command. This supports users whose shell is zsh while still using the same cautious parser.

**Data flow**: The test passes `zsh -lc ls` to the main safety checker. It expects `true` because the function normalizes `zsh` to `bash` before checking.

**Call relations**: The Rust test runner calls this to cover the normalization step at the start of `is_known_safe_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::unknown_or_partial`  (lines 540–566)

```
fn unknown_or_partial()
```

**Purpose**: Verifies that unknown commands, unsupported Git commands, invalid `sed`, and dangerous `find` options are rejected. It proves the allow-list is not permissive by default.

**Data flow**: The test builds several unsafe or unrecognized commands and sends them to the direct safety checker. It expects `false` for each case, especially `find` options that can delete files, write file lists, or execute other commands.

**Call relations**: The Rust test runner calls this to exercise the default rejection path and the special filters for Git, `sed`, and `find`.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::base64_output_options_are_unsafe`  (lines 569–581)

```
fn base64_output_options_are_unsafe()
```

**Purpose**: Checks that `base64` is rejected when it is asked to write output to a file. Reading or printing encoded data can be safe, but writing files is outside this allow-list.

**Data flow**: The test sends `base64` commands using `-o`, `--output`, `--output=...`, and attached short-option forms. It expects all of them to return `false`.

**Call relations**: The Rust test runner calls this to protect the `base64` option filter inside `is_safe_to_call_with_exec`.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::ripgrep_rules`  (lines 584–615)

```
fn ripgrep_rules()
```

**Purpose**: Tests the special safety rules for `rg`, also known as ripgrep, a fast text search tool. Normal searching is allowed, but options that invoke outside commands or decompression tools are not.

**Data flow**: The test sends a normal `rg` search and expects `true`. It then sends commands with `--search-zip`, `-z`, `--pre`, and `--hostname-bin`, including `--option=value` forms, and expects `false`.

**Call relations**: The Rust test runner calls this to verify the ripgrep branch of `is_safe_to_call_with_exec`.

*Call graph*: 2 external calls (assert!, vec_str).


##### `tests::windows_powershell_full_path_is_safe`  (lines 618–636)

```
fn windows_powershell_full_path_is_safe()
```

**Purpose**: On Windows, checks that a full path to PowerShell can still be recognized as safe when running a known read-only command. This matters because executables are often invoked by full path rather than plain name.

**Data flow**: The test skips itself on non-Windows systems. On Windows, it tries to find PowerShell, builds a `Get-Location` command, and expects the main safety checker to approve it.

**Call relations**: The Rust test runner calls this only as a platform-sensitive test. It exercises the Windows-specific safety checker reached from `is_known_safe_command`.

*Call graph*: calls 1 internal fn (try_find_pwsh_executable_blocking); 2 external calls (assert!, cfg!).


##### `tests::windows_git_full_path_is_safe`  (lines 639–648)

```
fn windows_git_full_path_is_safe()
```

**Purpose**: On Windows, confirms that Git can be recognized as safe even when invoked by its full installation path. This keeps safe-command detection from depending only on short executable names.

**Data flow**: The test skips itself on non-Windows systems. On Windows, it passes a full `git.exe` path with `status` and expects approval.

**Call relations**: The Rust test runner calls this to cover executable-name normalization and Windows path handling in the main safety flow.

*Call graph*: 2 external calls (assert!, cfg!).


##### `tests::bash_lc_safe_examples`  (lines 651–680)

```
fn bash_lc_safe_examples()
```

**Purpose**: Checks that simple `bash -lc` scripts made of plain safe commands are approved. This lets common shell-wrapped read-only commands run without unnecessary prompts.

**Data flow**: The test sends shell-wrapped examples such as `ls`, `git status`, `grep`, `sed -n`, and safe `find` to the main safety checker. It expects each to return `true`.

**Call relations**: The Rust test runner calls this to exercise the path where `is_known_safe_command` uses the shell parser and then checks each parsed command with the direct safety checker.

*Call graph*: 1 external calls (assert!).


##### `tests::bash_lc_safe_examples_with_operators`  (lines 683–704)

```
fn bash_lc_safe_examples_with_operators()
```

**Purpose**: Verifies that simple safe commands joined by conservative shell operators are approved. Operators like `&&`, `||`, `;`, and `|` are allowed only when every command around them is safe.

**Data flow**: The test passes shell scripts such as `ls && pwd`, `echo 'hi' ; ls`, and `ls | wc -l`. It expects the main safety checker to accept them.

**Call relations**: The Rust test runner calls this to validate the cooperation between the shell parser and repeated calls to the direct command safety checker.

*Call graph*: 1 external calls (assert!).


##### `tests::bash_lc_unsafe_examples`  (lines 707–743)

```
fn bash_lc_unsafe_examples()
```

**Purpose**: Checks that unsafe or too-complicated shell forms are rejected. This includes malformed shell invocation, unsafe commands in a sequence, subshell parentheses, and output redirection.

**Data flow**: The test sends several `bash -lc` examples to the main safety checker. It expects `false` when the command cannot be confidently parsed as plain safe commands or when any part can change files or run unsafe behavior.

**Call relations**: The Rust test runner calls this to protect the conservative boundary of `parse_shell_lc_plain_commands` as used by `is_known_safe_command`.

*Call graph*: 1 external calls (assert!).


##### `tests::direct_powershell_words_use_windows_safelist`  (lines 746–754)

```
fn direct_powershell_words_use_windows_safelist()
```

**Purpose**: Checks that direct PowerShell word safety uses the Windows allow-list only on Windows. On other systems, the same words should not be considered safe.

**Data flow**: The test builds a `Get-Content Cargo.toml` PowerShell command and passes it to `is_safe_powershell_words`. It expects `true` on Windows and `false` elsewhere.

**Call relations**: The Rust test runner calls this to verify the platform split inside `is_safe_powershell_words`.

*Call graph*: 3 external calls (assert!, cfg!, vec_str).


##### `tests::non_windows_safe_classification_does_not_spawn_repo_powershell_path`  (lines 758–801)

```
fn non_windows_safe_classification_does_not_spawn_repo_powershell_path()
```

**Purpose**: On Unix-like systems, proves that checking whether a PowerShell-looking path is safe does not execute that path. This prevents safety classification itself from becoming a way to run code.

**Data flow**: The test creates a temporary fake `pwsh` executable that would write a marker file if run. It asks the main safety checker about that fake PowerShell command, expects `false`, verifies the marker file was not created, and then removes the temporary directory.

**Call relations**: The Rust test runner calls this Unix-only test to guard against accidental process spawning during non-Windows safety checks, especially around PowerShell detection.

*Call graph*: 10 external calls (now, assert!, format!, create, create_dir, metadata, remove_dir_all, set_permissions, temp_dir, writeln!).
