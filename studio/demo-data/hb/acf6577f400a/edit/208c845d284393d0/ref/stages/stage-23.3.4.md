# legacy and current execpolicy executable tests  `stage-23.3.4`

This stage is the system’s safety check for command-running rules. It sits in the “does it really behave as promised?” part of the story, after the policy code exists, and proves that both the current and older rule sets still make the same kinds of allow-or-block decisions.

The newer tests cover the full path from reading a policy to judging a command. execpolicy/tests/basic.rs checks common rule types such as command prefixes, network access, examples, explanations, and finding the real program on the host machine. cli/tests/execpolicy.rs goes one step further and tests the user-facing command-line tool, making sure its JSON output has the right decision details.

The legacy side keeps a large, curated command corpus alive. all.rs and suite/mod.rs gather many smaller test groups into one runnable suite. good.rs and bad.rs act like a master answer key: known-safe examples must pass, and known-unsafe ones must fail. The command-specific files then inspect tricky cases for cp, head, ls, pwd, literal argument matching, and sed parsing and safety, checking not just pass or fail but the exact normalized result or exact error returned.

## Files in this stage

### Current execpolicy integration
These tests cover the current execpolicy runtime and CLI-facing integration behavior, from core parser/runtime scenarios to executable JSON output checks.

### `cli/tests/execpolicy.rs`

`test` · `policy evaluation command execution`

This file exercises the policy-checking CLI against real rule files written under a temporary home directory. Each test creates `rules/policy.rules`, writes a small policy program containing a `prefix_rule` for `git push`, then invokes `codex execpolicy check --rules <path> git push origin main`. The command’s stdout is parsed as `serde_json::Value` and compared for exact equality against a `json!` literal, making these tests contract checks for the external JSON schema rather than loose behavioral smoke tests. The first case expects a `decision` of `forbidden` and a single `matchedRules` entry containing `prefixRuleMatch` with the matched prefix and decision. The second adds a `justification` field in the rule source and verifies that the same field appears in the emitted JSON. Because the assertions are exact, these tests pin down field names, nesting, and optional-field behavior. They also verify that the command succeeds end-to-end using the compiled binary, filesystem rule loading, and JSON serialization.

#### Function details

##### `execpolicy_check_matches_expected_json`  (lines 9–61)

```
fn execpolicy_check_matches_expected_json() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Verifies that a matching prefix rule produces the expected forbidden decision JSON without a justification field.

**Data flow**: Creates a temp home, computes `rules/policy.rules`, creates parent directories, writes a policy file defining a `prefix_rule` for `git push`, runs `codex execpolicy check --rules <path> git push origin main`, asserts successful exit, parses stdout bytes with `serde_json::from_slice`, and compares the resulting JSON value to an exact expected object.

**Call relations**: This test directly constructs the command and filesystem inputs because the scenario is self-contained. It delegates parsing to `serde_json` and uses exact equality to validate the CLI’s serialized response shape.

*Call graph*: 8 external calls (new, assert!, assert_eq!, new, cargo_bin, create_dir_all, write, from_slice).


##### `execpolicy_check_includes_justification_when_present`  (lines 64–119)

```
fn execpolicy_check_includes_justification_when_present() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Verifies that when a matched prefix rule includes a justification, the emitted JSON includes that justification in the nested match object.

**Data flow**: Creates a temp home and policy file path, ensures the parent directory exists, writes a `prefix_rule` with `decision = "forbidden"` and a `justification` string, runs the same `execpolicy check` command against `git push origin main`, asserts success, parses stdout JSON, and compares it to an exact expected object containing the justification field.

**Call relations**: This test mirrors `execpolicy_check_matches_expected_json` but covers the optional justification branch. Together the two tests define the stable JSON contract for matched prefix-rule output.

*Call graph*: 8 external calls (new, assert!, assert_eq!, new, cargo_bin, create_dir_all, write, from_slice).


### `execpolicy/tests/basic.rs`

`test` · `test run`

This test file is the executable specification for the `execpolicy` crate’s core behavior. The helper functions normalize repetitive setup: `tokens` converts `&str` slices into owned command vectors, `allow_all` and `prompt_all` act as deterministic heuristics fallbacks, path helpers generate platform-correct absolute executable paths and names, `starlark_string` escapes literals for embedding in policy source, and `rule_snapshots` downcasts `RuleRef` trait objects into comparable `PrefixRule` snapshots.

The tests cover both parser semantics and runtime evaluation. They verify that repeated file appends deduplicate emitted allow rules, multiple policy files accumulate rules in order, first-token alternatives expand into multiple rules while tail alternatives remain grouped, and `match`/`not_match` examples are enforced during parsing. They also check decision aggregation rules: more restrictive matches dominate less restrictive ones, both within a single command and across multiple commands, and heuristics fallback is used only when no policy rule matches.

A substantial section focuses on host executable support. Those tests confirm absolute-path validation, bare-name validation, basename consistency checks, last-definition-wins behavior for repeated `host_executable` declarations, basename-based rule matching when enabled, explicit empty allowlists blocking resolution, unmapped paths falling back to basename matching, and exact literal-path rules taking precedence over host-executable rewriting. Network-rule tests similarly verify protocol parsing, domain compilation, and wildcard-host rejection.

#### Function details

##### `tokens`  (lines 26–28)

```
fn tokens(cmd: &[&str]) -> Vec<String>
```

**Purpose**: Builds an owned command vector from a borrowed string slice array. It keeps test assertions concise and consistent.

**Data flow**: It takes `&[&str]`, maps each element through `ToString::to_string`, collects into `Vec<String>`, and returns that vector.

**Call relations**: Used throughout the test suite wherever commands, matched prefixes, or expected heuristic commands need to be written compactly.

*Call graph*: called by 11 (add_prefix_rule_extends_policy, append_allow_prefix_rule_dedupes_existing_rule, basic_match, heuristics_match_is_returned_when_no_policy_matches, justification_can_be_used_with_allow_decision, justification_is_attached_to_forbidden_matches, match_and_not_match_examples_are_enforced, only_first_token_alias_expands_to_multiple_rules, parses_multiple_policy_files, strictest_decision_wins_across_matches (+1 more)).


##### `allow_all`  (lines 30–32)

```
fn allow_all(_: &[String]) -> Decision
```

**Purpose**: Provides a heuristics fallback that always returns `Decision::Allow`. It isolates tests from unrelated heuristic logic.

**Data flow**: It ignores its `&[String]` input and returns `Decision::Allow`.

**Call relations**: Passed into policy evaluation in tests that want unmatched commands to resolve deterministically to allow.


##### `prompt_all`  (lines 34–36)

```
fn prompt_all(_: &[String]) -> Decision
```

**Purpose**: Provides a heuristics fallback that always returns `Decision::Prompt`. It is used to prove that explicit allow rules override fallback prompting.

**Data flow**: It ignores its `&[String]` input and returns `Decision::Prompt`.

**Call relations**: Used in tests where the expected result should come from policy matching rather than the fallback.


##### `absolute_path`  (lines 38–40)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Converts a string into `AbsolutePathBuf` with a test assertion that the input is valid. It simplifies expected-value construction in host executable tests.

**Data flow**: It takes a path string, calls `AbsolutePathBuf::try_from(path.to_string())`, panics on failure via `expect`, and returns the typed absolute path.

**Call relations**: Used in assertions that compare parsed or resolved host executable paths against expected values.

*Call graph*: calls 1 internal fn (try_from).


##### `host_absolute_path`  (lines 42–52)

```
fn host_absolute_path(segments: &[&str]) -> String
```

**Purpose**: Constructs a platform-appropriate absolute path string from path segments. It abstracts over Windows drive roots versus Unix root paths.

**Data flow**: It takes a slice of path segments, starts from `C:\` on Windows or `/` otherwise, pushes each segment into a `PathBuf`, converts the result to a lossy string, and returns the owned `String`.

**Call relations**: Used by host executable tests to generate realistic absolute paths without hardcoding platform-specific separators.

*Call graph*: called by 10 (host_executable_last_definition_wins, host_executable_rejects_name_with_path_separator, host_executable_rejects_path_with_wrong_basename, host_executable_resolution_does_not_override_exact_match, host_executable_resolution_falls_back_without_mapping, host_executable_resolution_ignores_path_not_in_allowlist, host_executable_resolution_respects_explicit_empty_allowlist, host_executable_resolution_uses_basename_rule_when_allowed, parses_host_executable_paths, prefix_rule_examples_honor_host_executable_resolution); 2 external calls (from, cfg!).


##### `host_executable_name`  (lines 54–60)

```
fn host_executable_name(name: &str) -> String
```

**Purpose**: Returns the platform-specific executable basename for a logical command name. On Windows it appends `.exe`; elsewhere it leaves the name unchanged.

**Data flow**: It takes a bare name string, checks `cfg!(windows)`, and returns either `format!("{name}.exe")` or `name.to_string()`.

**Call relations**: Used in tests that need basename matching to reflect platform executable naming conventions.

*Call graph*: called by 2 (host_executable_resolution_uses_basename_rule_when_allowed, prefix_rule_examples_honor_host_executable_resolution); 2 external calls (cfg!, format!).


##### `starlark_string`  (lines 62–64)

```
fn starlark_string(value: &str) -> String
```

**Purpose**: Escapes backslashes and double quotes for embedding arbitrary paths into Starlark string literals. This keeps generated policy source syntactically valid.

**Data flow**: It takes a raw string and returns a new string with `\` doubled and `"` escaped.

