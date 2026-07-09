# legacy and current execpolicy executable tests  `stage-23.3.4`

This stage is behind-the-scenes safety checking for the execution policy, the part of the system that decides whether a shell command may run, must be blocked, or needs user approval. It is not the main work loop itself; it is the test harness that proves the rules behave as expected.

The current tests check both the policy engine and its command-line face. One test runs `codex execpolicy check` and confirms it reports JSON correctly when a rule blocks something risky like `git push`. Another checks policy files directly, making sure commands are sorted into allowed, denied, forbidden, or prompt-needed results.

The legacy tests act like an older library of examples that must still pass. A top-level test file and module list gather the suite. “Good” and “bad” command lists protect broad expectations. Command-specific tests then inspect known Unix tools: `cp`, `head`, `ls`, `pwd`, literal subcommands, and narrow safe forms of `sed`. Together they form a regression net, catching accidental changes that would make the policy too strict or too loose.

## Files in this stage

### Current execpolicy integration
These tests cover the current execpolicy runtime and CLI-facing integration behavior, from core parser/runtime scenarios to executable JSON output checks.

### `cli/tests/execpolicy.rs`

`test` · `test run`

This is an integration test file. Instead of testing one small Rust function directly, it runs the real `codex` command-line program the way a user would run it. The problem it guards against is simple but important: execution policy rules are only useful if the command-line checker reads them correctly and reports the decision in a stable format that other tools can trust.

Each test creates a temporary fake Codex home directory, writes a small policy file into it, then runs `codex execpolicy check --rules ... git push origin main`. The policy says that any command beginning with `git push` is forbidden. The test then reads the program's standard output as JSON and compares it to the exact JSON structure expected.

The two tests cover a small but meaningful difference. One checks the basic blocked-command response. The other checks that, when the rule includes a human explanation called a justification, that explanation appears in the JSON too. This matters because callers may show that message to users so they understand why something was blocked. The temporary directory keeps the tests isolated, like using a clean sandbox so no real user configuration affects the result.

#### Function details

##### `execpolicy_check_matches_expected_json`  (lines 9–61)

```
fn execpolicy_check_matches_expected_json() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: This test proves that `codex execpolicy check` correctly reports a forbidden decision when a rule matches the start of a command. It also checks that the JSON output contains the matched prefix and decision in the expected shape.

**Data flow**: The test starts with no real user configuration and creates a temporary Codex home directory. It writes a policy file saying that commands starting with `git push` are forbidden. It then runs the `codex` binary with that rules file and the sample command `git push origin main`. The command's output is parsed as JSON, and the test compares it with the exact expected JSON object. If the program exits successfully and the JSON matches, the test passes; otherwise it fails.

**Call relations**: During the test run, the Rust test harness calls this function. The function uses temporary-directory and file-writing helpers to build a small test environment, then uses the command-testing library to launch the real `codex` binary. After the external command returns, it hands the stdout bytes to JSON parsing and finally to an equality assertion, which is the pass-or-fail check.

*Call graph*: 8 external calls (new, assert!, assert_eq!, new, cargo_bin, create_dir_all, write, from_slice).


##### `execpolicy_check_includes_justification_when_present`  (lines 64–119)

```
fn execpolicy_check_includes_justification_when_present() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: This test proves that a policy rule's explanation is not lost when `codex execpolicy check` reports a match. It checks that the JSON output includes the `justification` text alongside the forbidden decision.

**Data flow**: The test creates a fresh temporary Codex home directory and writes a policy file with a `git push` blocking rule plus the explanation `pushing is blocked in this repo`. It runs the `codex` binary against the command `git push origin main`. The program's stdout is parsed into JSON, then compared with the expected JSON that includes the decision, the matched prefix, and the justification text. The temporary files disappear after the test finishes.

**Call relations**: The test harness calls this function as part of the integration test suite. Like the companion test, it prepares a throwaway policy file, launches the real command-line program through the command-testing helper, and then passes the output through JSON parsing before the final assertion. Its special role is to cover the path where a matched rule carries an extra user-facing explanation.

*Call graph*: 8 external calls (new, assert!, assert_eq!, new, cargo_bin, create_dir_all, write, from_slice).


### `execpolicy/tests/basic.rs`

`test` · `test run`

The execution policy system is a safety gate for commands. A policy can say things like “git status is okay,” “rm is forbidden,” or “this full path counts as the git program.” This test file acts like a checklist for that gate. It feeds small policy snippets into the parser, asks the built policy to judge example commands, and compares the result with the expected answer.

The tests cover prefix rules, where a command is matched by its starting words, such as `git commit`. They also cover explanations attached to rules, network access rules, example commands that must or must not match, and the rule that the strictest decision wins when several rules apply. For example, a broad `git` rule may prompt, while a narrower `git commit` rule may forbid; the final answer must be forbidden.

A large part of the file checks host executable resolution. That means recognizing that `/usr/bin/git` may be the same intended program as `git`, but only when the policy allows that path. This matters because command safety depends not just on the name typed, but on which actual program is being run. Without these tests, small parser or matching changes could silently weaken the safety rules.

#### Function details

##### `tokens`  (lines 26–28)

```
fn tokens(cmd: &[&str]) -> Vec<String>
```

**Purpose**: Turns a short list of string slices into owned command words. Tests use it to write command examples compactly, like `git status`, while still giving the policy checker the owned strings it expects.

**Data flow**: It receives a borrowed list of text pieces. It copies each piece into a new `String` and returns a vector of those strings. It does not change anything outside itself.

**Call relations**: Many tests call this helper before checking a policy. It prepares the command shape that functions such as `basic_match`, `add_prefix_rule_extends_policy`, and host matching tests pass into the policy checker.

*Call graph*: called by 11 (add_prefix_rule_extends_policy, append_allow_prefix_rule_dedupes_existing_rule, basic_match, heuristics_match_is_returned_when_no_policy_matches, justification_can_be_used_with_allow_decision, justification_is_attached_to_forbidden_matches, match_and_not_match_examples_are_enforced, only_first_token_alias_expands_to_multiple_rules, parses_multiple_policy_files, strictest_decision_wins_across_matches (+1 more)).


##### `allow_all`  (lines 30–32)

```
fn allow_all(_: &[String]) -> Decision
```

**Purpose**: Provides a fallback answer of “allow” when no policy rule matches. Tests use it to make clear whether an allow decision came from fallback behavior or from a real rule.

**Data flow**: It receives a command, ignores its contents, and returns `Decision::Allow`. Nothing else is read or changed.

**Call relations**: Policy checks call this callback only when they need the heuristic fallback decision. Tests pass it into policy checking so unmatched commands are treated as allowed.


##### `prompt_all`  (lines 34–36)

```
fn prompt_all(_: &[String]) -> Decision
```

**Purpose**: Provides a fallback answer of “prompt” when no policy rule matches. Tests use it to verify that explicit allow rules can override a cautious fallback.

**Data flow**: It receives a command, ignores it, and returns `Decision::Prompt`. It has no side effects.

**Call relations**: Policy checks use this as their fallback decision provider in tests that need unmatched commands to require user confirmation.


##### `absolute_path`  (lines 38–40)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Converts a text path into the project’s absolute-path type for comparisons in tests. It makes expected results match the same type used by policy internals.

**Data flow**: It takes a path string, tries to convert it into an `AbsolutePathBuf`, and returns that value. If the input is not absolute, the test fails immediately.

**Call relations**: Host executable tests use this helper when comparing resolved program paths returned by the policy. It relies on the absolute-path conversion routine to enforce that the test data is valid.

*Call graph*: calls 1 internal fn (try_from).


##### `host_absolute_path`  (lines 42–52)

```
fn host_absolute_path(segments: &[&str]) -> String
```

**Purpose**: Builds an absolute path that works on the operating system running the tests. This avoids hard-coding Unix-style paths on Windows or Windows-style paths on Unix.