**Call relations**: Used by tests that build policy source strings containing absolute paths.

*Call graph*: called by 8 (host_executable_last_definition_wins, host_executable_rejects_name_with_path_separator, host_executable_rejects_path_with_wrong_basename, host_executable_resolution_does_not_override_exact_match, host_executable_resolution_ignores_path_not_in_allowlist, host_executable_resolution_uses_basename_rule_when_allowed, parses_host_executable_paths, prefix_rule_examples_honor_host_executable_resolution).


##### `rule_snapshots`  (lines 71–83)

```
fn rule_snapshots(rules: &[RuleRef]) -> Vec<RuleSnapshot>
```

**Purpose**: Downcasts `RuleRef` trait objects into comparable concrete snapshots for assertions. It currently supports only `PrefixRule` and panics on unexpected rule types.

**Data flow**: It takes a slice of `RuleRef`, iterates it, casts each rule to `&dyn Any`, downcasts to `PrefixRule`, clones the concrete rule into `RuleSnapshot::Prefix`, collects the snapshots, and returns them.

**Call relations**: Used by tests that inspect parser output structurally rather than only through runtime evaluation.

*Call graph*: called by 4 (add_prefix_rule_extends_policy, only_first_token_alias_expands_to_multiple_rules, parses_multiple_policy_files, tail_aliases_are_not_cartesian_expanded); 1 external calls (iter).


##### `append_allow_prefix_rule_dedupes_existing_rule`  (lines 86–101)

```
fn append_allow_prefix_rule_dedupes_existing_rule() -> Result<()>
```

**Purpose**: Verifies that appending the same allow prefix rule twice to a policy file does not duplicate the emitted declaration. It checks the on-disk file contents directly.

**Data flow**: The test creates a temporary directory and policy path, builds a `python3` prefix with `tokens`, calls `blocking_append_allow_prefix_rule` twice, reads the file back with `fs::read_to_string`, and asserts the contents contain exactly one `prefix_rule` declaration.

**Call relations**: This test drives the file-append helper externally and validates deduplication at the persisted policy-text layer.

*Call graph*: calls 1 internal fn (tokens); 4 external calls (assert_eq!, blocking_append_allow_prefix_rule, read_to_string, tempdir).


##### `network_rules_compile_into_domain_lists`  (lines 104–128)

```
fn network_rules_compile_into_domain_lists() -> Result<()>
```

**Purpose**: Checks that parsed network rules are stored correctly and compiled into final allow/deny domain lists with prompt-only rules omitted. It also verifies protocol parsing for HTTPS.

**Data flow**: It builds a multi-rule policy source string, parses it with `PolicyParser`, builds a `Policy`, asserts the number and protocol of parsed network rules, calls `compiled_network_domains`, and compares the returned allowed and denied vectors against expected hosts.

**Call relations**: Exercises parser-side `network_rule` handling together with runtime `Policy::compiled_network_domains` reduction semantics.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `network_rule_rejects_wildcard_hosts`  (lines 131–140)

```
fn network_rule_rejects_wildcard_hosts()
```

**Purpose**: Ensures wildcard network hosts are rejected during parsing. This protects the invariant that network rules target specific hosts only.

**Data flow**: It creates a parser, attempts to parse a `network_rule` with host `*`, captures the error with `expect_err`, and asserts the error text mentions that wildcards are not allowed.

**Call relations**: Covers the parser path through `normalize_network_rule_host` error handling.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `basic_match`  (lines 143–167)

```
fn basic_match() -> Result<()>
```

**Purpose**: Verifies the simplest successful prefix-rule match. A command matching an allow rule should produce a single `PrefixRuleMatch` and an overall allow decision.

**Data flow**: It parses a policy containing `prefix_rule(pattern = ["git", "status"])`, builds the policy, evaluates `git status` with `allow_all`, and asserts the returned `Evaluation` exactly matches the expected decision and matched prefix.

**Call relations**: Exercises the standard parse → build → `Policy::check` flow for a single exact prefix rule.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `justification_is_attached_to_forbidden_matches`  (lines 170–199)

```
fn justification_is_attached_to_forbidden_matches() -> Result<()>
```

**Purpose**: Checks that a rule’s justification string is preserved in runtime match output for forbidden rules. This ensures rationale survives parsing and evaluation.

**Data flow**: It parses a forbidden `rm` rule with `justification = "destructive command"`, evaluates an `rm -rf ...` command, and asserts the resulting `PrefixRuleMatch` includes `justification: Some(...)` and `Decision::Forbidden`.

**Call relations**: Covers parser-side justification handling and runtime propagation through `PrefixRule::matches`.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `justification_can_be_used_with_allow_decision`  (lines 202–228)

```
fn justification_can_be_used_with_allow_decision() -> Result<()>
```

**Purpose**: Verifies that justifications are not limited to rejecting rules; allow rules may also carry explanatory text. The explicit allow match should override a prompting fallback.

**Data flow**: It parses an allow `ls` rule with a justification, evaluates `ls -l` using `prompt_all` as fallback, and asserts the evaluation is allow with the justification attached to the matched rule.

**Call relations**: Demonstrates that justification is orthogonal to decision severity and that explicit matches outrank heuristics fallback.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `justification_cannot_be_empty`  (lines 231–247)

```
fn justification_cannot_be_empty()
```

**Purpose**: Ensures blank or whitespace-only justifications are rejected at parse time. This prevents storing meaningless rationale strings.

**Data flow**: It parses a `prefix_rule` whose justification is spaces only, expects parsing to fail, and asserts the error text contains `invalid rule: justification cannot be empty`.

**Call relations**: Exercises the validation branch inside the parser builtin before any rule is added.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `add_prefix_rule_extends_policy`  (lines 250–281)

```
fn add_prefix_rule_extends_policy() -> Result<()>
```

**Purpose**: Checks the programmatic `Policy::add_prefix_rule` API. It verifies both the stored rule structure and the runtime evaluation result.

**Data flow**: It starts from `Policy::empty()`, adds a prompt rule for `ls -l`, inspects the stored rules via `rule_snapshots`, evaluates a longer `ls -l ...` command with `allow_all`, and asserts both the internal `PrefixRule` and resulting `Evaluation` are correct.

**Call relations**: Covers the non-parser mutation path and confirms it produces the same runtime semantics as parsed rules.

*Call graph*: calls 2 internal fn (rule_snapshots, tokens); 2 external calls (assert_eq!, empty).


##### `add_prefix_rule_rejects_empty_prefix`  (lines 284–293)

```
fn add_prefix_rule_rejects_empty_prefix() -> Result<()>
```

**Purpose**: Ensures the programmatic prefix-rule API rejects empty prefixes. This mirrors the parser’s non-empty pattern invariant.

**Data flow**: It creates an empty policy, calls `add_prefix_rule(&[], Decision::Allow)`, unwraps the error, pattern-matches it as `Error::InvalidPattern`, and asserts the message is `prefix cannot be empty`.

**Call relations**: Tests the direct API validation path rather than Starlark parsing.

*Call graph*: 3 external calls (assert_eq!, empty, panic!).


##### `parses_multiple_policy_files`  (lines 296–373)

```
fn parses_multiple_policy_files() -> Result<()>
```

**Purpose**: Verifies that one `PolicyParser` can ingest multiple files cumulatively and preserve both rules. It also checks that evaluation returns all matching rules in order and chooses the strictest decision.

**Data flow**: It parses two separate policy strings into the same parser, builds the policy, inspects the stored `git` rules via `rule_snapshots`, evaluates `git status` and `git commit -m hi`, and asserts the prompt-only and prompt-plus-forbidden evaluations respectively.

**Call relations**: Exercises the parser’s multi-file accumulation behavior and the runtime aggregation logic across overlapping prefix rules.