**Data flow**: It starts with the platform root, such as `/` or `C:\`, appends each requested path segment, and returns the resulting path as text.

**Call relations**: Host executable tests call this whenever they need realistic full paths like `/usr/bin/git`. It uses platform detection so the same tests can run across operating systems.

*Call graph*: called by 10 (host_executable_last_definition_wins, host_executable_rejects_name_with_path_separator, host_executable_rejects_path_with_wrong_basename, host_executable_resolution_does_not_override_exact_match, host_executable_resolution_falls_back_without_mapping, host_executable_resolution_ignores_path_not_in_allowlist, host_executable_resolution_respects_explicit_empty_allowlist, host_executable_resolution_uses_basename_rule_when_allowed, parses_host_executable_paths, prefix_rule_examples_honor_host_executable_resolution); 2 external calls (from, cfg!).


##### `host_executable_name`  (lines 54–60)

```
fn host_executable_name(name: &str) -> String
```

**Purpose**: Returns the executable file name for the current platform. On Windows it adds `.exe`, while on other systems it leaves the name alone.

**Data flow**: It receives a bare program name and returns the platform-appropriate executable name string.

**Call relations**: Tests that build actual executable paths call this before passing the name into `host_absolute_path`. This keeps path-basename checks accurate on Windows and non-Windows systems.

*Call graph*: called by 2 (host_executable_resolution_uses_basename_rule_when_allowed, prefix_rule_examples_honor_host_executable_resolution); 2 external calls (cfg!, format!).


##### `starlark_string`  (lines 62–64)

```
fn starlark_string(value: &str) -> String
```

**Purpose**: Escapes a string so it can be safely inserted into a Starlark policy snippet. Starlark is the small configuration language used for these rule files.

**Data flow**: It receives plain text, doubles backslashes, escapes quotation marks, and returns the escaped text. This prevents generated policy strings from breaking when paths contain special characters.

**Call relations**: Tests that create policy text with host paths call this before using string formatting. It prepares values that are then parsed by `PolicyParser`.

*Call graph*: called by 8 (host_executable_last_definition_wins, host_executable_rejects_name_with_path_separator, host_executable_rejects_path_with_wrong_basename, host_executable_resolution_does_not_override_exact_match, host_executable_resolution_ignores_path_not_in_allowlist, host_executable_resolution_uses_basename_rule_when_allowed, parses_host_executable_paths, prefix_rule_examples_honor_host_executable_resolution).


##### `rule_snapshots`  (lines 71–83)

```
fn rule_snapshots(rules: &[RuleRef]) -> Vec<RuleSnapshot>
```

**Purpose**: Turns stored rule references into plain comparable snapshots for assertions. This lets tests check the exact rules inside a policy without depending on shared reference wrappers.

**Data flow**: It receives a list of rule references, looks at each rule’s concrete type, clones prefix rules into `RuleSnapshot::Prefix`, and returns the snapshot list. If an unexpected rule type appears, the test fails.

**Call relations**: Several parser and rule-addition tests call this after building a policy. It bridges the policy’s internal rule storage and the simple expected values used in assertions.

*Call graph*: called by 4 (add_prefix_rule_extends_policy, only_first_token_alias_expands_to_multiple_rules, parses_multiple_policy_files, tail_aliases_are_not_cartesian_expanded); 1 external calls (iter).


##### `append_allow_prefix_rule_dedupes_existing_rule`  (lines 86–101)

```
fn append_allow_prefix_rule_dedupes_existing_rule() -> Result<()>
```

**Purpose**: Checks that appending the same allow-prefix rule twice writes it only once. This protects policy files from growing duplicate entries when the same command is approved repeatedly.

**Data flow**: It creates a temporary policy file path, appends an allow rule for `python3` twice, reads the file back, and asserts that only one rule line exists.

**Call relations**: This test uses `tokens` to build the prefix and calls the external append function under test. It verifies the disk-writing path rather than only in-memory policy behavior.

*Call graph*: calls 1 internal fn (tokens); 4 external calls (assert_eq!, blocking_append_allow_prefix_rule, read_to_string, tempdir).


##### `network_rules_compile_into_domain_lists`  (lines 104–128)

```
fn network_rules_compile_into_domain_lists() -> Result<()>
```

**Purpose**: Checks that network rules are parsed and reduced into allow and deny domain lists. This matters because later network enforcement needs simple lists of domains it can act on.

**Data flow**: It parses policy text with allowed, denied, and prompt-only hosts, builds a policy, inspects the parsed network rules, then asks for the compiled domain lists and compares them with expected lists.

**Call relations**: The test creates a `PolicyParser`, feeds it network rule text, and then exercises the policy’s network-rule accessors. It confirms that prompt-only rules are not included in the allow or deny lists.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `network_rule_rejects_wildcard_hosts`  (lines 131–140)

```
fn network_rule_rejects_wildcard_hosts()
```

**Purpose**: Checks that network rules cannot use wildcard hosts such as `*`. This prevents a policy from accidentally allowing or denying the whole internet through an overly broad host pattern.

**Data flow**: It parses a policy containing a wildcard host, expects parsing to fail, and checks that the error message explains wildcards are not allowed.

**Call relations**: This test calls the parser directly and stops at the parse error. It protects the validation rule for network host names.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `basic_match`  (lines 143–167)

```
fn basic_match() -> Result<()>
```

**Purpose**: Checks the simplest prefix-rule case: a policy rule for `git status` matches the command `git status`. It proves the basic command matching path works.

**Data flow**: It parses one prefix rule, builds a policy, creates the command tokens, checks the command, and compares the evaluation with the expected allow decision and matched prefix.

**Call relations**: This test uses `tokens`, `PolicyParser`, and the policy checker together. It is the baseline example that later tests build on with stricter decisions and more complex patterns.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `justification_is_attached_to_forbidden_matches`  (lines 170–199)

```
fn justification_is_attached_to_forbidden_matches() -> Result<()>
```

**Purpose**: Checks that a forbidden rule can carry an explanation, and that the explanation appears in the match result. This helps callers tell users why a command was blocked.

**Data flow**: It parses a forbidden `rm` rule with a justification, checks an `rm -rf ...` command, and asserts that the final decision is forbidden and the justification text is present.

**Call relations**: The policy parser creates the rule, and the checker returns the matched rule details. The test confirms that explanation text survives from policy source to evaluation output.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `justification_can_be_used_with_allow_decision`  (lines 202–228)

```
fn justification_can_be_used_with_allow_decision() -> Result<()>
```

**Purpose**: Checks that justifications are not limited to blocked commands. An allow rule can also explain why something is considered safe.

**Data flow**: It parses an allow rule for `ls` with explanation text, checks `ls -l` with a prompt fallback, and asserts that the explicit allow rule wins and includes its justification.

**Call relations**: This test uses `prompt_all` to prove the allow came from the policy rule, not the fallback. It verifies parser and checker support for justifications on allow rules.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `justification_cannot_be_empty`  (lines 231–247)

```
fn justification_cannot_be_empty()
```

**Purpose**: Checks that a justification made only of spaces is rejected. This prevents policies from pretending to explain a decision while giving no useful reason.

**Data flow**: It tries to parse a rule whose justification is blank after trimming, expects a parse error, and checks that the error message names the problem.

**Call relations**: The test exercises parser validation only. It protects the rule that justification text must contain real content.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `add_prefix_rule_extends_policy`  (lines 250–281)

```
fn add_prefix_rule_extends_policy() -> Result<()>
```

**Purpose**: Checks that adding a prefix rule directly to an empty policy stores the rule and affects later command checks. This covers programmatic policy creation, not just parsing from files.

**Data flow**: It starts with an empty policy, adds a prompt rule for `ls -l`, snapshots the stored rules, checks a longer `ls -l ...` command, and verifies the prompt decision and matched prefix.

**Call relations**: This test calls `Policy::empty`, uses `tokens` to build prefixes and commands, and uses `rule_snapshots` to inspect internal rule storage before checking behavior.

*Call graph*: calls 2 internal fn (rule_snapshots, tokens); 2 external calls (assert_eq!, empty).


##### `add_prefix_rule_rejects_empty_prefix`  (lines 284–293)

```
fn add_prefix_rule_rejects_empty_prefix() -> Result<()>
```

**Purpose**: Checks that a policy cannot add a prefix rule with no command words. A rule with an empty prefix would be ambiguous because it could match everything.

**Data flow**: It creates an empty policy, tries to add an empty prefix, expects an error, and verifies that the error says the prefix cannot be empty.

**Call relations**: This test targets the direct rule-adding API. It confirms invalid input is rejected before it can enter the policy.

*Call graph*: 3 external calls (assert_eq!, empty, panic!).


##### `parses_multiple_policy_files`  (lines 296–373)

```
fn parses_multiple_policy_files() -> Result<()>
```

**Purpose**: Checks that one parser can read more than one policy file and keep the rules in order. This matters because real configurations may come from shared defaults plus user overrides.

**Data flow**: It parses one file with a broad `git` prompt rule and another with a narrower `git commit` forbidden rule, builds the policy, inspects stored rules, and checks both `git status` and `git commit` commands.

**Call relations**: The test uses `rule_snapshots` to verify the combined rule list and `tokens` to check behavior. It shows how rules from multiple parse calls cooperate in one final policy.

*Call graph*: calls 3 internal fn (new, rule_snapshots, tokens); 1 external calls (assert_eq!).


##### `only_first_token_alias_expands_to_multiple_rules`  (lines 376–444)

```
fn only_first_token_alias_expands_to_multiple_rules() -> Result<()>
```

**Purpose**: Checks how aliases in a prefix pattern are expanded when the first command word has alternatives. A pattern that starts with `bash` or `sh` should create separate rule entries for those two programs.

**Data flow**: It parses a rule whose first token has two alternatives and whose second token also has alternatives, builds the policy, confirms separate `bash` and `sh` stored rules, and checks matching commands for both.

**Call relations**: This test uses `rule_snapshots` to inspect expansion and `tokens` to test actual matching. It protects the special treatment of the first command word, which is used as the lookup key.

*Call graph*: calls 3 internal fn (new, rule_snapshots, tokens); 1 external calls (assert_eq!).


##### `tail_aliases_are_not_cartesian_expanded`  (lines 447–508)

```
fn tail_aliases_are_not_cartesian_expanded() -> Result<()>
```

**Purpose**: Checks that alternatives after the first command word stay inside one rule rather than exploding into every possible combination. This keeps policies compact and predictable.

**Data flow**: It parses an `npm` rule with alternatives for later arguments, verifies that the policy stores one rule with alternative tokens, then checks two valid command variants.

**Call relations**: The test uses `rule_snapshots` to confirm the internal shape and policy checking to confirm the alternatives still match. It contrasts with the first-token expansion behavior tested elsewhere.

*Call graph*: calls 3 internal fn (new, rule_snapshots, tokens); 1 external calls (assert_eq!).


##### `match_and_not_match_examples_are_enforced`  (lines 511–554)

```
fn match_and_not_match_examples_are_enforced() -> Result<()>
```

**Purpose**: Checks that examples embedded in a rule are used to validate the rule’s pattern. The policy author can say “this should match” and “this should not match,” and the parser enforces those claims.

**Data flow**: It parses a `git status` rule with positive and negative examples, builds the policy, checks a matching command, then checks a similar non-matching command and verifies it falls back to heuristics.

**Call relations**: This test goes through parser validation and runtime checking. It uses `tokens` to compare the intended command examples with the actual evaluation results.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `strictest_decision_wins_across_matches`  (lines 557–594)

```
fn strictest_decision_wins_across_matches() -> Result<()>
```

**Purpose**: Checks that when multiple rules match one command, the most restrictive decision becomes the final answer. This prevents a broad softer rule from weakening a narrower stronger rule.

**Data flow**: It parses a prompt rule for `git` and a forbidden rule for `git commit`, checks `git commit -m hi`, and asserts that both rules are recorded but the final decision is forbidden.

**Call relations**: The policy checker gathers all matching prefix rules and combines their decisions. This test confirms the combining rule prefers forbidden over prompt or allow.

*Call graph*: calls 2 internal fn (new, tokens); 1 external calls (assert_eq!).


##### `strictest_decision_across_multiple_commands`  (lines 597–645)

```
fn strictest_decision_across_multiple_commands() -> Result<()>
```

**Purpose**: Checks that the strictest decision also wins when evaluating a batch of commands. If any command in the batch is forbidden, the whole batch must be treated as forbidden.

**Data flow**: It builds a policy with prompt and forbidden `git` rules, creates two commands, checks them together, and verifies the final forbidden decision plus all individual matched rules.

**Call relations**: This test exercises `check_multiple` rather than single-command checking. It shows that batch evaluation reuses the same strictness logic across all commands.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `heuristics_match_is_returned_when_no_policy_matches`  (lines 648–663)

```
fn heuristics_match_is_returned_when_no_policy_matches()
```

**Purpose**: Checks what happens when no explicit policy rule matches. The system should still return an evaluation, using the fallback heuristic decision and recording that it came from heuristics.

**Data flow**: It creates an empty policy, checks `python` with a prompt fallback, and verifies that the result is a prompt heuristic match containing the original command.

**Call relations**: This test uses `Policy::empty`, `tokens`, and `prompt_all`. It confirms the checker’s fallback path produces a clear match record instead of an empty or unexplained result.

*Call graph*: calls 1 internal fn (tokens); 2 external calls (assert_eq!, empty).


##### `parses_host_executable_paths`  (lines 666–696)

```
fn parses_host_executable_paths() -> Result<()>
```

**Purpose**: Checks that `host_executable` policy entries accept absolute paths, remove duplicates, and store the allowed paths for a program name. This is needed to safely map full executable paths back to command names.

**Data flow**: It builds platform-correct paths for `git`, escapes them into policy text, parses the host executable entry, builds the policy, and compares the stored paths with expected absolute-path values.

**Call relations**: The test relies on `host_absolute_path`, `starlark_string`, and `absolute_path`. It verifies the parser’s host executable storage before resolution behavior is tested later.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


##### `host_executable_rejects_non_absolute_path`  (lines 699–711)

```
fn host_executable_rejects_non_absolute_path()
```

**Purpose**: Checks that host executable paths must be absolute. A relative path like `git` is not precise enough to identify which program will run.

**Data flow**: It parses a `host_executable` entry with `paths = ["git"]`, expects parsing to fail, and checks the error message.

**Call relations**: This test targets parser validation for host executable paths. It protects the rule that executable allowlists must name exact full paths.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `host_executable_rejects_name_with_path_separator`  (lines 714–727)

```
fn host_executable_rejects_name_with_path_separator()
```

**Purpose**: Checks that the `name` field for a host executable must be only a bare program name, not a path. This keeps the name separate from the list of allowed paths.

**Data flow**: It creates an absolute git path, puts that path in the `name` field, parses the policy, expects an error, and checks that the message says the name must be bare.

**Call relations**: The test uses `host_absolute_path` and `starlark_string` to build realistic invalid input. It confirms the parser rejects mixing up program names and paths.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert!, format!).


##### `host_executable_rejects_path_with_wrong_basename`  (lines 730–739)

```
fn host_executable_rejects_path_with_wrong_basename()
```

**Purpose**: Checks that an allowed path for `git` must actually end with the executable name `git`. This prevents a policy from accidentally mapping a different program, such as `rg`, to the name `git`.

**Data flow**: It creates a path ending in `rg`, inserts it into a `host_executable(name = "git")` entry, expects parsing to fail, and checks that the error mentions the required basename.

**Call relations**: This test uses path and string helpers to create policy text. It protects the parser’s consistency check between executable name and allowed paths.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert!, format!).


##### `host_executable_last_definition_wins`  (lines 742–767)

```
fn host_executable_last_definition_wins() -> Result<()>
```

**Purpose**: Checks that when the same host executable is defined more than once, the later definition replaces the earlier one. This lets user-specific policy override shared defaults.

**Data flow**: It parses one policy file mapping `git` to one path, then another mapping `git` to a different path, builds the policy, and asserts that only the later path remains.

**Call relations**: The test parses multiple snippets through one `PolicyParser`. It uses host path helpers to verify override behavior in the final policy.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


##### `host_executable_resolution_uses_basename_rule_when_allowed`  (lines 770–804)

```
fn host_executable_resolution_uses_basename_rule_when_allowed() -> Result<()>
```

**Purpose**: Checks that a command using an allowed full executable path can match a rule written for the bare name. For example, `/usr/bin/git status` can match `git status` when `/usr/bin/git` is allowed.

**Data flow**: It creates a policy with a `git status` prompt rule and an allowed git path, checks a command whose first word is that full path with resolution turned on, and expects the bare-name rule to match with the resolved path recorded.

**Call relations**: This test combines prefix matching with host executable resolution. It uses platform-aware name and path helpers so the same behavior is verified across operating systems.

*Call graph*: calls 4 internal fn (new, host_absolute_path, host_executable_name, starlark_string); 2 external calls (assert_eq!, format!).


##### `prefix_rule_examples_honor_host_executable_resolution`  (lines 807–828)

```
fn prefix_rule_examples_honor_host_executable_resolution() -> Result<()>
```

**Purpose**: Checks that rule examples are validated using the same host executable resolution rules as real command checks. This keeps examples honest when full paths are involved.

**Data flow**: It builds policy text where a `git status` rule has a positive example using an allowed full path and a negative example using another full path, then parses the policy successfully.

**Call relations**: The test mainly exercises parser-time example validation. It uses `host_executable_name`, `host_absolute_path`, and `starlark_string` to create platform-correct examples.

*Call graph*: calls 4 internal fn (new, host_absolute_path, host_executable_name, starlark_string); 1 external calls (format!).


##### `host_executable_resolution_respects_explicit_empty_allowlist`  (lines 831–859)

```
fn host_executable_resolution_respects_explicit_empty_allowlist() -> Result<()>
```

**Purpose**: Checks that an explicit empty allowlist means “do not resolve this executable name from any path.” This is different from having no mapping at all.

**Data flow**: It parses a `git` rule plus `host_executable(name = "git", paths = [])`, checks a full git path with resolution enabled, and verifies the bare `git` rule does not match; the command falls back to heuristics.

**Call relations**: This test uses `host_absolute_path` to create the full path. It protects the meaning of an empty host executable list as a deliberate block on resolution.

*Call graph*: calls 2 internal fn (new, host_absolute_path); 1 external calls (assert_eq!).


##### `host_executable_resolution_ignores_path_not_in_allowlist`  (lines 862–894)

```
fn host_executable_resolution_ignores_path_not_in_allowlist() -> Result<()>
```

**Purpose**: Checks that full-path resolution happens only for paths listed in the allowlist. A different `git` binary should not match the bare `git` rule just because its file name is `git`.

**Data flow**: It defines an allowed git path, checks a different git path with resolution enabled, and verifies the policy falls back to the heuristic allow result instead of matching the prompt rule.

**Call relations**: This test uses host path and escaping helpers to build the policy. It confirms the resolver compares the actual path against the allowlist before applying basename rules.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


##### `host_executable_resolution_falls_back_without_mapping`  (lines 897–926)

```
fn host_executable_resolution_falls_back_without_mapping() -> Result<()>
```

**Purpose**: Checks the default behavior when there is no `host_executable` mapping at all. In that case, a full path can still fall back to matching by its basename.

**Data flow**: It parses a prompt rule for `git`, checks a full path ending in `git` with resolution enabled, and expects the bare `git` rule to match with the resolved path recorded.

**Call relations**: This test contrasts with the explicit empty allowlist and not-in-allowlist tests. It shows the resolver’s fallback behavior when the policy has not restricted that executable name.

*Call graph*: calls 2 internal fn (new, host_absolute_path); 1 external calls (assert_eq!).


##### `host_executable_resolution_does_not_override_exact_match`  (lines 929–963)

```
fn host_executable_resolution_does_not_override_exact_match() -> Result<()>
```

**Purpose**: Checks that an exact full-path rule takes priority over basename resolution. If the policy has a rule for `/usr/bin/git`, that exact rule should be used before considering the bare `git` rule.

**Data flow**: It parses one rule for the full git path and another for bare `git`, adds the host executable mapping, checks the full-path command with resolution enabled, and verifies only the exact full-path allow rule matches.

**Call relations**: This test brings together exact prefix matching, host executable mappings, and resolution options. It confirms the matcher does not rewrite a command path when a direct rule already applies.

*Call graph*: calls 3 internal fn (new, host_absolute_path, starlark_string); 2 external calls (assert_eq!, format!).


### Legacy suite entrypoints
These files assemble the legacy execpolicy integration corpus into a single organized test suite and binary entrypoint.

### `execpolicy-legacy/tests/all.rs`

`test` · `test run`

This file is intentionally tiny, but it plays an important organizing role. In Rust, an integration test file under `tests/` is compiled as its own test program. Here, the project uses one test program named `all.rs` and pulls in a larger group of tests through `mod suite;`. That line is like putting a sign on the door that says, “the actual tests are in the suite room.” Without this file, the test modules under `tests/suite/` would not be connected to this integration test binary, so they may not run as part of the normal test command. The file does not contain test logic itself. Its job is to gather the test suite into one place so the test runner can discover and execute it consistently.


### `execpolicy-legacy/tests/suite/mod.rs`

`test` · `test run`

This file does not contain test code itself. Instead, it gathers several older, once-separate integration tests into one shared test suite. In Rust, a line like `mod bad;` means “include the test code from the matching module file.” Think of this file like the index page of a notebook: the real notes are on other pages, but without the index the notebook would not know which sections to include.

The modules named here appear to cover command behavior and parsing cases, such as `cp`, `head`, `ls`, `pwd`, and `sed`, plus broader categories like `good`, `bad`, `literal`, and `parse_sed_command`. By listing them here, the project makes sure those tests are discovered by the Rust test runner and checked as part of the legacy test suite.

If this file were missing or a module line were removed, the corresponding tests would no longer be part of this suite. That could let regressions slip through unnoticed, especially in older behavior that the project still wants to preserve.


### Legacy corpus regressions
These regression tests validate that the curated default-policy good and bad command corpora remain accepted and rejected as intended.

### `execpolicy-legacy/tests/suite/bad.rs`

`test` · `test run`

This file is a safety net for the legacy execution policy. An execution policy is the set of rules that decides which commands are allowed to run and which should be blocked. Here, the project keeps a “bad list”: examples that must not pass the policy check. The test loads the default policy, checks each bad example one by one, and then confirms that none of those bad examples were accepted. In everyday terms, it is like checking a security guard’s training list: every person marked “do not admit” should be turned away. If even one bad example gets through, the test fails and reports it as a violation. This matters because a small policy change could accidentally allow a dangerous command. By running this test, developers get a clear warning before that weakened policy reaches users.

#### Function details

##### `verify_everything_in_bad_list_is_rejected`  (lines 5–9)

```
fn verify_everything_in_bad_list_is_rejected()
```

**Purpose**: This test verifies that every known bad example is rejected by the default policy. It is used to catch mistakes where a forbidden command pattern starts being accepted.

**Data flow**: It starts with no input from the caller. It loads the default policy, asks that policy to test each bad-list example separately, and receives a list of any bad examples that wrongly passed. It then compares that list with an empty list; the expected result is that there are no violations.

**Call relations**: During the test run, this function calls `get_default_policy` to build the policy being tested. After checking the bad examples, it uses `assert_eq!` to make the test pass only when the list of wrongly accepted examples is empty.

*Call graph*: 2 external calls (assert_eq!, get_default_policy).


### `execpolicy-legacy/tests/suite/good.rs`

`test` · `test run`

This file is a safety check for the legacy execution policy, which is the part of the system that decides whether a proposed command should be allowed to run. The policy has a “good list”: examples that are meant to be accepted. This test loads the project’s default policy, then asks it to test each good example one by one. If any supposedly good example is rejected, the test reports that as a failure.

In plain terms, this is like checking that every item on a restaurant’s “approved ingredients” list is still accepted by the kitchen rules. If the rules change and suddenly reject tomatoes, this test catches that mismatch.

The important behavior is that it does not just check the list as a whole. It checks each good example individually, so the result can identify specific positive examples that no longer pass. The test expects an empty list of failures. If the list is not empty, that means the policy and its own examples disagree, and the test fails.

#### Function details

##### `verify_everything_in_good_list_is_allowed`  (lines 5–9)

```
fn verify_everything_in_good_list_is_allowed()
```

**Purpose**: This test proves that all examples labeled as allowed by the default legacy policy are still accepted. It is used to catch mistakes where a policy change accidentally blocks a command that the project says should be safe.

**Data flow**: It starts by loading the default policy. Then it asks that policy to check every “good” example separately. The policy returns a list of any positive examples that failed the check. The test then compares that list with an empty list; if anything is in it, the test fails.

**Call relations**: During the test run, the test calls on `get_default_policy` to obtain the standard policy used by the project. It then uses the policy’s own good-list checking behavior and finally hands the result to the assertion check, which decides whether the test passes or fails.

*Call graph*: 2 external calls (assert_eq!, get_default_policy).


### Legacy command matchers
These command-specific matcher tests exercise default-policy handling for common commands, covering accepted normalization and precise rejection behavior.

### `execpolicy-legacy/tests/suite/cp.rs`

`test` · `test run`

This is a test file for the legacy execution policy, which is the part of the system that decides whether a requested command is allowed and how its arguments should be understood. Here the command under inspection is `cp`, the common file-copying tool. In everyday terms, the policy should read `cp foo bar` as: “read from `foo`, write to `bar`.” For `cp foo bar baz`, it should read both `foo` and `bar` as source files, and `baz` as the destination.

The tests cover both rejected and accepted cases. If someone tries to run `cp` with no arguments, the policy should reject it because both the source and destination are missing. If there is only one argument, the policy should also reject it because there is no separate destination, and the source-file pattern did not get a usable match. For valid examples, the tests confirm that the policy records each argument with the right meaning: readable file for sources, writable file for the destination.

This matters because the execution policy is like a gatekeeper. If it misunderstands command arguments, it could either block safe commands or allow unsafe file access. These tests make sure `cp` is interpreted in the expected, safety-conscious way.

#### Function details

##### `setup`  (lines 15–17)

```
fn setup() -> Policy
```

**Purpose**: This helper loads the default policy used by all the `cp` tests. It keeps the tests focused on command behavior instead of repeating policy setup code.

**Data flow**: It takes no input. It asks the policy library for the default policy, expects that loading to succeed, and returns the loaded `Policy` object for the tests to use.

**Call relations**: Each test calls this first, so they all check the same shared default rules. It delegates the actual loading work to `get_default_policy`, then hands the ready-to-use policy back to the test.

*Call graph*: called by 4 (test_cp_multiple_files, test_cp_no_args, test_cp_one_arg, test_cp_one_file); 1 external calls (get_default_policy).


##### `test_cp_no_args`  (lines 20–31)

```
fn test_cp_no_args()
```

**Purpose**: This test proves that `cp` with no arguments is rejected. Without this check, the policy might accidentally treat an incomplete copy command as safe or meaningful.

**Data flow**: It starts by loading the default policy, then builds an execution request for `cp` with an empty argument list. It sends that request into the policy checker and expects an error saying there are not enough arguments: the policy wanted readable source files and a writable destination file, but got nothing.

**Call relations**: The test uses `setup` to get the default rules, creates an `ExecCall` to describe the attempted command, and then compares the policy result with the expected failure. It is one of the negative tests that verifies bad `cp` shapes are refused.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_cp_one_arg`  (lines 34–45)