*Call graph*: calls 3 internal fn (new, rule_snapshots, tokens); 1 external calls (assert_eq!).


##### `only_first_token_alias_expands_to_multiple_rules`  (lines 376–444)

```
fn only_first_token_alias_expands_to_multiple_rules() -> Result<()>
```

**Purpose**: Checks that alternatives in the first pattern token create separate rules keyed by each head token. Tail alternatives remain embedded in each generated rule.

**Data flow**: It parses a rule with first-token alternatives `["bash", "sh"]` and second-token alternatives `["-c", "-l"]`, inspects the resulting `bash` and `sh` rule sets, evaluates representative commands for each shell, and asserts both match correctly.

**Call relations**: Validates the parser builtin’s special expansion logic for the first token only.

*Call graph*: calls 3 internal fn (new, rule_snapshots, tokens); 1 external calls (assert_eq!).


##### `tail_aliases_are_not_cartesian_expanded`  (lines 447–508)

```
fn tail_aliases_are_not_cartesian_expanded() -> Result<()>
```

**Purpose**: Ensures alternatives after the first token are stored as `PatternToken::Alts` rather than expanded into multiple Cartesian-product rules. This keeps rule count bounded and matching semantics positional.

**Data flow**: It parses an `npm` rule with two tail alternative positions, inspects the single stored rule via `rule_snapshots`, evaluates commands using different allowed combinations, and asserts both commands match the same logical rule.

**Call relations**: Covers the parser’s distinction between head-token expansion and tail-token grouped alternatives.

*Call graph*: calls 3 internal fn (new, rule_snapshots, tokens); 1 external calls (assert_eq!).


##### `match_and_not_match_examples_are_enforced`  (lines 511–554)

```
fn match_and_not_match_examples_are_enforced() -> Result<()>
```

**Purpose**: Verifies that positive and negative examples attached to a rule are accepted when they reflect actual matching behavior. It also demonstrates that a non-matching command falls through to heuristics.

**Data flow**: It parses a `git status` rule with both list-form and string-form examples, builds the policy, evaluates a matching command and a deliberately non-matching command, and asserts the first yields a `PrefixRuleMatch` while the second yields a heuristics allow match.

**Call relations**: Exercises parse-time example parsing and validation together with runtime matching behavior.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `strictest_decision_wins_across_matches`  (lines 557–594)

```
fn strictest_decision_wins_across_matches() -> Result<()>
```

**Purpose**: Checks that when multiple rules match one command, the overall evaluation decision is the strictest among them. The matched-rules list should still include all contributing matches.

**Data flow**: It parses a prompt `git` rule and a forbidden `git commit` rule, evaluates `git commit -m hi`, and asserts the evaluation contains both matches but has overall `Decision::Forbidden`.

**Call relations**: Directly validates `Evaluation::from_matches` severity aggregation over multiple prefix matches.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `strictest_decision_across_multiple_commands`  (lines 597–645)

```
fn strictest_decision_across_multiple_commands() -> Result<()>
```

**Purpose**: Checks that batch evaluation across several commands aggregates all matches and still chooses the strictest decision globally. Duplicate prompt matches from different commands are preserved.

**Data flow**: It parses the same overlapping `git` rules as the previous test, builds a vector of two commands, calls `policy.check_multiple`, and asserts the resulting evaluation contains three matches total and overall `Decision::Forbidden`.

**Call relations**: Exercises `Policy::check_multiple` and `check_multiple_with_options` rather than single-command evaluation.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `heuristics_match_is_returned_when_no_policy_matches`  (lines 648–663)

```
fn heuristics_match_is_returned_when_no_policy_matches()
```

**Purpose**: Ensures that an empty policy produces a heuristics match instead of an empty evaluation. This confirms the fallback contract for unmatched commands.

**Data flow**: It creates `Policy::empty()`, evaluates `python` with `prompt_all`, and asserts the result is an `Evaluation` containing one `HeuristicsRuleMatch` with `Decision::Prompt`.

**Call relations**: Covers the fallback branch in `Policy::matches_for_command_with_options` and aggregation into `Evaluation`.

*Call graph*: calls 1 internal fn (tokens); 2 external calls (assert_eq!, empty).


##### `parses_host_executable_paths`  (lines 666–696)

```
fn parses_host_executable_paths() -> Result<()>
```

**Purpose**: Verifies that `host_executable` declarations parse absolute paths, deduplicate repeated entries, and store them under the executable name. It checks the resulting typed path values directly.

**Data flow**: It constructs two absolute `git` paths, escapes them for Starlark, parses a `host_executable` declaration containing both plus a duplicate, builds the policy, and asserts the stored `git` mapping contains exactly the two unique `AbsolutePathBuf` values in order.

**Call relations**: Exercises parser-side host executable path parsing, basename validation, and deduplication.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


##### `host_executable_rejects_non_absolute_path`  (lines 699–711)

```
fn host_executable_rejects_non_absolute_path()
```

**Purpose**: Ensures relative paths are rejected in `host_executable` declarations. This preserves the invariant that host executable mappings are absolute and unambiguous.

**Data flow**: It parses `host_executable(name = "git", paths = ["git"])`, expects an error, and asserts the message mentions that paths must be absolute.

**Call relations**: Covers the parser helper `parse_literal_absolute_path` through the builtin error path.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `host_executable_rejects_name_with_path_separator`  (lines 714–727)

```
fn host_executable_rejects_name_with_path_separator()
```

**Purpose**: Ensures the declared executable name must be a bare basename rather than a full path. This prevents malformed lookup keys.

**Data flow**: It generates an absolute git path, embeds it as both `name` and path, parses the declaration expecting failure, and asserts the error mentions that the name must be a bare executable name.

**Call relations**: Exercises `validate_host_executable_name` through the parser builtin.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert!, format!).


##### `host_executable_rejects_path_with_wrong_basename`  (lines 730–739)

```
fn host_executable_rejects_path_with_wrong_basename()
```

**Purpose**: Ensures each declared host executable path has the same basename as the declared executable name. This prevents mismatched mappings like `name = git` pointing at `rg`.

**Data flow**: It generates an absolute `rg` path, embeds it in a `host_executable(name = "git", ...)` declaration, expects parsing to fail, and asserts the error mentions the required basename.

**Call relations**: Covers the parser builtin’s basename consistency check using executable lookup helpers.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert!, format!).


##### `host_executable_last_definition_wins`  (lines 742–767)

```
fn host_executable_last_definition_wins() -> Result<()>
```

**Purpose**: Verifies that when multiple parsed files define the same host executable name, the later definition replaces the earlier path list. This matches the builder’s `HashMap::insert` semantics.

**Data flow**: It parses one file mapping `git` to `/usr/bin/git`, then another mapping `git` to a Homebrew path, builds the policy, and asserts the stored mapping contains only the later path.

**Call relations**: Exercises multi-file parser accumulation specifically for host executable mappings rather than prefix rules.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


##### `host_executable_resolution_uses_basename_rule_when_allowed`  (lines 770–804)

```
fn host_executable_resolution_uses_basename_rule_when_allowed() -> Result<()>
```

**Purpose**: Checks that an absolute executable path can match basename-keyed rules when host executable resolution is enabled and the path is in the allowlist. The resulting match should record the resolved absolute program path.

**Data flow**: It builds a policy with `prefix_rule(pattern = ["git", "status"], decision = "prompt")` plus a matching `host_executable` declaration, evaluates `[absolute_git_path, "status"]` with `resolve_host_executables: true`, and asserts the result is a prompt `PrefixRuleMatch` whose `resolved_program` is `Some(absolute_path)`.

**Call relations**: Exercises the `match_host_executable_rules` branch and `RuleMatch::with_resolved_program` behavior.

*Call graph*: calls 4 internal fn (new, host_absolute_path, host_executable_name, starlark_string); 2 external calls (assert_eq!, format!).


##### `prefix_rule_examples_honor_host_executable_resolution`  (lines 807–828)

```
fn prefix_rule_examples_honor_host_executable_resolution() -> Result<()>
```

**Purpose**: Verifies that parse-time `match` and `not_match` example validation uses host executable resolution. A positive example with an allowed absolute path and a negative example with a different path should both validate successfully.

**Data flow**: It constructs allowed and disallowed absolute git paths, embeds them into a policy where the rule examples use those paths and a `host_executable` declaration allows only one of them, then parses the policy and expects success.

**Call relations**: Specifically covers the parser’s deferred example validation path using a temporary policy with `resolve_host_executables: true`.

*Call graph*: calls 4 internal fn (new, host_absolute_path, host_executable_name, starlark_string); 1 external calls (format!).


##### `host_executable_resolution_respects_explicit_empty_allowlist`  (lines 831–859)

```
fn host_executable_resolution_respects_explicit_empty_allowlist() -> Result<()>
```

**Purpose**: Ensures that an explicit empty `host_executable` path list blocks basename-based resolution rather than acting like no mapping. This lets policy authors intentionally disable host-path matching for a name.

**Data flow**: It parses a prompt `git` rule plus `host_executable(name = "git", paths = [])`, evaluates an absolute git path with host resolution enabled, and asserts the result falls through to a heuristics allow match instead of matching the basename rule.

**Call relations**: Exercises the allowlist check inside `match_host_executable_rules` where an existing mapping with no matching path causes an immediate no-match.

*Call graph*: calls 2 internal fn (new, host_absolute_path); 1 external calls (assert_eq!).


##### `host_executable_resolution_ignores_path_not_in_allowlist`  (lines 862–894)

```
fn host_executable_resolution_ignores_path_not_in_allowlist() -> Result<()>
```

**Purpose**: Checks that basename-based resolution is denied for absolute paths not present in a configured allowlist. Unlisted paths should behave as unmatched commands.

**Data flow**: It parses a prompt `git` rule plus a `host_executable` declaration allowing only one absolute path, evaluates a different absolute git path with host resolution enabled, and asserts the result is a heuristics allow match.

**Call relations**: Covers the negative allowlist branch of `match_host_executable_rules`.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


##### `host_executable_resolution_falls_back_without_mapping`  (lines 897–926)

```
fn host_executable_resolution_falls_back_without_mapping() -> Result<()>
```

**Purpose**: Ensures that when no `host_executable` mapping exists for a basename, absolute-path commands may still match basename rules if host resolution is enabled. The original path should still be recorded in the match.

**Data flow**: It parses only a prompt `git` rule, evaluates an absolute git path with host resolution enabled, and asserts the result is a prompt `PrefixRuleMatch` with `resolved_program: Some(absolute_path)`.

**Call relations**: Exercises the permissive branch in `match_host_executable_rules` where absence of a mapping does not block basename matching.

*Call graph*: calls 2 internal fn (new, host_absolute_path); 1 external calls (assert_eq!).


##### `host_executable_resolution_does_not_override_exact_match`  (lines 929–963)

```
fn host_executable_resolution_does_not_override_exact_match() -> Result<()>
```

**Purpose**: Verifies that exact first-token matches take precedence over host executable basename resolution. A literal absolute-path rule should win even if a basename rule and host mapping also exist.

**Data flow**: It parses a policy containing an allow rule keyed by the absolute git path, a prompt basename `git` rule, and a matching `host_executable` declaration, evaluates the absolute-path command with host resolution enabled, and asserts only the exact allow rule matches with `resolved_program: None`.

**Call relations**: Directly validates the precedence ordering implemented in `Policy::matches_for_command_with_options`: exact matches are attempted before host executable rewriting.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


### Legacy suite entrypoints
These files assemble the legacy execpolicy integration corpus into a single organized test suite and binary entrypoint.

### `execpolicy-legacy/tests/all.rs`

`test` · `test discovery and execution`

This file is intentionally minimal: it exists to make Cargo compile one integration test target that aggregates all test modules under `tests/suite/`. Rather than defining test logic itself, it declares `mod suite;`, causing Rust’s integration-test harness to load the nested module tree rooted at `tests/suite/mod.rs`. That arrangement consolidates formerly standalone integration tests into a shared binary, which can reduce duplicated setup and make common helpers or fixtures easier to share across modules.

Because integration tests are compiled as separate crates, this file acts as the crate root for the test binary. Its only responsibility is module inclusion; all actual assertions, fixtures, and scenario coverage live below it. The design choice here is organizational rather than behavioral: by centralizing test discovery through one root, the suite can be structured as ordinary Rust modules instead of many separate files each producing its own binary. There is no runtime state, control flow, or exported API beyond the implicit test harness behavior triggered by module inclusion.


### `execpolicy-legacy/tests/suite/mod.rs`

`test` · `test discovery and execution`

This module is the index for the integration test suite under `tests/suite/`. It declares each scenario-focused submodule—`bad`, `cp`, `good`, `head`, `literal`, `ls`, `parse_sed_command`, `pwd`, and `sed`—so the parent integration-test crate can compile and run them together. The file itself contains no test code, but it defines the suite’s structure and therefore controls which test files participate in the aggregated binary.

The naming of the submodules reflects the coverage split: some modules appear to group broad success/failure cases (`good`, `bad`), while others target specific commands or parsing behaviors (`cp`, `head`, `ls`, `pwd`, `sed`, `parse_sed_command`, `literal`). By collecting them here, the suite can share crate-level imports and helper visibility rules while keeping command-specific assertions isolated. There is no executable logic in this file beyond Rust’s module-loading semantics, but it is still important to the test lifecycle because removing or renaming a module declaration here changes which tests are compiled and discovered by the harness.


### Legacy corpus regressions
These regression tests validate that the curated default-policy good and bad command corpora remain accepted and rejected as intended.

### `execpolicy-legacy/tests/suite/bad.rs`

`test` · `test run`

This test file is intentionally small and focused: it loads the crate's default policy and asks that policy to evaluate each entry in its built-in bad list one by one. The expected result is an empty `Vec<NegativeExamplePassedCheck>`, meaning no supposedly bad example slipped through validation. By asserting exact equality with an empty vector rather than only checking length, the test makes the intended contract explicit: there should be zero recorded violations of the negative-example suite.

The file does not construct `ExecCall` values manually or inspect individual error variants. Instead, it exercises the policy's own aggregate self-check helper, which centralizes the list of known-bad commands and the logic for reporting any that unexpectedly pass. That makes this test a broad safety net over the shipped default policy rather than a unit test of one parser branch. Its main edge case is startup failure: if the default policy cannot be loaded, the test aborts immediately with `expect`, because no meaningful rejection audit can proceed without the canonical policy definition.

#### Function details

##### `verify_everything_in_bad_list_is_rejected`  (lines 5–9)

```
fn verify_everything_in_bad_list_is_rejected()
```

**Purpose**: Loads the default policy and verifies that its built-in negative examples produce no false accepts. It acts as a suite-level invariant check over the policy's rejection corpus.

**Data flow**: Calls `get_default_policy()` and unwraps the resulting policy with `expect`. It then invokes `policy.check_each_bad_list_individually()`, collects the returned `Vec<NegativeExamplePassedCheck>`, and asserts that it equals a newly constructed empty vector.

**Call relations**: This is a top-level test entry invoked by the Rust test harness. It depends on the external default-policy loader and then on the policy object's aggregate bad-list checker; the final `assert_eq!` is the only decision point, failing the test if any bad example was accepted.

*Call graph*: 2 external calls (assert_eq!, get_default_policy).


### `execpolicy-legacy/tests/suite/good.rs`

`test` · `test run`

This file mirrors the negative-example suite but for allowed commands. It loads the default policy, asks it to evaluate each built-in good example individually, and asserts that the resulting `Vec<PositiveExampleFailedCheck>` is empty. In other words, none of the examples that document intended safe usage should fail validation.

The test is intentionally aggregate rather than command-specific. It does not inspect `ValidExec` contents or individual error variants; instead, it trusts the policy object's own helper to iterate the positive corpus and report any failures in a structured way. That makes the file a broad compatibility check over the shipped policy definitions and examples. As with the bad-list test, policy loading is treated as a prerequisite: `expect` aborts immediately if the default policy cannot be constructed, because the suite's purpose is to validate the canonical policy bundle itself. The exact equality against an empty vector makes the success condition unambiguous and keeps any future failure output tied to the crate's dedicated `PositiveExampleFailedCheck` reporting type.

#### Function details

##### `verify_everything_in_good_list_is_allowed`  (lines 5–9)

```
fn verify_everything_in_good_list_is_allowed()
```

**Purpose**: Loads the default policy and verifies that all built-in positive examples pass checking. It serves as a suite-wide acceptance regression test.

**Data flow**: Calls `get_default_policy()` and unwraps it with `expect`, then invokes `policy.check_each_good_list_individually()` to obtain a `Vec<PositiveExampleFailedCheck>`. It asserts that this vector equals an empty vector.

**Call relations**: This function is run directly by the test harness. It delegates policy construction and aggregate example checking to external crate APIs, then uses a single assertion to fail if any documented good example is rejected.

*Call graph*: 2 external calls (assert_eq!, get_default_policy).


### Legacy command matchers
These command-specific matcher tests exercise default-policy handling for common commands, covering accepted normalization and precise rejection behavior.