```
fn test_cp_one_arg()
```

**Purpose**: This test proves that `cp` with only one file name is rejected. A copy command needs a source and a destination, so one argument is not enough to safely understand the user’s intent.

**Data flow**: It loads the default policy, builds a request for `cp foo/bar`, and asks the policy to check it. The expected result is an error saying the variable-length source-file matcher did not match anything, because the single argument cannot satisfy both the source side and the destination side.

**Call relations**: Like the other tests, it gets its policy from `setup` and describes the command with `ExecCall::new`. It then checks that the policy rejects this incomplete command before any later code could treat it as a valid file operation.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_cp_one_file`  (lines 48–65)

```
fn test_cp_one_file() -> Result<()>
```

**Purpose**: This test checks the simplest valid copy command: one source file and one destination file. It confirms that the policy marks the first path as something to read and the second path as something to write.

**Data flow**: It loads the default policy, creates a request for `cp foo/bar ../baz`, and runs the policy check. The expected output is a successful match: argument 0 becomes a readable file, argument 1 becomes a writable file, and the command is tied to the allowed `cp` program paths.

**Call relations**: After `setup` provides the rules, this test builds both the command being checked and the expected structured result. It relies on `MatchedArg::new` and `ValidExec::new` to describe what a correctly approved `cp` command should look like, then compares that with the policy’s answer.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_cp_multiple_files`  (lines 68–86)

```
fn test_cp_multiple_files() -> Result<()>
```

**Purpose**: This test checks the common `cp` form with multiple source files and one destination. It makes sure the policy treats all earlier arguments as readable sources and only the final argument as the writable target.

**Data flow**: It loads the default policy, creates a request for `cp foo bar baz`, and checks it. The expected result is a successful match where `foo` and `bar` are readable files, `baz` is a writable file, and the command is matched to the allowed system `cp` locations.

**Call relations**: This test follows the same pattern as the other successful case: `setup` supplies the default policy, `ExecCall::new` describes the attempted command, and the expected `MatchedExec` describes the safe interpretation. It confirms the policy’s variable source-file rule works when there is more than one source.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/head.rs`

`test` · `test run`

This is a test file for a command policy checker. The checker looks at a program name plus its command-line arguments and decides whether that exact command matches a known safe pattern. Here, the command under test is `head`, a common tool that prints the first lines of a file or input stream.

The tests build small fake command calls, such as `head src/extension.ts` or `head -n 100 src/extension.ts`, then ask the default policy whether each call is allowed. The file is mainly checking two ideas. First, `head` should be accepted when it reads from a named readable file, with or without the `-n` option. Second, the `-n` option must be followed by a positive whole number, not zero, a decimal number, or a negative-looking value.

One important detail is that real `head` can run with no file and read from standard input, but this policy rejects that case. That does not mean the command is dangerous. It means the policy cannot prove it matches the allowed file-reading pattern. Think of the policy like a strict door guard: if the pass is not in exactly the expected format, the guard says no, even if the person might be harmless.

#### Function details

##### `setup`  (lines 16–18)

```
fn setup() -> Policy
```

**Purpose**: Loads the default execution policy used by all the tests in this file. It keeps the tests focused on `head` behavior instead of repeating policy-loading code each time.

**Data flow**: It takes no input. It asks the library for the default policy, and if loading fails, the test stops with a clear failure message. On success, it returns a `Policy` object that the tests can use to check fake command calls.

**Call relations**: Each test starts by calling this helper so it is using the same default rules. The helper delegates the real loading work to `get_default_policy`, then hands the ready policy back to the individual test.

*Call graph*: called by 7 (test_head_invalid_n_as_0, test_head_invalid_n_as_float, test_head_invalid_n_as_negative_int, test_head_invalid_n_as_nonint_float, test_head_no_args, test_head_one_file_no_flags, test_head_one_flag_one_file); 1 external calls (get_default_policy).


##### `test_head_no_args`  (lines 21–39)

```
fn test_head_no_args()
```

**Purpose**: Checks what happens when `head` is called with no arguments. The expected result is rejection because this policy wants at least one readable file argument for this command pattern.

**Data flow**: The test gets the default policy, creates an `ExecCall` representing `head` with an empty argument list, and asks the policy to check it. The expected output is an error saying the readable-files matcher did not find anything to match.

**Call relations**: This test calls `setup` to get the shared policy, then uses `ExecCall::new` to describe the command being tested. It finishes by comparing the policy result against the exact expected error.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_one_file_no_flags`  (lines 42–60)