### `execpolicy-legacy/tests/suite/cp.rs`

`test` · `test run`

This test module focuses on how the default policy interprets `cp` command lines. A shared `setup()` helper loads the default policy once per test invocation, keeping the individual tests concise. The negative cases establish the command's argument-shape rules: no arguments yields `Error::NotEnoughArgs` with the expected `ArgMatcher` sequence, while a single argument yields `Error::VarargMatcherDidNotMatchAnything`, reflecting that the source-file vararg matcher did not consume any values before the required destination.

The positive cases build explicit expected `MatchedExec::Match` values. For a two-argument copy, the first positional argument must validate as `ArgType::ReadableFile` and the second as `ArgType::WriteableFile`. For a three-argument copy, the first two are readable sources and the last is the writable destination. Both tests also verify that the accepted execution includes the preferred absolute binaries `/bin/cp` and `/usr/bin/cp`. By constructing expected `MatchedArg` values with their original indices, the tests confirm not just acceptance but the parser's exact positional bookkeeping and type assignment. Returning `Result<()>` in the success tests allows `MatchedArg::new` validation failures to propagate naturally during test setup.

#### Function details

##### `setup`  (lines 15–17)

```
fn setup() -> Policy
```

**Purpose**: Loads the default policy for the `cp` test cases. It centralizes the `expect` message so each test can focus on command-specific assertions.

**Data flow**: Calls `get_default_policy()` and unwraps the result with `expect("failed to load default policy")`, returning a concrete `Policy` value. It does not mutate shared state.

**Call relations**: This helper is called by every test in the file before constructing an `ExecCall`. It sits at the start of each test's flow and delegates all policy loading to the external default-policy factory.

*Call graph*: called by 4 (test_cp_multiple_files, test_cp_no_args, test_cp_one_arg, test_cp_one_file); 1 external calls (get_default_policy).


##### `test_cp_no_args`  (lines 20–31)

```
fn test_cp_no_args()
```

**Purpose**: Verifies that invoking `cp` with no positional arguments is rejected as having too few arguments. It checks the exact error payload, including the expected argument matcher sequence.

**Data flow**: Obtains a `Policy` via `setup()`, constructs `ExecCall::new("cp", &[])`, invokes `policy.check(&cp)`, and compares the result against `Err(Error::NotEnoughArgs { ... })` using `assert_eq!`.

**Call relations**: The test harness invokes this function as a standalone test. It depends on `setup` for policy initialization and on `ExecCall::new` to build the observed command, then exercises the policy checker and stops at the assertion.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_cp_one_arg`  (lines 34–45)

```
fn test_cp_one_arg()
```

**Purpose**: Checks that a single-argument `cp` call is rejected because the source-file vararg matcher cannot match a complete source/destination pattern. It documents the policy's interpretation of an incomplete copy command.

**Data flow**: Loads the policy with `setup()`, creates `ExecCall::new("cp", &["foo/bar"])`, runs `policy.check(&cp)`, and asserts equality with `Err(Error::VarargMatcherDidNotMatchAnything { program, matcher })`.

**Call relations**: This test is another direct harness entry. It follows the same setup-and-check pattern as the other `cp` tests, but targets the branch where argument matching fails after partial input.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_cp_one_file`  (lines 48–65)

```
fn test_cp_one_file() -> Result<()>
```

**Purpose**: Verifies that `cp source dest` is accepted and normalized into a `ValidExec` with one readable source and one writable destination. It also checks the preferred absolute executable paths.

**Data flow**: Calls `setup()` for a `Policy`, builds `ExecCall::new("cp", &["foo/bar", "../baz"])`, constructs the expected `MatchedExec::Match` using `ValidExec::new` and two validated `MatchedArg::new` values, asserts equality with `policy.check(&cp)`, and returns `Ok(())`.

**Call relations**: Invoked by the test harness for the successful two-argument case. It relies on `MatchedArg::new` and `ValidExec::new` to build the exact expected accepted-exec structure that `policy.check` should produce.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_cp_multiple_files`  (lines 68–86)

```
fn test_cp_multiple_files() -> Result<()>
```

**Purpose**: Verifies that `cp` with multiple source files and one destination is accepted with the correct per-position argument typing. It confirms that all but the final positional argument are treated as readable inputs and the last as the writable output.

**Data flow**: Loads the policy, creates `ExecCall::new("cp", &["foo", "bar", "baz"])`, builds an expected `MatchedExec::Match` containing three `MatchedArg` entries and the `/bin/cp` and `/usr/bin/cp` system paths, asserts equality with `policy.check(&cp)`, and returns `Ok(())`.

**Call relations**: This test extends the successful flow from `test_cp_one_file` to the vararg source-file case. It is called by the harness, uses `setup` first, and then compares the policy checker output against a fully specified expected match.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/head.rs`

`test` · `test run`

This module exercises a richer command shape than the simpler `ls` and `cp` suites because `head` accepts both positional file arguments and an option with a typed value. The shared `setup()` helper loads the default policy. `test_head_no_args` intentionally asserts rejection even though `head` itself can read from stdin; the comments explain that the policy is stricter because it only approves cases it can prove safe. `test_head_one_file_no_flags` verifies the straightforward accepted case: one positional argument typed as `ReadableFile` and canonical system paths `/bin/head` and `/usr/bin/head`.

`test_head_one_flag_one_file` checks the mixed option-plus-argument path. The expected `ValidExec` contains an empty `flags` vector, one `MatchedOpt` for `-n` with `ArgType::PositiveInteger`, and one `MatchedArg` for the file at argv index 2. The remaining tests probe numeric validation boundaries. Values `0`, `1.5`, and `1.0` all produce `Error::InvalidPositiveInteger`, showing that the policy requires a strictly positive integer string. The `-1` case is different: because it begins with `-`, the parser treats it as another option token rather than a value, yielding `Error::OptionFollowedByOptionInsteadOfValue`. Together these tests capture both semantic validation and tokenization behavior.

#### Function details

##### `setup`  (lines 16–18)

```
fn setup() -> Policy
```

**Purpose**: Loads the default policy used by all `head` tests. It hides the common initialization and failure message.

**Data flow**: Invokes `get_default_policy()`, unwraps the result with `expect`, and returns the resulting `Policy`. No persistent state is changed.

**Call relations**: Every test in this file calls `setup` first. It is the shared entry into the external policy-loading path before each command-specific assertion.

*Call graph*: called by 7 (test_head_invalid_n_as_0, test_head_invalid_n_as_float, test_head_invalid_n_as_negative_int, test_head_invalid_n_as_nonint_float, test_head_no_args, test_head_one_file_no_flags, test_head_one_flag_one_file); 1 external calls (get_default_policy).


##### `test_head_no_args`  (lines 21–39)

```
fn test_head_no_args()
```

**Purpose**: Verifies that the policy rejects `head` with no file arguments, even though the real command could read from stdin. It documents the policy's conservative stance on unverifiable stdin-based behavior.

**Data flow**: Gets a `Policy` from `setup()`, constructs `ExecCall::new("head", &[])`, runs `policy.check(&head)`, and asserts equality with `Err(Error::VarargMatcherDidNotMatchAnything { program, matcher: ArgMatcher::ReadableFiles })`.

**Call relations**: This harness-invoked test follows the standard setup/check/assert flow. Its comments explain why the asserted rejection is intentional despite the underlying command's broader semantics.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_one_file_no_flags`  (lines 42–60)

```
fn test_head_one_file_no_flags() -> Result<()>
```

**Purpose**: Checks that `head file` is accepted and represented as a single readable-file positional argument. It confirms the exact accepted-exec structure for the simplest safe `head` invocation.

**Data flow**: Loads the policy, creates `ExecCall::new("head", &["src/extension.ts"])`, builds the expected `MatchedExec::Match` using `ValidExec::new` and one validated `MatchedArg::new`, asserts equality with `policy.check(&head)`, and returns `Ok(())`.

**Call relations**: Called by the test harness for the basic success path. It depends on `setup` for policy loading and on the model constructors to express the exact normalized result expected from `policy.check`.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_one_flag_one_file`  (lines 63–86)

```
fn test_head_one_flag_one_file() -> Result<()>
```

**Purpose**: Verifies that `head -n 100 file` is accepted with `-n` parsed as an option carrying a positive-integer value and the file preserved as a readable positional argument. It checks both option typing and argv indexing.

**Data flow**: Obtains the policy, constructs `ExecCall::new("head", &["-n", "100", "src/extension.ts"])`, builds an expected `MatchedExec::Match` containing `MatchedOpt::new("-n", "100", ArgType::PositiveInteger)` and `MatchedArg::new(2, ArgType::ReadableFile, ...)`, asserts equality with `policy.check(&head)`, and returns `Ok(())`.

**Call relations**: This test exercises the branch where the checker recognizes an option/value pair before positional arguments. It uses `MatchedOpt::new` and `MatchedArg::new` to mirror the exact internal normalization that `policy.check` should perform.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_0`  (lines 89–98)