```
fn test_head_one_file_no_flags() -> Result<()>
```

**Purpose**: Checks that `head` is accepted when it is given one readable file and no options. This is the simplest allowed `head` use in these tests.

**Data flow**: The test creates a command shaped like `head src/extension.ts`. The policy checks the command and should return a successful match showing that the file argument was recognized as a readable file and that `head` may resolve to `/bin/head` or `/usr/bin/head`.

**Call relations**: After getting the default policy through `setup`, this test builds the command call and compares the checker’s response with the expected successful `MatchedExec` result.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_one_flag_one_file`  (lines 63–86)

```
fn test_head_one_flag_one_file() -> Result<()>
```

**Purpose**: Checks that `head -n 100 <file>` is accepted. It proves the policy recognizes `-n` as an option whose value must be a positive whole number, followed by a readable file.

**Data flow**: The test creates a command with three arguments: `-n`, `100`, and `src/extension.ts`. The policy should turn that into a successful match with one validated option, no standalone flags, and one readable file argument at the correct position.

**Call relations**: This test follows the same pattern as the others: it obtains the policy with `setup`, builds the command with `ExecCall::new`, and uses an equality check to confirm the policy returns the expected structured match.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_0`  (lines 89–98)

```
fn test_head_invalid_n_as_0()
```

**Purpose**: Checks that `head -n 0 <file>` is rejected. The policy treats zero as invalid because `-n` must be followed by a positive integer, meaning a whole number greater than zero.

**Data flow**: The test builds a command where the `-n` value is `0`. When the policy checks it, the expected result is an `InvalidPositiveInteger` error containing the rejected value.

**Call relations**: The test uses `setup` for the policy and `ExecCall::new` for the command, then verifies that validation stops at the bad `-n` value and reports the specific error.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_nonint_float`  (lines 101–110)

```
fn test_head_invalid_n_as_nonint_float()
```

**Purpose**: Checks that `head -n 1.5 <file>` is rejected. This confirms that decimal values are not accepted where the policy requires a positive whole number.

**Data flow**: The test creates a `head` call with `-n` followed by `1.5`. The policy reads that option value, tries to validate it as a positive integer, and returns an `InvalidPositiveInteger` error.

**Call relations**: Like the nearby invalid-value tests, it calls `setup`, builds the command, and compares the policy result with the exact error expected for a bad positive-integer value.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_float`  (lines 113–122)

```
fn test_head_invalid_n_as_float()
```

**Purpose**: Checks that `head -n 1.0 <file>` is rejected. Even though `1.0` represents one in ordinary math, the policy requires the text to look like a whole number, such as `1`.

**Data flow**: The test passes `1.0` as the value after `-n`. The policy checks that text and returns an `InvalidPositiveInteger` error because it is written as a decimal, not an integer.

**Call relations**: This test uses the shared setup helper, creates the command call, and asserts that the policy reports the same kind of validation failure as for other non-integer `-n` values.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_head_invalid_n_as_negative_int`  (lines 125–136)

```
fn test_head_invalid_n_as_negative_int()
```

**Purpose**: Checks that `head -n -1 <file>` is rejected. The notable behavior is that `-1` is treated like another option-looking argument, because it starts with a dash, rather than as a valid value for `-n`.

**Data flow**: The test builds a command where `-n` is followed by `-1`. The policy sees a dash-starting token where it expected the value for `-n`, so it returns an error saying an option was followed by another option instead of a value.

**Call relations**: The test gets the default policy from `setup`, builds the command with `ExecCall::new`, and checks that the parser-style error is returned before any successful command match is made.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/ls.rs`

`test` · `test run`

This is a test file for the legacy execution policy system. That system decides whether a requested program call is safe and allowed. Here, the program under inspection is `ls`, the common command that lists files. The tests act like a checklist: they build fake `ls` calls, ask the default policy to inspect them, and compare the answer with the expected result.

The file matters because `ls` is a simple but important command shape: it can be run with no arguments, with flags such as `-a` and `-l`, and with one or more file names. The tests confirm that safe file arguments are marked as readable files, that known flags are accepted, and that unknown options are rejected. This protects the policy from becoming too loose or accidentally blocking common safe uses.

A small helper, `setup`, loads the default policy so every test starts from the same rulebook. Each test then creates an `ExecCall`, which is a plain description of “someone wants to run this program with these words after it.” The policy returns either a successful match, including the cleaned-up meaning of flags and arguments, or an error explaining why the call is not allowed. A few tests also document known limitations, such as bundled flags like `-al` not being accepted yet.

#### Function details

##### `setup`  (lines 15–17)

```
fn setup() -> Policy
```

**Purpose**: Loads the default execution policy used by all the tests in this file. It gives each test the same rulebook for deciding whether an `ls` command is allowed.

**Data flow**: It takes no input. It asks the library for the default policy, and if that cannot be loaded, the test stops with a clear failure message. It returns a ready-to-use `Policy` object.

**Call relations**: Every test in this file calls `setup` before checking an `ls` command. It hands the loaded policy back to the test, and the test then asks that policy to check a specific `ExecCall`.

*Call graph*: called by 8 (test_flags_after_file_args, test_ls_dash_a_dash_l, test_ls_dash_al, test_ls_dash_z, test_ls_multiple_file_args, test_ls_multiple_flags_and_file_args, test_ls_no_args, test_ls_one_file_arg); 1 external calls (get_default_policy).


##### `test_ls_no_args`  (lines 20–29)

```
fn test_ls_no_args()
```

**Purpose**: Checks that plain `ls` with no extra words is allowed. This confirms the policy recognizes the basic command and its expected system locations.

**Data flow**: The test loads the default policy, creates an `ExecCall` for `ls` with an empty argument list, and asks the policy to check it. The expected result is a successful match with no flags or file arguments and with `/bin/ls` and `/usr/bin/ls` as allowed paths.

**Call relations**: This test uses `setup` to get the policy, builds the command with `ExecCall::new`, then uses an equality assertion to compare the policy's answer with the expected successful match.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_dash_a_dash_l`  (lines 32–47)

```
fn test_ls_dash_a_dash_l()
```

**Purpose**: Checks that `ls -a -l` is allowed when the two flags are written separately. This protects support for common `ls` options: showing hidden files and using long listing format.

**Data flow**: The test starts with the default policy and the argument list `-a`, `-l`. It turns those into an `ExecCall`, sends it to the policy, and expects a successful result where both flags are recorded as accepted flags.

**Call relations**: Like the other tests, it gets its policy from `setup`, creates the command request with `ExecCall::new`, and then verifies the policy result with an assertion.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_dash_z`  (lines 50–63)

```
fn test_ls_dash_z()
```

**Purpose**: Checks that `ls -z` is rejected as an unknown option. This makes sure the policy does not silently allow flags it has not been taught are safe.

**Data flow**: The test loads the policy, creates an `ls` call with `-z`, and asks the policy to inspect it. The expected output is an `UnknownOption` error naming program `ls` and option `-z`.

**Call relations**: It follows the same test pattern: `setup` supplies the rulebook, `ExecCall::new` describes the requested command, and the assertion confirms that the policy rejects the command for the expected reason.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_dash_al`  (lines 66–78)

```
fn test_ls_dash_al()
```

**Purpose**: Checks the current behavior for bundled flags such as `-al`. Although many command-line tools treat this as `-a -l`, this policy does not support that yet, so the test expects rejection.

**Data flow**: The test loads the default policy, creates an `ls` call with one argument, `-al`, and checks it. The expected result is an `UnknownOption` error for `-al`.