```
fn test_head_invalid_n_as_0()
```

**Purpose**: Checks that `-n 0` is rejected because zero is not considered a valid positive integer. It verifies the exact numeric-validation error variant.

**Data flow**: Calls `setup()`, creates `ExecCall::new("head", &["-n", "0", "src/extension.ts"])`, invokes `policy.check(&head)`, and asserts equality with `Err(Error::InvalidPositiveInteger { value: "0".to_string() })`.

**Call relations**: This test is run directly by the harness and targets the semantic validation path after option parsing succeeds. It depends on the policy checker to reject the value rather than the token shape.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_nonint_float`  (lines 101–110)

```
fn test_head_invalid_n_as_nonint_float()
```

**Purpose**: Verifies that a non-integer decimal string such as `1.5` is rejected for `-n`. It confirms that the policy does not coerce or truncate floating-point-looking values.

**Data flow**: Loads the policy, constructs `ExecCall::new("head", &["-n", "1.5", "src/extension.ts"])`, evaluates `policy.check(&head)`, and asserts equality with `Err(Error::InvalidPositiveInteger { value: "1.5".to_string() })`.

**Call relations**: This harness-driven test follows the same path as the zero case but with a different malformed numeric string. It documents another branch of the positive-integer validator's rejection behavior.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_float`  (lines 113–122)

```
fn test_head_invalid_n_as_float()
```

**Purpose**: Checks that a decimal-formatted whole number like `1.0` is still rejected for `-n`. It ensures the validator requires integer syntax, not merely a numerically positive value.

**Data flow**: Gets the policy from `setup()`, creates `ExecCall::new("head", &["-n", "1.0", "src/extension.ts"])`, runs `policy.check(&head)`, and asserts equality with `Err(Error::InvalidPositiveInteger { value: "1.0".to_string() })`.

**Call relations**: This test is another direct harness entry covering semantic validation after option parsing. It complements the `1.5` case by showing that even float strings representing whole numbers are not accepted.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_negative_int`  (lines 125–136)

```
fn test_head_invalid_n_as_negative_int()
```

**Purpose**: Verifies that `-n -1` is rejected as an option followed by another option-like token rather than as an invalid integer value. It captures the parser's tokenization rule for dash-prefixed strings.

**Data flow**: Loads the policy, constructs `ExecCall::new("head", &["-n", "-1", "src/extension.ts"])`, invokes `policy.check(&head)`, and asserts equality with `Err(Error::OptionFollowedByOptionInsteadOfValue { program, option, value })`.

**Call relations**: This test covers a distinct control-flow branch from the other invalid-number tests: the checker treats `-1` as syntactically option-like before numeric validation can run. It is invoked by the harness and depends on `setup` like the rest of the suite.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/ls.rs`

`test` · `test run`

This module is a broad command-specific test suite for `ls`. A shared `setup()` helper loads the default policy. The tests establish that `ls` with no arguments is accepted, producing a `ValidExec` with no flags or args and preferred system paths `/bin/ls` and `/usr/bin/ls`. Known flags `-a` and `-l` are accepted and stored as `MatchedFlag` entries in order. Unknown options are rejected precisely: `-z` yields `Error::UnknownOption`, and bundled `-al` also yields `UnknownOption`, with a comment noting that this should change only if option bundling is explicitly implemented.

The positional-argument tests verify that one or many file operands are typed as `ArgType::ReadableFile` with their original indices preserved. Mixed tests confirm that flags and file args can coexist in the accepted result, and that the checker currently still accepts flags appearing after file arguments. The comment on `test_flags_after_file_args` highlights an intentional discrepancy between policy acceptance and actual `ls` CLI behavior: the invocation is considered safe enough by the current policy model even if the real command may not parse it as intended. Across the suite, expected values are built concretely with `MatchedFlag::new`, `MatchedArg::new`, and either `ValidExec::new` or struct literals using `..Default::default()` to emphasize exactly which fields should be populated.

#### Function details

##### `setup`  (lines 15–17)

```
fn setup() -> Policy
```

**Purpose**: Loads the default policy used by all `ls` tests. It provides a single initialization point and consistent failure message.

**Data flow**: Calls `get_default_policy()`, unwraps the result with `expect`, and returns the resulting `Policy`. It has no side effects beyond test-local initialization.

**Call relations**: Every test in this file begins by calling `setup`. It is the shared dependency that feeds the policy checker used in all subsequent assertions.

*Call graph*: called by 8 (test_flags_after_file_args, test_ls_dash_a_dash_l, test_ls_dash_al, test_ls_dash_z, test_ls_multiple_file_args, test_ls_multiple_flags_and_file_args, test_ls_no_args, test_ls_one_file_arg); 1 external calls (get_default_policy).


##### `test_ls_no_args`  (lines 20–29)

```
fn test_ls_no_args()
```

**Purpose**: Verifies that bare `ls` is accepted with no matched flags or positional arguments. It checks the canonical system-path list included in the accepted execution.

**Data flow**: Obtains a policy via `setup()`, constructs `ExecCall::new("ls", &[])`, invokes `policy.check(&ls)`, and asserts equality with `Ok(MatchedExec::Match { exec: ValidExec::new("ls", vec![], &["/bin/ls", "/usr/bin/ls"]) })`.

**Call relations**: This harness-run test covers the simplest success path for `ls`. It uses `setup` and `ExecCall::new`, then compares the checker output against a minimal expected `ValidExec`.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_dash_a_dash_l`  (lines 32–47)

```
fn test_ls_dash_a_dash_l()
```

**Purpose**: Checks that two known flags, `-a` and `-l`, are accepted and preserved as matched flags in order. It verifies flag-only normalization without positional arguments.

**Data flow**: Loads the policy, creates `ExecCall::new("ls", &["-a", "-l"])`, builds an expected `ValidExec` struct literal with `flags: vec![MatchedFlag::new("-a"), MatchedFlag::new("-l")]`, system paths, and defaulted remaining fields, then asserts equality with `policy.check(&ls_a_l)`.

**Call relations**: This test is invoked by the harness and exercises the branch where the checker recognizes multiple allowed flags. It depends on `MatchedFlag::new` to express the exact expected normalized output.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_dash_z`  (lines 50–63)

```
fn test_ls_dash_z()
```

**Purpose**: Verifies that an unsupported `ls` option is rejected as `UnknownOption`. It documents the current allowlist boundary for recognized flags.

**Data flow**: Calls `setup()`, constructs `ExecCall::new("ls", &["-z"])`, runs `policy.check(&ls_z)`, and asserts equality with `Err(Error::UnknownOption { program: "ls".into(), option: "-z".into() })`.

**Call relations**: This harness-driven test covers the unknown-option rejection path after policy loading. Its comment notes that the real command's option set could evolve, but the policy currently rejects this token.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_dash_al`  (lines 66–78)

```
fn test_ls_dash_al()
```

**Purpose**: Checks that bundled short options like `-al` are currently rejected as a single unknown option. It captures the present behavior before any future option-bundling support is added.

**Data flow**: Loads the policy, creates `ExecCall::new("ls", &["-al"])`, invokes `policy.check(&ls_al)`, and asserts equality with `Err(Error::UnknownOption { program: "ls".into(), option: "-al".into() })`.

**Call relations**: This test is called by the harness and targets a specific parser limitation documented in the inline comment. It follows the same setup/check/assert pattern as the other rejection tests.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_one_file_arg`  (lines 81–100)

```
fn test_ls_one_file_arg() -> Result<()>
```

**Purpose**: Verifies that `ls foo` is accepted with one readable-file positional argument. It confirms the exact argument typing and index assignment for a single operand.

**Data flow**: Gets the policy from `setup()`, constructs `ExecCall::new("ls", &["foo"])`, builds the expected `MatchedExec::Match` using `ValidExec::new` and `MatchedArg::new(0, ArgType::ReadableFile, "foo")`, asserts equality with `policy.check(&ls_one_file_arg)`, and returns `Ok(())`.

**Call relations**: This harness-invoked test exercises the accepted positional-argument path. It relies on the model constructors to mirror the exact normalized result expected from the checker.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_multiple_file_args`  (lines 103–122)

```
fn test_ls_multiple_file_args() -> Result<()>
```