**Call relations**: This test documents a known limitation. It uses `setup` and `ExecCall::new`, then asserts the current answer so future changes will be deliberate when bundled option support is added.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_one_file_arg`  (lines 81–100)

```
fn test_ls_one_file_arg() -> Result<()>
```

**Purpose**: Checks that `ls foo` is allowed and that `foo` is understood as a readable file argument. This confirms the policy can distinguish a file name from a flag.

**Data flow**: The test loads the policy and creates an `ls` call with one argument, `foo`. It expects the policy to return a successful match where that argument is recorded at position 0 and classified as a readable file.

**Call relations**: The test gets the policy through `setup`, builds the command with `ExecCall::new`, and compares the result with the expected `MatchedExec`. It also uses `MatchedArg::new`, which can fail, so the test returns a `Result`.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_multiple_file_args`  (lines 103–122)

```
fn test_ls_multiple_file_args() -> Result<()>
```

**Purpose**: Checks that `ls` can be used with several file names. This confirms the policy accepts repeated readable file arguments rather than only one.

**Data flow**: The test creates an `ls` call with `foo`, `bar`, and `baz`. After checking it against the policy, the expected result is a successful match with all three inputs recorded as readable file arguments at their original positions.

**Call relations**: It relies on `setup` for the default policy and `ExecCall::new` for the command description. The final assertion confirms that the policy preserves each file argument and its position.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_ls_multiple_flags_and_file_args`  (lines 125–146)

```
fn test_ls_multiple_flags_and_file_args() -> Result<()>
```

**Purpose**: Checks that `ls` accepts a normal mix of flags followed by file names, such as `ls -l -a foo bar baz`. This tests the policy's ability to separate options from file targets.

**Data flow**: The test loads the policy and builds a command containing two flags followed by three file names. The expected result is a successful match with `-l` and `-a` stored as flags, and `foo`, `bar`, and `baz` stored as readable file arguments at their original argument indexes.

**Call relations**: This test combines the earlier cases. It uses `setup` to load rules, `ExecCall::new` to describe the command, and an assertion to prove the policy classifies both flags and file arguments correctly.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_flags_after_file_args`  (lines 149–175)

```
fn test_flags_after_file_args() -> Result<()>
```

**Purpose**: Checks the current policy behavior when a flag appears after a file name, as in `ls foo -l`. The test expects this to be accepted for now, while the comment notes that real `ls` may not allow this shape and the policy may need to become stricter later.

**Data flow**: The test loads the default policy and creates an `ls` call with `foo` first and `-l` second. The expected result is a successful match where `foo` is treated as a readable file argument at position 0 and `-l` is treated as an accepted flag.

**Call relations**: This test uses the same path as the others: `setup` supplies the policy, `ExecCall::new` creates the request, and the assertion locks in the current behavior. It also serves as a reminder for future policy configuration work about whether flags after file arguments should be forbidden.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/pwd.rs`

`test` · `test run`

This is a small test file for the command policy system. The policy system decides whether a program call is acceptable before it is allowed to run. Here, the program being checked is `pwd`, a common shell command that reports “where am I?” in the filesystem.

The tests all start by loading the project’s default policy. Then each test builds an `ExecCall`, which is a plain description of a command someone wants to run: the program name plus its arguments. The test asks the policy to check that command and compares the result with what should happen.

The file confirms four important cases. Plain `pwd` with no arguments should be accepted. `pwd -L` and `pwd -P` should also be accepted, because those are recognized flags for choosing how symbolic links are shown. A symbolic link is like a shortcut to another folder. Finally, `pwd foo bar` should be rejected because `pwd` is not expected to receive ordinary extra words after the command. Without these tests, a change to the policy could accidentally block normal `pwd` use or, just as importantly, allow command shapes the policy meant to forbid.

#### Function details

##### `setup`  (lines 15–17)

```
fn setup() -> Policy
```

**Purpose**: Loads the default execution policy used by all tests in this file. It keeps the test cases focused on the `pwd` behavior instead of repeating the same policy-loading code.

**Data flow**: It takes no input from the caller. It asks the library for the default policy, expects that loading to succeed, and returns the loaded `Policy` object to the test that asked for it.

**Call relations**: Each `pwd` test calls this first so it can check a command against the same default rules. Internally it hands off to `get_default_policy`, which does the actual policy loading.

*Call graph*: called by 4 (test_pwd_capital_l, test_pwd_capital_p, test_pwd_extra_args, test_pwd_no_args); 1 external calls (get_default_policy).


##### `test_pwd_no_args`  (lines 20–32)

```
fn test_pwd_no_args()
```

**Purpose**: Checks that running `pwd` with no arguments is allowed by the default policy. This protects the most basic and common use of the command.

**Data flow**: It loads the policy, builds an `ExecCall` for program `pwd` with an empty argument list, and asks the policy to check it. The expected result is a successful match for the `pwd` program with no flags or extra arguments.

**Call relations**: This test relies on `setup` to get the policy and on `ExecCall::new` to describe the command being tested. It then uses an equality assertion to confirm that the policy result matches the expected allowed command.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_pwd_capital_l`  (lines 35–48)

```
fn test_pwd_capital_l()
```

**Purpose**: Checks that `pwd -L` is allowed. The `-L` flag asks `pwd` to show the logical path, which may include symbolic-link shortcuts.

**Data flow**: It loads the policy, creates a command description for `pwd` with the single argument `-L`, and checks it. The expected output is a successful match where `-L` is recorded as an accepted flag.

**Call relations**: Like the other tests, it starts with `setup`, creates the command with `ExecCall::new`, and then compares the policy’s answer with the expected accepted result. This test specifically covers one of the allowed `pwd` flags.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_pwd_capital_p`  (lines 51–64)

```
fn test_pwd_capital_p()
```

**Purpose**: Checks that `pwd -P` is allowed. The `-P` flag asks `pwd` to show the physical path, resolving symbolic-link shortcuts to their real locations.

**Data flow**: It loads the default policy, builds an `ExecCall` for `pwd` with `-P`, and asks the policy to evaluate it. The expected result is a successful match that includes `-P` as an accepted flag.

**Call relations**: This test follows the same pattern as the `-L` test: prepare the policy through `setup`, describe the command through `ExecCall::new`, then assert that the policy accepts exactly this flag.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_pwd_extra_args`  (lines 67–86)

```
fn test_pwd_extra_args()
```

**Purpose**: Checks that `pwd` is rejected when it is given unexpected ordinary arguments. This makes sure the policy does not silently allow command forms outside the approved shape.

**Data flow**: It loads the policy, creates an `ExecCall` for `pwd` with two extra arguments, `foo` and `bar`, and asks the policy to check it. The expected result is an error that names both unexpected positional arguments and their positions.

**Call relations**: This test uses `setup` and `ExecCall::new` like the others, but expects failure instead of success. The final assertion confirms that the policy reports the extra arguments clearly rather than treating the command as valid.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


### Legacy custom and sed parsing
These tests focus on specialized matching behavior, including literal positional matching, standalone sed parsing, and full sed policy enforcement.

### `execpolicy-legacy/tests/suite/literal.rs`

`test` · `test run`

This test file checks a small but important promise of the legacy execution policy system: when a policy says an argument must be a specific word, only that exact word should pass. In everyday terms, it is like a guest list that says “Alice Smith” rather than “any Alice”; a near match must still be turned away.

The test builds a tiny policy for a fake program named `fake_executable`. The policy says the program must be run with two exact arguments: `subcommand` followed by `sub-subcommand`. The test then creates one command call that follows those rules exactly and checks that the policy accepts it. It also checks that the accepted result records both matched arguments as literal values, meaning they were matched by exact text.

Then the test creates a second command call where the first argument is right, but the second argument is `not-a-real-subcommand`. The policy should reject this call. Just as importantly, it should reject it for the clear reason that the literal value did not match, showing both the expected and actual text. Without this behavior, policies could accidentally allow the wrong subcommands, which would weaken command safety rules.

#### Function details

##### `test_invalid_subcommand`  (lines 13–54)

```
fn test_invalid_subcommand() -> Result<()>
```

**Purpose**: This test confirms that literal command arguments must match exactly. It checks both the successful case, where all arguments match the policy, and the failure case, where one subcommand is different.

**Data flow**: The test starts with a policy written as text, turns it into a parsed policy, then builds two example command calls. The first call uses the expected program name and arguments, so the policy check should return a successful match containing the exact matched arguments. The second call changes the final argument, so the policy check should return an error that names the expected literal value and the actual wrong value.

**Call relations**: During the test, it creates the policy parser and command/match objects using constructor-style `new` calls, then compares the policy results against the expected outcomes with assertions. This function is run by the Rust test runner, and its job is to exercise the policy checker from the outside, the same way a caller would rely on it when deciding whether a command is allowed.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/parse_sed_command.rs`

`test` · `test run`

This is a small test file for `parse_sed_command`, a function from the legacy execution-policy crate. In plain terms, that parser is being used as a gatekeeper: it decides whether a `sed` command is simple and predictable enough to allow. `sed` is a command-line text editing tool, and commands passed to it can vary a lot, so the policy wants to accept only forms it understands clearly.

The file checks two cases. First, it confirms that a command like `122,202p` is accepted. That means “print lines 122 through 202,” and the final `p` is the important print instruction. Second, it confirms that similar-looking strings without the required print instruction are rejected. For example, `122,202` names a range but does not say what to do with it, and `122202` is just a number-like string. Both are expected to fail with `Error::SedCommandNotProvablySafe`, which means the policy refuses the command because it cannot confidently classify it as safe.

A useful analogy is a security guard checking tickets: this test makes sure the guard lets in the exact ticket format it recognizes, but turns away lookalikes that are missing required information.

#### Function details

##### `parses_simple_print_command`  (lines 5–7)

```
fn parses_simple_print_command()
```

**Purpose**: This test proves that a plain line-range print command is accepted by the parser. It checks the happy path: a command that says to print lines 122 through 202 should be considered safe.

**Data flow**: The test gives the string `122,202p` to `parse_sed_command`. It then compares the returned result with `Ok(())`, meaning “accepted with no extra value returned.” If the parser rejects this command, the equality check fails and the test reports a problem.

**Call relations**: During the Rust test run, this function is invoked as a test because of its test marker. Inside it, the only direct helper it uses is `assert_eq!`, which compares the parser's answer with the expected successful result.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_malformed_print_command`  (lines 10–23)

```
fn rejects_malformed_print_command()
```

**Purpose**: This test proves that incomplete or malformed `sed` command strings are rejected. It is checking that the parser does not treat vague lookalikes as safe commands.

**Data flow**: The test sends two strings, `122,202` and `122202`, into `parse_sed_command`. For each one, it expects an `Error::SedCommandNotProvablySafe` result containing the original command text. If either input is accepted, or rejected with the wrong error, the equality check fails.

**Call relations**: During the Rust test run, this function is invoked as a test. It uses `assert_eq!` twice to compare the parser's actual rejection results with the exact errors that the policy is supposed to produce.

*Call graph*: 1 external calls (assert_eq!).


### `execpolicy-legacy/tests/suite/sed.rs`

`test` · `test run`

This test file acts like a safety checklist for running `sed`, a common command-line tool used to search, print, and edit text. In this project, programs are not allowed to run freely; each proposed command is checked against a policy that decides whether it is safe. These tests make sure the policy understands a few important `sed` cases correctly.

The file first loads the default policy with `setup`, so every test uses the same real rules the system normally applies. Each test then builds an `ExecCall`, which is a plain description of a command someone wants to run, such as `sed -n 122,202p hello.txt`. The test asks the policy to check that command and compares the answer with the expected result.

Two tests show safe commands being accepted: printing a specific range of lines directly, and printing the same range through `sed`’s `-e` option. The expected approval includes details such as the program name, accepted flags, accepted arguments, and the trusted system path for `/usr/bin/sed`.

The other tests protect against mistakes or abuse. One rejects a `sed` substitution that uses the `e` flag, which can execute shell commands. Another rejects a command that supplies only a pattern without the required file argument or required option shape. Without tests like these, the policy could accidentally let a text-processing command become a way to run arbitrary code.

#### Function details

##### `setup`  (lines 16–18)

```
fn setup() -> Policy
```

**Purpose**: Loads the default execution policy used by all the tests in this file. This avoids repeating the same policy-loading code in each test and makes sure they all check against the same rules.

**Data flow**: It takes no input. It asks `get_default_policy` for the standard policy, expects that loading to succeed, and returns the ready-to-use `Policy`. If the policy cannot be loaded, the test stops immediately with a clear failure message.

**Call relations**: Each `sed` test calls `setup` before building its sample command. `setup` delegates the actual loading work to `get_default_policy`, then hands the resulting policy back to the test so the test can call `policy.check`.

*Call graph*: called by 4 (test_sed_print_specific_lines, test_sed_print_specific_lines_with_e_flag, test_sed_reject_dangerous_command, test_sed_verify_e_or_pattern_is_required); 1 external calls (get_default_policy).


##### `test_sed_print_specific_lines`  (lines 21–40)

```
fn test_sed_print_specific_lines() -> Result<()>
```

**Purpose**: Checks that the policy allows a simple safe `sed` command that prints a specific range of lines from a readable file. This protects a useful read-only case: looking at part of a file without editing it or running anything else.

**Data flow**: The test starts by getting the default policy from `setup`. It creates a command description for `sed -n 122,202p hello.txt`. The policy checks that command, and the test expects a successful match showing `sed` as the program, `-n` as an allowed flag, `122,202p` as a safe `sed` command, and `hello.txt` as a readable file.

**Call relations**: This test uses `setup` to get the policy, uses `new` constructors to build the command and expected matched pieces, and then uses `assert_eq!` to compare the policy’s answer with the expected approval.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_sed_print_specific_lines_with_e_flag`  (lines 43–66)

```
fn test_sed_print_specific_lines_with_e_flag() -> Result<()>
```

**Purpose**: Checks that the policy also allows the safe line-printing command when it is supplied through `sed`’s `-e` option. The `-e` option tells `sed` that the next value is an editing script, so the policy must inspect that value carefully.

**Data flow**: The test gets the default policy, then builds a command description for `sed -n -e 122,202p hello.txt`. The policy examines the flag, the `-e` option value, and the file argument. The expected result is a successful match where `122,202p` is accepted as a safe `sed` command attached to `-e`, and `hello.txt` is accepted as the file to read.

**Call relations**: Like the other approval test, it calls `setup` first, then uses `new` constructors to describe both the requested command and the expected validated form. Finally, `assert_eq!` confirms that the policy accepts the command in exactly that form.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_sed_reject_dangerous_command`  (lines 69–78)

```
fn test_sed_reject_dangerous_command()
```

**Purpose**: Checks that the policy rejects a `sed` script that could execute another command. In particular, the `e` behavior in this `sed` expression could run `echo hi`, so it must not be treated as harmless text processing.

**Data flow**: The test loads the policy, then creates a command description for `sed -e s/y/echo hi/e hello.txt`. When the policy checks it, the expected output is an error saying the `sed` command is not provably safe, and it includes the exact unsafe command text.

**Call relations**: This test calls `setup` to get the shared policy, uses `new` to build the attempted command, and then uses `assert_eq!` to make sure the policy returns the specific safety error rather than approving the command.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).


##### `test_sed_verify_e_or_pattern_is_required`  (lines 81–91)

```
fn test_sed_verify_e_or_pattern_is_required()
```

**Purpose**: Checks that the policy rejects an incomplete or wrongly shaped `sed` invocation. This helps ensure the policy does not accidentally treat a bare script-like argument as a complete, safe command when required options or arguments are missing.

**Data flow**: The test loads the policy and creates a command description for `sed 122,202p`. The policy checks it and is expected to return a `MissingRequiredOptions` error for `sed`, naming `-e` as the required option. Nothing is approved or converted into a valid execution.

**Call relations**: This test follows the same pattern as the others: `setup` supplies the policy, `new` builds the command under test, and `assert_eq!` verifies that the result is the exact expected rejection.

*Call graph*: calls 2 internal fn (new, setup); 1 external calls (assert_eq!).