**Purpose**: Checks that multiple file operands are all accepted as readable positional arguments. It verifies that each argv position is preserved in the resulting `ValidExec`.

**Data flow**: Loads the policy, creates `ExecCall::new("ls", &["foo", "bar", "baz"])`, constructs an expected `ValidExec::new` with three `MatchedArg::new` values at indices 0, 1, and 2, asserts equality with `policy.check(&ls_multiple_file_args)`, and returns `Ok(())`.

**Call relations**: This test extends the single-file success path to the vararg case. It is run by the harness and depends on `setup` plus the argument constructors to define the expected match.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_multiple_flags_and_file_args`  (lines 125–146)

```
fn test_ls_multiple_flags_and_file_args() -> Result<()>
```

**Purpose**: Verifies that `ls` accepts a mix of known flags followed by multiple file operands. It checks that flags and positional arguments are separated correctly in the normalized result.

**Data flow**: Obtains the policy, constructs `ExecCall::new("ls", &["-l", "-a", "foo", "bar", "baz"])`, builds an expected `ValidExec` with two `MatchedFlag`s and three `MatchedArg`s at indices 2 through 4 plus system paths, asserts equality with `policy.check(&ls_multiple_flags_and_file_args)`, and returns `Ok(())`.

**Call relations**: This harness-run test covers the branch where the checker processes multiple flags before positional arguments. It combines the behaviors validated separately in the flag-only and file-only tests.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_flags_after_file_args`  (lines 149–175)

```
fn test_flags_after_file_args() -> Result<()>
```

**Purpose**: Checks the current policy behavior when a flag appears after a file operand: the invocation is still accepted and normalized with the file as an argument and the later token as a flag. It documents a known mismatch between policy permissiveness and actual `ls` parsing expectations.

**Data flow**: Loads the policy, creates `ExecCall::new("ls", &["foo", "-l"])`, builds an expected `ValidExec` containing one `MatchedArg` at index 0 and one `MatchedFlag` for `-l`, asserts equality with `policy.check(&ls_flags_after_file_args)`, and returns `Ok(())`.

**Call relations**: This test is invoked by the harness and targets an edge case called out in the comment. It demonstrates that the checker currently classifies the command as safe and accepted even though future configuration may choose to disallow this ordering.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/pwd.rs`

`test` · `policy matching tests`

This test file is a focused regression suite for how the legacy policy interprets `pwd` invocations. It imports the concrete matching and error types from `codex_execpolicy_legacy` and compares `policy.check(&ExecCall)` results against fully constructed expected values, so the tests pin down not just success or failure but the exact `MatchedExec` or `Error` payload shape. A shared `setup` helper loads the default policy once per test via `get_default_policy`, failing the test immediately if the bundled policy cannot be loaded.

The success cases cover three command forms: bare `pwd`, `pwd -L`, and `pwd -P`. In each case the expected match is a `MatchedExec::Match` containing a `ValidExec` with `program: "pwd"` and, for the flagged variants, a single `MatchedFlag` entry. The tests rely on `Default::default()` for all other `ValidExec` fields, which implicitly asserts that no extra args, opts, or path overrides are produced for these forms. The failure case constructs `pwd foo bar` and expects `Error::UnexpectedArguments` with two `PositionalArg` values preserving both original order and indexes 0 and 1. That makes this file valuable as a specification of argument indexing and strict rejection of stray operands.

#### Function details

##### `setup`  (lines 15–17)

```
fn setup() -> Policy
```

**Purpose**: Loads the default legacy policy used by all tests in this file. It converts policy-loading failure into an immediate test panic with a fixed message.

**Data flow**: Takes no arguments. It calls `get_default_policy()` from the legacy crate, unwraps the returned result with `expect`, and returns the resulting `Policy` value without modifying shared state.

**Call relations**: This helper is invoked at the start of every `pwd` test so each case evaluates against the same default policy baseline before constructing an `ExecCall` and asserting on `policy.check` output.

*Call graph*: called by 4 (test_pwd_capital_l, test_pwd_capital_p, test_pwd_extra_args, test_pwd_no_args); 1 external calls (get_default_policy).


##### `test_pwd_no_args`  (lines 20–32)

```
fn test_pwd_no_args()
```

**Purpose**: Verifies that a plain `pwd` invocation matches the policy with no flags or arguments attached. The assertion fixes the expected `ValidExec.program` value to `pwd` and leaves all other fields at defaults.

**Data flow**: Creates a `Policy` via `setup`, then builds an `ExecCall` for program `pwd` with an empty argument slice. It compares `policy.check(&pwd)` against `Ok(MatchedExec::Match { exec: ValidExec { program: "pwd".into(), ..Default::default() } })` and returns unit through the test harness.

**Call relations**: The Rust test runner invokes this case directly. Inside the test, control flows from `setup` to `ExecCall::new`, then into the assertion that validates the policy engine's result for the simplest accepted form.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_pwd_capital_l`  (lines 35–48)

```
fn test_pwd_capital_l()
```

**Purpose**: Checks that `pwd -L` is accepted and that the matcher records `-L` specifically as a matched flag. It distinguishes this accepted flag from positional arguments or other option encodings.

**Data flow**: Obtains a `Policy` from `setup`, constructs `ExecCall::new("pwd", &["-L"])`, and asserts equality with a successful `MatchedExec::Match` whose `ValidExec` contains `program: "pwd"` and `flags: vec![MatchedFlag::new("-L")]`.

**Call relations**: Called by the test harness as one of the `pwd` acceptance cases. It follows the same setup-and-assert pattern as the other tests, specializing only the command tokens and expected matched flag payload.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_pwd_capital_p`  (lines 51–64)

```
fn test_pwd_capital_p()
```

**Purpose**: Checks that `pwd -P` is accepted and represented as a single matched flag in the validated execution. This complements the `-L` case to document both supported `pwd` flag variants.

**Data flow**: Loads the default `Policy`, creates an `ExecCall` for `pwd` with one argument `-P`, and asserts that `policy.check` returns `Ok(MatchedExec::Match { exec: ValidExec { program: "pwd".into(), flags: vec![MatchedFlag::new("-P")], ..Default::default() } })`.

**Call relations**: The test harness invokes it independently. It reuses `setup` and `ExecCall::new`, then validates that the policy engine classifies `-P` as an allowed flag rather than rejecting or reinterpreting it.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_pwd_extra_args`  (lines 67–86)

```
fn test_pwd_extra_args()
```

**Purpose**: Verifies that extra positional operands after `pwd` are rejected with `UnexpectedArguments`, including exact indexes and values. It documents that `pwd` does not silently ignore trailing tokens.

**Data flow**: Builds a `Policy` with `setup`, creates `ExecCall::new("pwd", &["foo", "bar"])`, and compares `policy.check(&pwd)` to `Err(Error::UnexpectedArguments { program: "pwd".to_string(), args: vec![PositionalArg { index: 0, value: "foo".to_string() }, PositionalArg { index: 1, value: "bar".to_string() }] })`.

**Call relations**: Invoked by the test harness as the negative case for this file. It depends on `setup` for policy loading and uses a full structural equality assertion to pin down the exact error variant and positional metadata emitted by the checker.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### Legacy custom and sed parsing
These tests focus on specialized matching behavior, including literal positional matching, standalone sed parsing, and full sed policy enforcement.

### `execpolicy-legacy/tests/suite/literal.rs`

`test` · `test run`

This file builds a tiny policy from an inline source string rather than using the default policy bundle. The policy defines a fake executable whose two positional arguments must be the exact literals `subcommand` and `sub-subcommand`. The test then exercises both the success and failure paths against that custom policy.

The setup sequence is important: `PolicyParser::new` receives a synthetic policy name and the raw policy text, and `parse()` produces a policy object used for subsequent checks. For the valid call, the test constructs an expected `MatchedExec::Match` whose `ValidExec` contains two `MatchedArg` entries typed as `ArgType::Literal(...)`, preserving both the literal payload and the original positional indices. For the invalid call, only the second argument differs, and the expected result is `Error::LiteralValueDidNotMatch` with both the expected and actual strings captured. This makes the test a precise specification of literal matching semantics: literals are not pattern prefixes or enums, but exact string equality checks tied to specific argument positions. Returning `Result<()>` allows the expected `MatchedArg::new` constructions to use `?` during test assembly.

#### Function details

##### `test_invalid_subcommand`  (lines 13–54)

```
fn test_invalid_subcommand() -> Result<()>
```

**Purpose**: Parses a custom policy with literal positional arguments, then verifies one exact-match invocation succeeds and one mismatched invocation fails with the literal-specific error. It is the focused regression test for `ArgType::Literal` behavior.

**Data flow**: Creates an inline policy string, constructs `PolicyParser::new("test_invalid_subcommand", unparsed_policy)`, parses it into a policy, builds a valid `ExecCall` and asserts that `policy.check` returns a `MatchedExec::Match` containing two literal-typed `MatchedArg`s inside `ValidExec::new`, then builds an invalid `ExecCall` and asserts that `policy.check` returns `Err(Error::LiteralValueDidNotMatch { expected, actual })`. It returns `Ok(())` after both assertions pass.

**Call relations**: This test is invoked directly by the harness and does not use the default-policy loader. It first drives the parser path to create a policy, then exercises the checker twice—once for the accepted exact-literal branch and once for the mismatch branch.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/parse_sed_command.rs`

`test` · `test run`

This file focuses narrowly on `parse_sed_command`, a helper that decides whether a sed editing command is provably safe. The first test establishes a known-good baseline: the address-range print command `122,202p` must parse successfully and return `Ok(())`. The second test checks two malformed variants that omit the trailing print command character or the separating comma semantics expected by the parser, and both must produce `Error::SedCommandNotProvablySafe` carrying the original command string.

Because the tests call the parser directly, they bypass policy files, `ExecCall`, and `ValidExec` construction entirely. That makes this suite useful for pinning down the parser's own acceptance boundary independent of any command-line wrapper logic. The assertions are exact, including the embedded `command` field in the error, so any future change in parser diagnostics or accepted grammar will surface immediately. The file therefore acts as a compact specification of the currently supported safe sed subset: a simple numeric range followed by `p` is accepted, while superficially similar but incomplete strings are not.

#### Function details

##### `parses_simple_print_command`  (lines 5–7)

```
fn parses_simple_print_command()
```

**Purpose**: Verifies that a simple sed print command with a numeric range is accepted by the safety parser. It establishes a concrete known-good example.

**Data flow**: Calls `parse_sed_command("122,202p")` and asserts that the returned result is exactly `Ok(())`. It reads no external state and writes no outputs beyond the test assertion.

**Call relations**: This function is invoked directly by the test harness. It exercises the parser's success path and stops at the equality assertion.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_malformed_print_command`  (lines 10–23)

```
fn rejects_malformed_print_command()
```

**Purpose**: Checks that malformed sed command strings lacking the accepted safe form are rejected with `SedCommandNotProvablySafe`. It covers two distinct invalid inputs in one test.

**Data flow**: Calls `parse_sed_command("122,202")` and `parse_sed_command("122202")` separately, asserting each result equals `Err(Error::SedCommandNotProvablySafe { command: ... })` with the original input copied into the error payload.

**Call relations**: This harness-run test exercises the parser's rejection path twice. It does not depend on any setup helper; its only external interaction is direct invocation of `parse_sed_command` followed by exact assertions.

*Call graph*: 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/sed.rs`

`test` · `policy matching tests`

This file is a targeted test suite for the legacy `sed` policy rules. Like the `pwd` tests, it loads the default policy through a shared `setup` helper and then constructs concrete `ExecCall` values whose results are compared against exact `MatchedExec` or `Error` structures. The tests are more detailed because `sed` has both flags and typed arguments/options: they assert not only that a command matches, but that the matcher classifies tokens into `MatchedFlag`, `MatchedOpt`, and `MatchedArg` with the correct `ArgType` and original token indexes.

The first success case covers `sed -n 122,202p hello.txt`, expecting `-n` as a flag, the script `122,202p` as a positional `ArgType::SedCommand` at index 1, and `hello.txt` as a `ReadableFile` at index 2, plus a fixed `system_path` of `/usr/bin/sed`. The second success case checks the alternate `-e` form, where the script moves from positional args into `opts` as `MatchedOpt::new("-e", "122,202p", ArgType::SedCommand)`, and the file shifts to index 3. The negative tests pin down two policy constraints: shell-executing sed expressions such as `s/y/echo hi/e` are rejected as `SedCommandNotProvablySafe`, and a bare script token without `-e` or the required pattern form yields `MissingRequiredOptions` naming `-e` explicitly.

#### Function details

##### `setup`  (lines 16–18)

```
fn setup() -> Policy
```

**Purpose**: Loads the default legacy policy used by all `sed` tests. It treats failure to load that policy as a fatal test setup error.

**Data flow**: Accepts no inputs. It calls `get_default_policy()`, unwraps the result with `expect("failed to load default policy")`, and returns the resulting `Policy`.

**Call relations**: Every test in this file begins by calling `setup`, ensuring all `sed` scenarios are evaluated against the same default policy contents before constructing command tokens.

*Call graph*: called by 4 (test_sed_print_specific_lines, test_sed_print_specific_lines_with_e_flag, test_sed_reject_dangerous_command, test_sed_verify_e_or_pattern_is_required); 1 external calls (get_default_policy).


##### `test_sed_print_specific_lines`  (lines 21–40)

```
fn test_sed_print_specific_lines() -> Result<()>
```

**Purpose**: Checks that `sed -n 122,202p hello.txt` is accepted as a safe read-only command and that each token is typed and indexed correctly. It also verifies the resolved system path recorded in the validated execution.

**Data flow**: Creates a `Policy` via `setup`, then an `ExecCall` for `sed` with `-n`, `122,202p`, and `hello.txt`. It asserts equality with `Ok(MatchedExec::Match { exec: ValidExec { program: "sed".to_string(), flags: vec![MatchedFlag::new("-n")], args: vec![MatchedArg::new(1, ArgType::SedCommand, "122,202p")?, MatchedArg::new(2, ArgType::ReadableFile, "hello.txt")?], system_path: vec!["/usr/bin/sed".to_string()], ..Default::default() } })`, then returns `Ok(())`.

**Call relations**: The test harness invokes this positive case directly. It uses `setup` for policy loading and relies on `MatchedArg::new` validation while constructing the expected value, mirroring the policy engine's own typed interpretation of the command.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_sed_print_specific_lines_with_e_flag`  (lines 43–66)

```
fn test_sed_print_specific_lines_with_e_flag() -> Result<()>
```

**Purpose**: Verifies the alternate `sed -n -e 122,202p hello.txt` form, where the script is attached to the `-e` option rather than treated as a positional command argument. It confirms that token indexing shifts accordingly.

**Data flow**: Loads the `Policy`, builds `ExecCall::new("sed", &["-n", "-e", "122,202p", "hello.txt"])`, and asserts that `policy.check` returns a `MatchedExec::Match` whose `ValidExec` has `flags: vec![MatchedFlag::new("-n")]`, `opts: vec![MatchedOpt::new("-e", "122,202p", ArgType::SedCommand).expect("should validate")]`, `args: vec![MatchedArg::new(3, ArgType::ReadableFile, "hello.txt")?]`, and `system_path: vec!["/usr/bin/sed".to_string()]`. It returns `Ok(())`.

**Call relations**: Called by the test harness as the second acceptance case. It follows the same setup/assert structure as the previous test but specifically exercises the branch where the sed script is consumed by an option parser instead of positional argument matching.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_sed_reject_dangerous_command`  (lines 69–78)

```
fn test_sed_reject_dangerous_command()
```

**Purpose**: Ensures that a sed expression containing the `e` execution flag is rejected as unsafe. This test documents that the policy performs semantic safety checks on sed commands, not just token-shape validation.

**Data flow**: Obtains a `Policy` from `setup`, constructs `ExecCall::new("sed", &["-e", "s/y/echo hi/e", "hello.txt"])`, and asserts that `policy.check(&sed)` equals `Err(Error::SedCommandNotProvablySafe { command: "s/y/echo hi/e".to_string() })`.

**Call relations**: The test harness invokes this negative case directly. It uses `setup` and `ExecCall::new`, then checks that the policy engine rejects the command before producing any successful `MatchedExec` structure.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_sed_verify_e_or_pattern_is_required`  (lines 81–91)

```
fn test_sed_verify_e_or_pattern_is_required()
```

**Purpose**: Checks that a lone sed script token without the required option structure is rejected with a missing-options error naming `-e`. It captures the policy's requirement that command syntax be explicit enough to classify safely.

**Data flow**: Creates a `Policy` with `setup`, builds `ExecCall::new("sed", &["122,202p"])`, and asserts equality with `Err(Error::MissingRequiredOptions { program: "sed".to_string(), options: vec!["-e".to_string()] })`.

**Call relations**: Invoked by the test harness as a syntax-validation failure case. It complements the successful script-matching tests by showing the branch where the checker refuses to infer a valid sed command form from insufficient tokens.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).
