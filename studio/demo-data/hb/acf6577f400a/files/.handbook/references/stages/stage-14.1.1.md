# Approval policy and request-decision engines  `stage-14.1.1`

This stage is the system’s safety gate. It works behind the scenes whenever a shell command, code patch, network request, or sandbox change is about to happen. Its job is to answer: allow it, block it, or ask the user first.

The newer execpolicy library is the main rule engine. Its front door exposes the useful pieces. Its parser reads policy files written in a small Starlark-based language, meaning a simple scripting format for rules. The rule and policy files define what rules look like, check examples, match commands or hosts, and produce allow, deny, or prompt decisions.

The core files connect those decisions to real tools. sandboxing defines the shared approval and sandbox contract. exec_policy loads and updates command and network rules. network_policy_decision turns network events into clear approval prompts and saved rules. safety does the same kind of gatekeeping for file-writing patches.

The legacy execpolicy library keeps older rule formats working. It parses old policies, matches program arguments, checks per-program rules, validates examples, and ensures commands cannot read or write outside approved folders.

## Files in this stage

### Execution policy model and parsing
These files define the modern execution-policy API, rule model, parser, and runtime evaluation used to decide command and network access.

### `execpolicy/src/lib.rs`

`orchestration` · `cross-cutting`

This file does not contain the policy-checking logic itself. Instead, it acts like a reception desk for the execpolicy crate: it points to the rooms where the real work lives, then re-exports the most important names so callers do not need to know the internal layout. The library appears to deal with execution policy decisions: parsing policy text, representing rules, checking whether something is allowed, reporting errors with text locations, and amending policy files with new allow or network rules.

The module declarations split the work into focused areas. For example, parsing lives in `parser`, decisions live in `decision`, rule shapes live in `rule`, and policy evaluation lives in `policy`. Some modules are marked `pub(crate)`, meaning they are visible inside this library but not directly exposed to outside users. The `rule` module is public, so outside code can reach it as a module too.

The `pub use` lines are the important outward-facing part. They make selected items available from the crate root, such as `Policy`, `PolicyParser`, `Decision`, `Rule`, and `ExecPolicyCheckCommand`. Without this file, users would have to dig through internal module paths, and the crate would not present a clean, stable public interface.


### `execpolicy/src/rule.rs`

`domain_logic` · `policy load and command matching`

This file is the rulebook machinery for deciding whether a command or network access should be allowed, denied, or treated another way. A command is seen as a list of words, such as `git`, `commit`, and `-m`. A prefix rule matches the beginning of that list, like checking whether a sentence starts with certain words. Some words can have alternatives, so a rule can say “the second word may be `install` or `add`.”

The main pieces are small and focused. `PatternToken` represents one expected command word, either one exact word or a list of allowed choices. `PrefixPattern` uses those tokens to check whether the start of a command matches. `PrefixRule` connects a pattern to a `Decision`, which is the policy answer returned when the rule matches. `RuleMatch` records the result in a form that can be returned or serialized, including the matched command prefix and optional explanation.

The file also defines network rule support. `NetworkRuleProtocol` turns policy text like `https` or `socks5_tcp` into a safer internal value, and `normalize_network_rule_host` cleans and checks host names so rules cannot accidentally contain full URLs, paths, wildcards, or malformed ports.

Finally, the validation helpers test examples written in a policy. Positive examples must match at least one rule, and negative examples must not match. Without this file, the policy system would lack its basic vocabulary for matching commands and checking whether rules are written correctly.

#### Function details

##### `PatternToken::matches`  (lines 22–27)

```
fn matches(&self, token: &str) -> bool
```

**Purpose**: Checks whether one command word fits one pattern token. A token can require one exact word, or it can allow any one word from a small list of alternatives.

**Data flow**: It receives the command word as text. If the pattern token is a single expected word, it compares the two directly. If the token contains alternatives, it looks through them for a match. It returns `true` when the word is accepted and `false` otherwise.

**Call relations**: This is the small comparison step used by prefix matching. When a command is being checked against a `PrefixPattern`, each pattern token asks this function whether the corresponding command word is acceptable.


##### `PatternToken::alternatives`  (lines 29–34)

```
fn alternatives(&self) -> &[String]
```

**Purpose**: Returns the list of words that this pattern token can accept. This gives callers a uniform view whether the token has one allowed word or several.

**Data flow**: It reads the token. For a single expected word, it returns a one-item slice pointing at that word. For an alternatives token, it returns the stored list. It does not change anything.

**Call relations**: This is a helper for code that wants to inspect or display the possible words in a pattern. It uses `from_ref` to treat a single string as a one-item list without copying it.

*Call graph*: 1 external calls (from_ref).


##### `PrefixPattern::matches_prefix`  (lines 46–59)

```
fn matches_prefix(&self, cmd: &[String]) -> Option<Vec<String>>
```

**Purpose**: Checks whether the start of a command matches this prefix pattern. It is like comparing the first few words of a sentence against a template.

**Data flow**: It receives a command as a list of strings. It first checks that the command is long enough and that the first command word equals the pattern's fixed first word. Then it compares each remaining pattern token with the matching command word. If all required words match, it returns the matched prefix as a new list. If anything does not match, it returns nothing.

**Call relations**: This is called by `PrefixRule::matches` when a rule is asked whether it applies to a command. It does the detailed word-by-word check, and `PrefixRule::matches` turns a successful check into a policy match result.

*Call graph*: called by 1 (matches).


##### `RuleMatch::decision`  (lines 85–90)

```
fn decision(&self) -> Decision
```

**Purpose**: Extracts the policy decision from a rule match. Callers use it when they only care about the outcome, not the details of how the command matched.

**Data flow**: It reads a `RuleMatch`, whether it came from a prefix rule or from heuristics. In both cases it takes the stored `Decision` and returns it. It does not change the match.

**Call relations**: This is a convenience method for later policy code that receives a `RuleMatch` and needs the allow-or-deny style answer. It hides the difference between prefix-based matches and heuristic matches.


##### `RuleMatch::with_resolved_program`  (lines 92–107)

```
fn with_resolved_program(self, resolved_program: &AbsolutePathBuf) -> Self
```

**Purpose**: Adds the resolved program path to a prefix-rule match when that information is available. A resolved program path means the system has found the actual executable file behind the command name.

**Data flow**: It takes an existing rule match and an absolute path to a program. If the match is a prefix-rule match, it returns a new match with the same prefix, decision, and justification, plus a copy of the resolved program path. If the match is not a prefix-rule match, it returns it unchanged.

**Call relations**: This fits into command matching when the policy system optionally resolves command names to real executable paths. It keeps the original rule result but enriches it with extra path information for later reporting or decisions.

*Call graph*: 1 external calls (clone).


##### `NetworkRuleProtocol::parse`  (lines 126–136)

```
fn parse(raw: &str) -> Result<Self>
```

**Purpose**: Turns a protocol name written in policy text into the internal protocol value used by the program. It rejects unknown protocol names with a clear policy error.

**Data flow**: It receives raw text such as `http`, `https`, `socks5_tcp`, or `socks5_udp`. It maps accepted spellings to the matching `NetworkRuleProtocol` value, including a few alternate names for HTTPS-style connect traffic. If the text is not recognized, it returns an `InvalidRule` error explaining the valid choices.

**Call relations**: This is used when network rules are read or added. It acts as the front door that prevents misspelled or unsupported protocol names from entering the policy data.

*Call graph*: 2 external calls (InvalidRule, format!).


##### `NetworkRuleProtocol::as_policy_string`  (lines 138–145)

```
fn as_policy_string(self) -> &'static str
```

**Purpose**: Converts an internal network protocol value back into the standard text spelling used in policy files. This is useful when writing or displaying policy rules.

**Data flow**: It receives a `NetworkRuleProtocol` value and returns a fixed string such as `http`, `https`, `socks5_tcp`, or `socks5_udp`. It does not allocate new data or change anything.

**Call relations**: This is called by `blocking_append_network_rule` when a network rule needs to be written out in policy form. It is the reverse of parsing, but it always uses one canonical spelling.

*Call graph*: called by 1 (blocking_append_network_rule).


##### `normalize_network_rule_host`  (lines 156–212)

```
fn normalize_network_rule_host(raw: &str) -> Result<String>
```

**Purpose**: Cleans and validates the host part of a network rule. It makes sure the rule names one specific host, not a full URL, path, wildcard pattern, or malformed address.

**Data flow**: It receives raw host text. It trims surrounding spaces, rejects empty input, rejects URL-like text with schemes or paths, and handles optional ports. For bracketed IPv6 addresses, it extracts the address inside the brackets and permits a numeric port after the closing bracket. For ordinary `host:port` text, it removes the numeric port. It then removes a trailing dot, lowercases the host, and rejects empty results, wildcards, and whitespace. On success it returns the normalized host string; on failure it returns an `InvalidRule` error.

**Call relations**: This is called by `blocking_append_network_rule` and `add_network_rule` before a network rule is stored. It protects the policy from ambiguous host entries, much like checking a mailing address before adding it to an address book.

*Call graph*: called by 2 (blocking_append_network_rule, add_network_rule); 2 external calls (InvalidRule, format!).


##### `PrefixRule::program`  (lines 225–227)

```
fn program(&self) -> &str
```

**Purpose**: Returns the first command word that this rule is keyed by. For a command rule, this is usually the program name, such as `git` or `npm`.

**Data flow**: It reads the rule's prefix pattern and returns the fixed first word as text. It does not copy or modify the rule.

**Call relations**: This implements the shared `Rule` interface for `PrefixRule`. Policy lookup code can ask any rule what program name it belongs to without needing to know the rule's concrete type.


##### `PrefixRule::matches`  (lines 229–238)

```
fn matches(&self, cmd: &[String]) -> Option<RuleMatch>
```

**Purpose**: Checks whether this prefix rule applies to a command and, if it does, builds the match result that carries the rule's decision.

**Data flow**: It receives the command as a list of strings. It asks the rule's `PrefixPattern` to match the command prefix. If there is no match, it returns nothing. If there is a match, it returns a `PrefixRuleMatch` containing the matched prefix, the rule's `Decision`, no resolved program yet, and a copy of the optional justification.

**Call relations**: This is the main `Rule` interface method for prefix rules. It delegates the word-by-word checking to `PrefixPattern::matches_prefix`, then wraps the successful result in the standard `RuleMatch` shape used by the rest of the policy system.

*Call graph*: calls 1 internal fn (matches_prefix).


##### `PrefixRule::as_any`  (lines 240–242)

```
fn as_any(&self) -> &dyn Any
```

**Purpose**: Allows a `PrefixRule` stored behind the generic `Rule` interface to be inspected as its concrete type later. This is a Rust pattern for safe downcasting, meaning checking the real type behind a generic trait object.

**Data flow**: It receives a reference to the rule and returns it as a general `Any` reference. Nothing is copied or changed.

**Call relations**: This completes the `Rule` interface for `PrefixRule`. Other code that holds a generic rule can use this hook if it needs to recognize that the rule is specifically a `PrefixRule`.


##### `validate_match_examples`  (lines 246–279)

```
fn validate_match_examples(
    policy: &Policy,
    rules: &[RuleRef],
    matches: &[Vec<String>],
) -> Result<()>
```

**Purpose**: Checks that every positive example command in a policy actually matches at least one rule. This helps policy authors catch rules that are too narrow, misspelled, or otherwise ineffective.

**Data flow**: It receives the policy, the related rules, and a list of example commands that are expected to match. For each example, it asks the policy to find matches using options that resolve host executables. If an example has no matches, it formats that command into a readable shell-like string and records it. If all examples match, it returns success. If any do not, it returns an `ExampleDidNotMatch` error containing the rules and the unmatched examples.

**Call relations**: This is called by `validate_pending_examples_from` during policy validation. It uses the policy's command-matching path rather than duplicating the matching logic, so examples are tested the same way real commands are.

*Call graph*: called by 1 (validate_pending_examples_from); 4 external calls (iter, new, matches_for_command_with_options, try_join).


##### `validate_not_match_examples`  (lines 282–306)

```
fn validate_not_match_examples(
    policy: &Policy,
    _rules: &[RuleRef],
    not_matches: &[Vec<String>],
) -> Result<()>
```

**Purpose**: Checks that every negative example command in a policy does not match any rule. This helps prove that a rule is not too broad.

**Data flow**: It receives the policy, a rules list that is not used here, and commands that are expected not to match. For each command, it asks the policy for matches using executable resolution. If a match is found, it formats both the matching rule and the example command into readable text and returns an `ExampleDidMatch` error. If no negative examples match, it returns success.

**Call relations**: This is called by `validate_pending_examples_from` alongside the positive example validator. Together they let policy files include both “should match” and “should not match” examples, giving authors a simple safety check for rule behavior.

*Call graph*: called by 1 (validate_pending_examples_from); 3 external calls (matches_for_command_with_options, format!, try_join).


### `execpolicy/src/parser.rs`

`config` · `config load`

A policy file is like a rulebook for what programs may run, what network access is allowed, and which host executables are trusted by name. This parser reads that rulebook and builds a structured Policy from it. The policy language is powered by Starlark, a small Python-like configuration language, but this file defines the project-specific words that policy authors can use: prefix_rule, network_rule, and host_executable.

The main flow is simple. PolicyParser creates a PolicyBuilder, parses the policy text as Starlark, exposes the policy helper functions to that Starlark program, and lets the program run. As the Starlark file calls those helpers, the builder collects command rules, network rules, and executable mappings. After parsing, examples attached to new prefix rules are checked, so a policy can say “this should match” or “this should not match” and get an error if reality disagrees.

A key detail is error friendliness. The parser keeps line and column information from the Starlark call site, then attaches it to validation errors. Without this file, policy files would either not load at all, or they would load without the careful checks that prevent confusing, unsafe, or misspelled rules from entering the system.

#### Function details

##### `PolicyParser::default`  (lines 43–45)

```
fn default() -> Self
```

**Purpose**: Creates a default PolicyParser. This lets other code ask for a parser without spelling out how it should be initialized.

**Data flow**: No outside data comes in. It simply calls the normal constructor and returns a fresh parser with an empty policy builder inside.

**Call relations**: When generic Rust code asks for a default value, this function hands the job to PolicyParser::new so there is only one real setup path.

*Call graph*: 1 external calls (new).


##### `PolicyParser::new`  (lines 49–53)

```
fn new() -> Self
```

**Purpose**: Creates a new parser ready to read policy files. It starts with an empty PolicyBuilder where discovered rules will be collected.

**Data flow**: No policy text comes in yet. The function creates a new PolicyBuilder, wraps it in a RefCell, which is Rust’s way of allowing carefully checked interior mutation, and returns a PolicyParser containing it.

**Call relations**: This is the entry point used by policy loading code and many tests before they call parse. PolicyParser::default also uses it so all fresh parsers are set up the same way.

*Call graph*: calls 1 internal fn (new); called by 40 (load_exec_policy, heuristics_apply_when_other_commands_match_policy, mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision, mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled, policy_from_src, denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled, evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled, intercepted_exec_policy_rejects_disallowed_host_executable_mapping (+15 more)); 1 external calls (new).


##### `PolicyParser::parse`  (lines 57–79)

```
fn parse(&mut self, policy_identifier: &str, policy_file_contents: &str) -> Result<()>
```

**Purpose**: Reads one policy file’s text and adds its rules to the parser. It also validates any examples that were introduced by that file.

**Data flow**: It receives a policy identifier, used in error messages, and the policy file contents. It parses the text as Starlark, runs it with the project’s custom policy functions available, lets those functions fill the builder, then checks only the newly added example validations. It returns success or an Error with details.

**Call relations**: Callers create a PolicyParser, call parse for policy text, and later call build. During evaluation, this function makes the PolicyBuilder available to the Starlark built-ins, so calls like prefix_rule and network_rule can add data to the builder.

*Call graph*: 3 external calls (parse, standard, with_temp_heap).


##### `PolicyParser::build`  (lines 81–83)

```
fn build(self) -> crate::policy::Policy
```

**Purpose**: Finishes parsing and returns the completed Policy. Someone calls this after all desired policy files have been parsed.

**Data flow**: It consumes the PolicyParser, takes out its PolicyBuilder, and asks that builder to produce the final Policy object. Nothing is left behind in the parser because it is used up.

**Call relations**: This is the final step after PolicyParser::parse has collected rules. It delegates the actual assembly to PolicyBuilder::build.


##### `PolicyBuilder::new`  (lines 95–102)

```
fn new() -> Self
```

**Purpose**: Creates the empty collection buckets used while a policy file is being read. These buckets hold program rules, network rules, executable mappings, and deferred example checks.

**Data flow**: No input is needed. It creates an empty multimap for rules by program name, an empty list for network rules, an empty map for host executables, and an empty list of pending validations.

**Call relations**: PolicyParser::new uses this to prepare a parser. The builder is then mutated by the policy built-ins while Starlark evaluation runs.

*Call graph*: called by 2 (parse, new); 3 external calls (new, new, new).


##### `PolicyBuilder::add_rule`  (lines 104–107)

```
fn add_rule(&mut self, rule: RuleRef)
```

**Purpose**: Adds one command-prefix rule to the growing policy. The rule is stored under the program name it applies to, so later lookup can start from the executable being run.

**Data flow**: A RuleRef comes in. The function reads the rule’s program name and inserts the rule into rules_by_program under that name. It changes the builder and returns nothing.

**Call relations**: The prefix_rule built-in creates one or more rules and calls this for each of them. Those collected rules are later included when PolicyBuilder::build creates the final Policy.

*Call graph*: 2 external calls (insert, program).


##### `PolicyBuilder::add_network_rule`  (lines 109–111)

```
fn add_network_rule(&mut self, rule: NetworkRule)
```

**Purpose**: Adds one network access rule to the growing policy. This covers decisions about hosts and protocols, such as whether a certain host should be allowed or denied.

**Data flow**: A NetworkRule comes in. The function appends it to the builder’s network_rules list. It changes the builder and returns nothing.

**Call relations**: The network_rule Starlark built-in calls this after it has parsed and checked the host, protocol, decision, and optional justification.


##### `PolicyBuilder::add_host_executable`  (lines 113–115)

```
fn add_host_executable(&mut self, name: String, paths: Vec<AbsolutePathBuf>)
```

**Purpose**: Records which absolute paths may count as a named host executable. This is useful when policy rules refer to an executable by name but the system needs known trusted paths.

**Data flow**: A normalized executable name and a list of absolute paths come in. The paths are stored under that name, replacing any previous entry for the same name. The builder is updated in place.

**Call relations**: The host_executable built-in calls this after checking that the name is bare, the paths are absolute, and each path’s basename matches the name.


##### `PolicyBuilder::add_pending_example_validation`  (lines 117–131)

```
fn add_pending_example_validation(
        &mut self,
        rules: Vec<RuleRef>,
        matches: Vec<Vec<String>>,
        not_matches: Vec<Vec<String>>,
        location: Option<ErrorLocation>,
```

**Purpose**: Saves examples that should be checked after the current Starlark rule call finishes. These examples prove that a rule matches the commands it is meant to match and does not match commands it should ignore.

**Data flow**: It receives the rules being tested, example command lines expected to match, example command lines expected not to match, and an optional source location. It wraps them in a PendingExampleValidation record and appends it to the builder’s validation list.

**Call relations**: The prefix_rule built-in calls this before adding the new rules to the builder. Later, PolicyParser::parse asks PolicyBuilder::validate_pending_examples_from to check the new saved validations.


##### `PolicyBuilder::validate_pending_examples_from`  (lines 133–152)

```
fn validate_pending_examples_from(&self, start: usize) -> Result<()>
```

**Purpose**: Checks saved match and not-match examples starting at a chosen point in the validation list. This prevents broken examples from silently becoming misleading documentation.

**Data flow**: It receives an index saying where new validations begin. For each saved validation from that point onward, it builds a temporary Policy containing just the relevant rules and current host executable map, then runs the not-match checks and match checks. If a check fails, it attaches the original source location when available and returns an error.

**Call relations**: PolicyParser::parse records how many validations existed before running a policy file, then calls this afterward to check only the examples added by that parse. It calls validate_not_match_examples and validate_match_examples to do the actual rule testing.

*Call graph*: calls 2 internal fn (validate_match_examples, validate_not_match_examples); 3 external calls (new, new, from_parts).


##### `PolicyBuilder::build`  (lines 154–160)

```
fn build(self) -> crate::policy::Policy
```

**Purpose**: Turns the builder’s collected pieces into the final Policy object. This is the handoff from temporary parsing state to the usable rulebook.

**Data flow**: It consumes the builder and moves out the rules by program, network rules, and host executable mappings. Those parts are passed into Policy::from_parts, which returns a Policy.

**Call relations**: PolicyParser::build delegates to this after parsing is complete. The resulting Policy is what other parts of the system use when making execution decisions.

*Call graph*: 1 external calls (from_parts).


##### `parse_pattern`  (lines 171–182)

```
fn parse_pattern(pattern: UnpackList<Value<'v>>) -> Result<Vec<PatternToken>>
```

**Purpose**: Converts a Starlark list-like pattern into internal pattern tokens for a prefix rule. It rejects empty patterns because a rule with no command tokens would be meaningless.

**Data flow**: It receives a Starlark unpacked list of values. Each item is passed to parse_pattern_token, producing a list of PatternToken values. If the list is empty or any token is invalid, it returns an error; otherwise it returns the token list.

**Call relations**: The prefix_rule built-in uses this before creating PrefixRule objects. It relies on parse_pattern_token for the item-by-item conversion.

*Call graph*: 1 external calls (InvalidPattern).


##### `parse_pattern_token`  (lines 184–217)

```
fn parse_pattern_token(value: Value<'v>) -> Result<PatternToken>
```

**Purpose**: Converts one item from a rule pattern into a token the matcher understands. A token can be a single string or a list of alternative strings.

**Data flow**: It receives one Starlark value. If the value is a string, it becomes a single-token pattern. If it is a list, each item must be a string; an empty list is rejected, a one-item list is simplified to a single token, and a multi-item list becomes an alternatives token. Any other kind of value produces an invalid-pattern error.

**Call relations**: parse_pattern calls this for every item in a prefix_rule pattern. The resulting PatternToken values later become the first and remaining parts of PrefixPattern.

*Call graph*: 6 external calls (from_value, unpack_str, InvalidPattern, Alts, Single, format!).


##### `parse_examples`  (lines 219–221)

```
fn parse_examples(examples: UnpackList<Value<'v>>) -> Result<Vec<Vec<String>>>
```

**Purpose**: Converts the examples attached to a rule into command-token lists. These examples are later used to check that the rule behaves as the policy author expected.

**Data flow**: It receives a Starlark unpacked list of example values. Each example is passed to parse_example, and the results are collected into a list of token lists. If any example is invalid, the whole conversion returns an error.

**Call relations**: The prefix_rule built-in calls this for the optional match and not_match arguments. It hands each individual example to parse_example.


##### `parse_literal_absolute_path`  (lines 223–232)

```
fn parse_literal_absolute_path(raw: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Checks and converts a path string from host_executable into an absolute path object. It refuses relative paths so the policy cannot depend on the caller’s current directory.

**Data flow**: A raw string path comes in. The function first checks whether it is absolute, then asks AbsolutePathBuf to validate and store it. It returns the absolute path object or an invalid-rule error explaining the problem.

**Call relations**: The host_executable built-in calls this for every listed path after confirming the Starlark value is a string. The parsed paths are later stored by PolicyBuilder::add_host_executable.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (new, InvalidRule, format!).


##### `validate_host_executable_name`  (lines 234–251)

```
fn validate_host_executable_name(name: &str) -> Result<()>
```

**Purpose**: Makes sure a host executable name is just a bare executable name, not a path. This avoids confusing entries like folders, empty names, or names with separators.

**Data flow**: A name string comes in. The function rejects an empty name and checks that the path parser sees exactly one filename component matching the original string. It returns success or an invalid-rule error.

**Call relations**: The host_executable built-in calls this before looking at paths. If the name is invalid, parsing stops before any executable mapping is added.

*Call graph*: 3 external calls (new, InvalidRule, format!).


##### `parse_network_rule_decision`  (lines 253–258)

```
fn parse_network_rule_decision(raw: &str) -> Result<Decision>
```

**Purpose**: Converts the decision text in a network_rule into the internal Decision value. It treats the word deny as the project’s Forbidden decision while letting other decision names use the normal parser.

**Data flow**: A raw decision string comes in. If it is exactly deny, the function returns Decision::Forbidden. Otherwise it passes the string to Decision::parse and returns that result.

**Call relations**: The network_rule built-in uses this when reading its decision argument. This keeps network policy wording compatible with both deny and the shared Decision parser.

*Call graph*: calls 1 internal fn (parse).


##### `error_location_from_file_span`  (lines 260–275)

```
fn error_location_from_file_span(span: FileSpan) -> ErrorLocation
```

**Purpose**: Turns a Starlark source-code span into the project’s error location format. This lets validation errors point back to the policy file line and column that caused them.

**Data flow**: A FileSpan from the Starlark evaluator comes in. The function resolves it into beginning and ending line and column positions, converts those to one-based numbers that humans expect, and returns an ErrorLocation with the filename and text range.

**Call relations**: The prefix_rule built-in uses this when saving example validations. If validation later fails, attach_validation_location can add this location to the error.

*Call graph*: 2 external calls (filename, resolve_span).


##### `attach_validation_location`  (lines 277–282)

```
fn attach_validation_location(error: Error, location: Option<ErrorLocation>) -> Error
```

**Purpose**: Adds a saved source location to an error when one is available. This makes example validation failures easier to fix in the policy file.

**Data flow**: An Error and an optional ErrorLocation come in. If there is a location, the error is returned with that location attached; otherwise the original error is returned unchanged.

**Call relations**: PolicyBuilder::validate_pending_examples_from uses this around errors from validate_not_match_examples and validate_match_examples.

*Call graph*: 1 external calls (with_location).


##### `parse_example`  (lines 284–295)

```
fn parse_example(value: Value<'v>) -> Result<Vec<String>>
```

**Purpose**: Converts one example command into a list of command tokens. It accepts either a shell-like string or an explicit list of strings.

**Data flow**: A Starlark value comes in. If it is a string, parse_string_example splits it like a shell command line. If it is a list, parse_list_example checks and copies its string items. Any other value becomes an invalid-example error.

**Call relations**: parse_examples calls this for each example supplied to prefix_rule. It delegates to parse_string_example or parse_list_example depending on the example’s shape.

*Call graph*: calls 2 internal fn (parse_list_example, parse_string_example); 4 external calls (from_value, unpack_str, InvalidExample, format!).


##### `parse_string_example`  (lines 297–309)

```
fn parse_string_example(raw: &str) -> Result<Vec<String>>
```

**Purpose**: Splits a string example into command tokens using shell-style quoting rules. This lets policy authors write natural examples such as a command line with quoted arguments.

**Data flow**: A raw example string comes in. shlex splitting turns it into tokens, or fails if the shell syntax is invalid. Empty strings are rejected; otherwise the token list is returned.

**Call relations**: parse_example calls this when an example is written as a single string. The returned tokens are later used by example validation.

*Call graph*: called by 1 (parse_example); 2 external calls (InvalidExample, split).


##### `parse_list_example`  (lines 311–335)

```
fn parse_list_example(list: &ListRef) -> Result<Vec<String>>
```

**Purpose**: Checks and copies an example that is already written as a list of command tokens. This is the stricter alternative to shell-string examples.

**Data flow**: A Starlark list reference comes in. Every item must be a string, and those strings are copied into a Rust vector. An empty list or a non-string item produces an invalid-example error.

**Call relations**: parse_example calls this when an example is written as a list. The returned tokens are later compared against the prefix rules during validation.

*Call graph*: called by 1 (parse_example); 2 external calls (content, InvalidExample).


##### `policy_builder`  (lines 337–345)

```
fn policy_builder(eval: &Evaluator<'v, 'a, '_>) -> RefMut<'a, PolicyBuilder>
```

**Purpose**: Retrieves the shared PolicyBuilder from the current Starlark evaluator. The custom Starlark functions use it as their way to add rules to the parser’s collected state.

**Data flow**: It receives an Evaluator. The function expects Evaluator.extra to contain a RefCell<PolicyBuilder>, downcasts it to that type, borrows it mutably, and returns the mutable borrow. If the evaluator was not prepared correctly, it panics with a developer-facing message.

**Call relations**: PolicyParser::parse stores the builder in the evaluator before running the Starlark module. The built-ins defined by policy_builtins call policy_builder whenever they need to add a rule, network rule, or executable mapping.


##### `policy_builtins`  (lines 348–473)

```
fn policy_builtins(builder: &mut GlobalsBuilder)
```

**Purpose**: Registers the policy language functions that a Starlark policy file is allowed to call. These functions are the bridge between human-written policy text and the internal builder.

**Data flow**: A GlobalsBuilder comes in from the Starlark setup code. This module adds prefix_rule, network_rule, and host_executable to it. When the policy file calls those names, the nested Rust functions parse arguments, validate them, and update the PolicyBuilder; the registration itself returns through the Starlark macro machinery.

**Call relations**: PolicyParser::parse builds Starlark globals with policy_builtins before evaluating a policy file. The registered functions call helpers such as parse_pattern, parse_examples, parse_network_rule_decision, validate_host_executable_name, parse_literal_absolute_path, and policy_builder to turn Starlark calls into builder updates.


### `execpolicy/src/policy.rs`

`domain_logic` · `request handling and policy evaluation`

This file answers a practical question: “Is this command or network access allowed?” A policy is like a rulebook. Some rules apply to programs and their arguments, such as a command starting with `git status`. Other rules apply to network hosts. Without this file, the rest of the system could store rules but would not have one clear place to combine them, look them up, and produce a final answer.

The `Policy` type keeps three main collections: command rules grouped by program name, network rules, and a map of known host-machine executable paths. When a command is checked, the policy first looks for rules whose first word exactly matches the program name. If configured to do so, it can also recognize an absolute path like `/usr/bin/git` as the host executable named `git`, then match rules written for `git`. If no rule matches, a caller-provided fallback can make a best-effort decision.

The `Evaluation` type is the final report. It contains the strongest decision found among all matching rules and the list of rules that led to that result. Network rules are compiled into separate allow and deny domain lists, with later rules replacing earlier ones for the same host.

#### Function details

##### `Policy::new`  (lines 35–37)

```
fn new(rules_by_program: MultiMap<String, RuleRef>) -> Self
```

**Purpose**: Creates a policy from command rules only. It starts with no network rules and no host-executable path information.

**Data flow**: It receives a map from program names to rules. It passes that map, plus empty network and executable-path collections, into the fuller policy constructor. The result is a ready-to-use `Policy`.

**Call relations**: This is the simple constructor used when callers only have command rules. It delegates to `Policy::from_parts` so all policy construction goes through the same shape.

*Call graph*: 3 external calls (new, from_parts, new).


##### `Policy::from_parts`  (lines 39–49)

```
fn from_parts(
        rules_by_program: MultiMap<String, RuleRef>,
        network_rules: Vec<NetworkRule>,
        host_executables_by_name: HashMap<String, Arc<[AbsolutePathBuf]>>,
    ) -> Self
```

**Purpose**: Builds a policy from all of its pieces at once. This is useful when rules, network permissions, and host executable paths have already been loaded or combined elsewhere.

**Data flow**: It receives command rules, network rules, and a name-to-paths table. It stores those three collections directly inside a new `Policy` and returns it.

**Call relations**: This is the central constructor. Other constructors and combining operations use it when they need to assemble a complete policy object.


##### `Policy::empty`  (lines 51–53)

```
fn empty() -> Self
```

**Purpose**: Creates a policy with no rules at all. This is useful as a safe starting point before adding rules or as a default that permits nothing by rule.

**Data flow**: It creates an empty rule map and passes it to `Policy::new`. The returned policy has no command rules, no network rules, and no host executable paths.

**Call relations**: This is the blank-rulebook shortcut. It relies on `Policy::new` to build the actual policy.

*Call graph*: 2 external calls (new, new).


##### `Policy::rules`  (lines 55–57)

```
fn rules(&self) -> &MultiMap<String, RuleRef>
```

**Purpose**: Lets other code read the command-rule table without taking ownership of it. This is for inspection, exporting, or further processing.

**Data flow**: It reads the policy’s internal command-rule map and returns a shared reference to it. Nothing is changed.

**Call relations**: This is an accessor. It gives callers a view of the stored command rules while keeping the `Policy` in control of the data.


##### `Policy::network_rules`  (lines 59–61)

```
fn network_rules(&self) -> &[NetworkRule]
```

**Purpose**: Lets other code read the stored network rules. These are the rules that say whether access to particular hosts is allowed, denied, or should prompt.

**Data flow**: It reads the policy’s internal network-rule list and returns it as a shared slice. The policy is not changed.

**Call relations**: This accessor supports code that needs to inspect or serialize network permissions without editing them.


##### `Policy::host_executables`  (lines 63–65)

```
fn host_executables(&self) -> &HashMap<String, Arc<[AbsolutePathBuf]>>
```

**Purpose**: Lets other code read the table of known host executable paths. This table helps match rules written for names like `python` against full paths like `/usr/bin/python`.

**Data flow**: It returns a shared reference to the internal name-to-paths map. No data is copied or changed.

**Call relations**: This accessor supports policy inspection and any code that needs to know which absolute paths are trusted matches for executable names.


##### `Policy::get_allowed_prefixes`  (lines 67–89)

```
fn get_allowed_prefixes(&self) -> Vec<Vec<String>>
```

**Purpose**: Collects the command prefixes that are explicitly allowed by prefix rules. A prefix is the beginning of a command, like the first few words that a rule matches.

**Data flow**: It walks through all command rules, keeps only prefix rules whose decision is `Allow`, turns each pattern into plain strings, sorts them, removes duplicates, and returns the resulting list.

**Call relations**: This function reads from the command-rule table. It uses `render_pattern_token` behavior indirectly through the helper to make pattern pieces readable for callers.

*Call graph*: 3 external calls (iter_all, new, with_capacity).


##### `Policy::add_prefix_rule`  (lines 91–111)

```
fn add_prefix_rule(&mut self, prefix: &[String], decision: Decision) -> Result<()>
```

**Purpose**: Adds a new rule that matches commands beginning with a given sequence of words. This lets code build or extend a policy programmatically.

**Data flow**: It receives a command prefix and a decision. If the prefix is empty, it returns an error because a rule needs at least a program name. Otherwise it builds a `PrefixRule`, stores it under the first command word, and returns success.

**Call relations**: This is one of the policy-editing entry points. It creates a rule object and inserts it into the same command-rule map later used by command matching.

*Call graph*: 3 external calls (from, new, insert).


##### `Policy::add_network_rule`  (lines 113–135)

```
fn add_network_rule(
        &mut self,
        host: &str,
        protocol: NetworkRuleProtocol,
        decision: Decision,
        justification: Option<String>,
    ) -> Result<()>
```

**Purpose**: Adds a rule for network access to a host. It records whether that host should be allowed, forbidden, or left to a prompt.

**Data flow**: It receives a host name, protocol, decision, and optional explanation. It normalizes the host into a consistent form, rejects an explanation that is only blank text, then appends a new `NetworkRule` to the policy.

**Call relations**: This is the network counterpart to adding command rules. It uses `normalize_network_rule_host` to keep host names consistent before `compiled_network_domains` later interprets the final list.

*Call graph*: calls 1 internal fn (normalize_network_rule_host); 1 external calls (InvalidRule).


##### `Policy::set_host_executable_paths`  (lines 137–139)

```
fn set_host_executable_paths(&mut self, name: String, paths: Vec<AbsolutePathBuf>)
```

**Purpose**: Records which absolute paths on the host machine belong to a given executable name. This prevents a random path with the same file name from automatically matching trusted rules.

**Data flow**: It receives an executable name and a list of absolute paths. It stores the paths under that name, replacing any previous entry for the same name.

**Call relations**: This feeds the optional host-executable matching path. When command matching tries to resolve `/some/path/name` back to `name`, this table can confirm whether that path is one of the known ones.


##### `Policy::merge_overlay`  (lines 141–165)

```
fn merge_overlay(&self, overlay: &Policy) -> Policy
```

**Purpose**: Creates a combined policy where another policy is layered on top of this one. This is useful when a base rulebook needs temporary or user-specific additions.

**Data flow**: It copies the current command rules, network rules, and host executable paths. Then it appends or overwrites with the overlay policy’s corresponding data. It returns a new combined `Policy` and leaves both originals unchanged.

**Call relations**: This is how policies are composed. After merging, normal checking functions operate on the combined rulebook as if it had been built that way from the start.

*Call graph*: 2 external calls (clone, from_parts).


##### `Policy::compiled_network_domains`  (lines 167–186)

```
fn compiled_network_domains(&self) -> (Vec<String>, Vec<String>)
```

**Purpose**: Turns the ordered network-rule list into two simple lists: allowed domains and denied domains. Later rules for the same host win over earlier ones.

**Data flow**: It starts with empty allowed and denied lists. For each network rule, an allow removes that host from denied and adds it to allowed; a forbid does the reverse; a prompt does not enter either list. It returns both lists.

**Call relations**: This is used after network rules have been collected. It relies on `upsert_domain` to move a host to the end of the relevant list while avoiding duplicates.

*Call graph*: calls 1 internal fn (upsert_domain); 1 external calls (new).


##### `Policy::check`  (lines 188–198)

```
fn check(&self, cmd: &[String], heuristics_fallback: &F) -> Evaluation
```

**Purpose**: Checks one command using default matching behavior and returns the final evaluation. This is the common “tell me the decision for this command” call.

**Data flow**: It receives a command and a fallback decision function. It finds matching rules with default options, then turns those matches into an `Evaluation` containing the final decision and supporting matches.

**Call relations**: This is a convenience wrapper around `matches_for_command_with_options` and `Evaluation::from_matches`. Callers use it when they do not need special matching options.

*Call graph*: calls 2 internal fn (from_matches, matches_for_command_with_options); 1 external calls (default).


##### `Policy::check_with_options`  (lines 200–212)

```
fn check_with_options(
        &self,
        cmd: &[String],
        heuristics_fallback: &F,
        options: &MatchOptions,
    ) -> Evaluation
```

**Purpose**: Checks one command with custom matching options. The main option controls whether absolute host executable paths should be resolved to executable names.

**Data flow**: It receives a command, a fallback decision function, and match options. It gathers matching rules according to those options and converts them into an `Evaluation`.

**Call relations**: This is the configurable version of `Policy::check`. It still uses `matches_for_command_with_options` for the search and `Evaluation::from_matches` for the final report.

*Call graph*: calls 2 internal fn (from_matches, matches_for_command_with_options).


##### `Policy::check_multiple`  (lines 215–226)

```
fn check_multiple(
        &self,
        commands: Commands,
        heuristics_fallback: &F,
    ) -> Evaluation
```

**Purpose**: Checks several commands together using default matching behavior. This is useful when a larger operation is made of multiple commands and needs one combined decision.

**Data flow**: It receives an iterable collection of commands and a fallback decision function. It forwards them with default options and returns the combined `Evaluation`.

**Call relations**: This is a convenience wrapper. It hands the real work to `Policy::check_multiple_with_options` with the default `MatchOptions`.

*Call graph*: calls 1 internal fn (check_multiple_with_options); 1 external calls (default).


##### `Policy::check_multiple_with_options`  (lines 228–251)

```
fn check_multiple_with_options(
        &self,
        commands: Commands,
        heuristics_fallback: &F,
        options: &MatchOptions,
    ) -> Evaluation
```

**Purpose**: Checks several commands together with custom matching options and produces one combined evaluation. The final decision reflects the strongest decision among all matched rules.

**Data flow**: It receives many commands, a fallback decision function, and match options. For each command, it gathers matching rules, flattens all those matches into one list, and builds a single `Evaluation` from that list.

**Call relations**: This is called by `Policy::check_multiple`. It uses the same matching machinery as single-command checks, then relies on `Evaluation::from_matches` to summarize all matches.

*Call graph*: calls 1 internal fn (from_matches); called by 1 (check_multiple); 1 external calls (into_iter).


##### `Policy::matches_for_command`  (lines 260–266)

```
fn matches_for_command(
        &self,
        cmd: &[String],
        heuristics_fallback: HeuristicsFallback<'_>,
    ) -> Vec<RuleMatch>
```

**Purpose**: Returns the raw rule matches for one command using default matching options. This is useful when callers want to inspect why a command was allowed or denied instead of only seeing the final decision.

**Data flow**: It receives a command and an optional fallback function. It calls the option-aware matcher with default options and returns the list of rule matches.

**Call relations**: This is the simpler form of `Policy::matches_for_command_with_options`. Other code can use it when it wants match details but not custom matching behavior.

*Call graph*: calls 1 internal fn (matches_for_command_with_options); 1 external calls (default).


##### `Policy::matches_for_command_with_options`  (lines 268–295)

```
fn matches_for_command_with_options(
        &self,
        cmd: &[String],
        heuristics_fallback: HeuristicsFallback<'_>,
        options: &MatchOptions,
    ) -> Vec<RuleMatch>
```

**Purpose**: Finds the rules that match a command, optionally using special matching behavior. If no real rule matches, it can create a fallback match so the caller still gets a decision.

**Data flow**: It receives a command, an optional fallback decision function, and matching options. It first tries exact program-name rules. If configured, it may also try resolving an absolute executable path to a known program name. If still nothing matches and a fallback exists, it returns one fallback match; otherwise it returns the real matches or an empty list.

**Call relations**: This is the main matching engine used by `Policy::check`, `Policy::check_with_options`, and `Policy::matches_for_command`. It calls `Policy::match_exact_rules` first, and it is the point where fallback decisions enter the result.

*Call graph*: calls 1 internal fn (match_exact_rules); called by 3 (check, check_with_options, matches_for_command); 1 external calls (vec!).


##### `Policy::match_exact_rules`  (lines 297–305)

```
fn match_exact_rules(&self, cmd: &[String]) -> Option<Vec<RuleMatch>>
```

**Purpose**: Looks for command rules whose stored program name exactly matches the first word of the command. This is the fastest and most direct rule lookup.

**Data flow**: It reads the first string in the command. If there is no first word, it returns no result. Otherwise it fetches rules stored under that program name, asks each rule whether it matches the full command, and returns the matches.

**Call relations**: This is called by `Policy::matches_for_command_with_options` as the first matching attempt. It uses the policy’s program-to-rules map to avoid scanning unrelated rules.

*Call graph*: called by 1 (matches_for_command_with_options); 1 external calls (get_vec).


##### `Policy::match_host_executable_rules`  (lines 307–334)

```
fn match_host_executable_rules(&self, cmd: &[String]) -> Vec<RuleMatch>
```

**Purpose**: Matches commands that start with an absolute executable path against rules written for the executable’s short name. For example, it can treat `/usr/bin/git status` as `git status` when that path is trusted.

**Data flow**: It receives a command. It checks that the first word is an absolute path, extracts a lookup name from that path, finds rules for that name, and verifies the path if the policy has known paths for the name. It then rewrites only the program part to the short name for matching, and marks matches with the resolved original path.

**Call relations**: This supports the optional host-executable resolution path used during command matching. It calls `executable_path_lookup_key` to derive the short executable name and then uses the same rule matching style as exact command lookup.

*Call graph*: calls 2 internal fn (executable_path_lookup_key, try_from); 3 external calls (get_vec, new, once).


##### `upsert_domain`  (lines 337–340)

```
fn upsert_domain(entries: &mut Vec<String>, host: &str)
```

**Purpose**: Adds a host to a domain list while making sure it appears only once. If the host was already present, it is moved to the newest position.

**Data flow**: It receives a mutable list and a host string. It removes any existing copy of that host, then pushes the host onto the end of the list.

**Call relations**: This helper is called by `Policy::compiled_network_domains`. It keeps the compiled allow and deny lists free of duplicates while preserving the effect of later rules.

*Call graph*: called by 1 (compiled_network_domains).


##### `render_pattern_token`  (lines 342–347)

```
fn render_pattern_token(token: &PatternToken) -> String
```

**Purpose**: Turns one command-pattern token into a readable string. Single words stay as-is, while alternatives are shown in a bracketed form.

**Data flow**: It receives a pattern token. If the token is a single value, it returns that value. If the token is a set of alternatives, it joins them with `|` and wraps them in brackets, such as `[build|test]`.

**Call relations**: This helper is used when allowed prefix rules are presented as plain strings. It translates internal pattern pieces into a format a caller can display or compare.

*Call graph*: 1 external calls (format!).


##### `Evaluation::is_match`  (lines 358–362)

```
fn is_match(&self) -> bool
```

**Purpose**: Tells whether an evaluation was based on at least one real policy rule. A fallback-only decision does not count as a true rule match.

**Data flow**: It reads the evaluation’s matched rules. If any match is not a heuristics fallback match, it returns `true`; otherwise it returns `false`.

**Call relations**: This helps callers distinguish “a written rule matched” from “the system guessed using the fallback.” It only inspects the `Evaluation` it is called on.


##### `Evaluation::from_matches`  (lines 365–374)

```
fn from_matches(matched_rules: Vec<RuleMatch>) -> Self
```

**Purpose**: Builds the final evaluation report from a non-empty list of rule matches. It chooses the strongest decision among the matches and keeps the evidence list.

**Data flow**: It receives matched rules and expects the list to contain at least one item. It asks each match for its decision, picks the maximum decision according to the project’s decision ordering, and returns an `Evaluation` with that decision and the original matches.

**Call relations**: This is called by `Policy::check`, `Policy::check_with_options`, and `Policy::check_multiple_with_options`. It is the final summarizing step after rule matching has produced the evidence.

*Call graph*: called by 3 (check, check_multiple_with_options, check_with_options).


### Core approval decision engines
These core modules apply approval, sandbox, patch, and network-decision logic on top of execution-policy results for user-facing enforcement.

### `core/src/tools/sandboxing.rs`

`domain_logic` · `request handling`

Tools in this system can do powerful things, such as running commands or changing files. This file is the safety desk they must pass through. It gives the rest of the codebase a shared vocabulary for three questions: “Do we need approval?”, “Can we remember that approval for later?”, and “How tightly should this tool be sandboxed?” A sandbox is a restricted environment, like letting someone work at a bench with only certain drawers unlocked.

The file includes a small approval cache, `ApprovalStore`, so if a user says “allow this for the session,” the same request does not keep interrupting them. `with_cached_approval` applies that cache to one or more approval keys, which matters for tools like patching that may touch several files at once.

It also defines traits, which are like promises a tool runtime makes. `Approvable` says how a tool asks for approval. `Sandboxable` says how it prefers to be sandboxed. `ToolRuntime` ties those together with the actual act of running the tool.

The helper functions protect an important edge case: some file rules deny read access to particular paths. Those denials only exist inside the sandbox, so the code avoids “escaping” the sandbox when doing so would silently remove those protections. Finally, `SandboxAttempt::env_for` turns a planned command plus sandbox settings into an executable request.

#### Function details

##### `ApprovalStore::get`  (lines 46–52)

```
fn get(&self, key: &K) -> Option<ReviewDecision>
```

**Purpose**: Looks up whether a particular approval request has already been approved for this session. It lets later tool calls reuse an earlier “allow for session” decision instead of asking the user again.

**Data flow**: It receives a key that describes the approval request. It serializes that key into text, uses that text to search the store, and returns the saved review decision if one exists. If the key cannot be serialized or nothing is saved, it returns nothing.

**Call relations**: This is used by the approval caching flow inside `with_cached_approval`. Before asking the user or guardian review system, that flow checks every approval key through this lookup to see whether the request can be skipped.

*Call graph*: 1 external calls (to_string).


##### `ApprovalStore::put`  (lines 54–61)

```
fn put(&mut self, key: K, value: ReviewDecision)
```

**Purpose**: Saves a review decision under a request key, so the same kind of request can be recognized later in the session. It is mainly used to remember “approved for session” decisions.

**Data flow**: It receives an approval key and a decision. It serializes the key into text and, if that succeeds, stores the decision in the internal map under that text. It does not return a value; it changes the approval store.

**Call relations**: This is called by the approval caching path after a user approves something for the whole session. The cache stores each key separately so a later request touching only part of the same area can still be auto-approved.

*Call graph*: 1 external calls (to_string).


##### `with_cached_approval`  (lines 70–116)

```
async fn with_cached_approval(
    services: &SessionServices,
    // Name of the tool, used for metrics collection.
    tool_name: &str,
    keys: Vec<K>,
    fetch: F,
) -> ReviewDecision
```

**Purpose**: Runs the common “check cache, maybe ask, then remember the answer” approval flow. It prevents repeated approval prompts when the user has already approved the same request for the current session.

**Data flow**: It receives session services, a tool name for telemetry, a list of approval keys, and a callback that can fetch a fresh decision. If there are no keys, it simply asks for a fresh decision. Otherwise it checks whether every key is already approved for the session. If yes, it returns that approval immediately. If not, it calls the provided approval callback, records telemetry about the request, and caches the result for each key if the decision was “approved for session.”

**Call relations**: Several `start_approval_async` implementations call this when beginning approval for a tool. It sits between the specific tool runtime and the user or guardian approval process, adding shared caching and metrics around whatever approval prompt the tool provides.

*Call graph*: called by 3 (start_approval_async, start_approval_async, start_approval_async); 1 external calls (matches!).


##### `PermissionRequestPayload::bash`  (lines 141–155)

```
fn bash(command: String, description: Option<String>) -> Self
```

**Purpose**: Builds the standard permission-request payload for a bash command. This gives policy hooks and approval systems a consistent shape for command approval data.

**Data flow**: It receives a command string and an optional human-readable description. It creates a JSON object containing the command and, when present, the description. It returns a `PermissionRequestPayload` marked as a bash tool request.

**Call relations**: Approval-related code such as inline policy handling, prompts, and tool-specific permission payload builders call this when they need to describe a shell command to policy or review code.

*Call graph*: calls 1 internal fn (bash); called by 4 (handle_inline_policy_request, permission_request_payload, prompt, permission_request_payload); 3 external calls (new, Object, String).


##### `ExecApprovalRequirement::proposed_execpolicy_amendment`  (lines 182–194)

```
fn proposed_execpolicy_amendment(&self) -> Option<&ExecPolicyAmendment>
```

**Purpose**: Extracts the suggested future policy change, if this approval decision includes one. This is used when the system wants to ask not only “may I run this now?” but also “should similar commands be allowed later?”

**Data flow**: It reads the current approval requirement. If the requirement is either “needs approval” or “skip approval” and carries a proposed exec policy amendment, it returns a reference to that amendment. Otherwise it returns nothing.

**Call relations**: This method is a small helper for code that has already decided the approval requirement and now wants to inspect whether that decision came with a reusable policy suggestion.


##### `default_exec_approval_requirement`  (lines 202–238)

```
fn default_exec_approval_requirement(
    policy: AskForApproval,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> ExecApprovalRequirement
```

**Purpose**: Turns the configured approval policy into a concrete decision for one command: skip approval, ask for approval, or forbid the command. It is the default rulebook used when a tool has no special approval logic of its own.

**Data flow**: It receives the user’s approval policy and the current filesystem sandbox policy. It checks whether the policy normally requires asking and whether the filesystem is restricted. If granular approval is configured but sandbox approval prompts are disabled, it returns a forbidden result. If approval is needed, it returns “needs approval.” Otherwise it returns “skip approval” while still keeping the sandbox by default.

**Call relations**: Tool approval orchestration can fall back to this when `Approvable::exec_approval_requirement` does not provide a custom answer. It converts broad configuration into the specific instruction the tool runner needs.

*Call graph*: 1 external calls (matches!).


##### `sandbox_override_for_first_attempt`  (lines 246–275)

```
fn sandbox_override_for_first_attempt(
    sandbox_permissions: SandboxPermissions,
    exec_approval_requirement: &ExecApprovalRequirement,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
)
```

**Purpose**: Decides whether the first attempt to run a command should bypass the sandbox. It balances convenience for trusted or escalated commands with the need to keep read-denial protections in force.

**Data flow**: It receives requested sandbox permissions, the approval requirement, and the filesystem sandbox policy. First it checks whether unsandboxed execution is safe under the current filesystem rules. If not, it refuses to bypass the sandbox. If the approval requirement explicitly says to skip approval and bypass the sandbox, it allows bypassing. Otherwise, it bypasses only when the requested permissions require escalation.

**Call relations**: The main tool running flow calls this when preparing the first run attempt. It relies on `unsandboxed_execution_allowed` and the sandbox permission flags to choose between a normal sandboxed attempt and an intentionally unsandboxed one.

*Call graph*: calls 2 internal fn (unsandboxed_execution_allowed, requires_escalated_permissions); called by 1 (run); 1 external calls (matches!).


##### `unsandboxed_execution_allowed`  (lines 283–287)

```
fn unsandboxed_execution_allowed(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> bool
```

**Purpose**: Checks whether it is safe to run without the filesystem sandbox. It protects denied-read rules, because those rules only work while the sandbox is active.

**Data flow**: It receives the filesystem sandbox policy. It asks whether that policy contains denied-read restrictions. If there are denied reads, it returns false; otherwise it returns true.

**Call relations**: This helper is used by command-running, action selection, escalation handling, and sandbox permission adjustment code. Those callers use it before allowing sandbox bypass so they do not accidentally grant access to files that were supposed to stay unreadable.

*Call graph*: calls 1 internal fn (has_denied_read_restrictions); called by 5 (run, determine_action, shell_request_escalation_execution, sandbox_override_for_first_attempt, sandbox_permissions_preserving_denied_reads).


##### `sandbox_permissions_preserving_denied_reads`  (lines 289–303)

```
fn sandbox_permissions_preserving_denied_reads(
    sandbox_permissions: SandboxPermissions,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> SandboxPermissions
```

**Purpose**: Adjusts sandbox permissions so denied-read protections are not lost. If escalation would normally mean “run outside the sandbox,” this function can turn that back into a normal sandboxed run when denied reads are active.

**Data flow**: It receives requested sandbox permissions and the filesystem sandbox policy. If the request requires escalation and unsandboxed execution is not allowed, it changes the permission choice to the default sandboxed mode. Otherwise it leaves the requested permissions unchanged.

**Call relations**: Network approval setup and tool-running paths call this before deciding the final execution environment. It works with `unsandboxed_execution_allowed` to keep sensitive read restrictions alive even during escalated requests.

*Call graph*: calls 2 internal fn (unsandboxed_execution_allowed, requires_escalated_permissions); called by 5 (network_approval_spec, run, try_run_zsh_fork, network_approval_spec, run).


##### `managed_network_for_sandbox_permissions`  (lines 305–314)

```
fn managed_network_for_sandbox_permissions(
    network: Option<&NetworkProxy>,
    sandbox_permissions: SandboxPermissions,
) -> Option<&NetworkProxy>
```

**Purpose**: Decides whether the managed network proxy should be used for a run. If a command is escalated to run outside the normal sandbox, the managed network proxy is removed.

**Data flow**: It receives an optional network proxy and the sandbox permissions for the request. If the permissions require escalation, it returns no proxy. Otherwise it passes through the original proxy unchanged.

**Call relations**: Tool-running and network approval code call this while preparing execution. It connects the sandbox choice to network control, so sandboxed runs can use managed networking while escalated runs do not pretend to be under that same managed network enforcement.

*Call graph*: calls 1 internal fn (requires_escalated_permissions); called by 6 (explicit_escalation_prepares_exec_without_managed_network, network_approval_spec, run, try_run_zsh_fork, network_approval_spec, run).


##### `Approvable::sandbox_permissions`  (lines 330–332)

```
fn sandbox_permissions(&self, _req: &Req) -> SandboxPermissions
```

**Purpose**: Provides the per-request sandbox permission preference for a tool. The default says to use the normal ambient sandbox policy.

**Data flow**: It receives the tool request but, by default, does not inspect it. It returns `UseDefault`, meaning the current session’s normal sandbox permissions should apply.

**Call relations**: Tool runtimes that implement `Approvable` inherit this behavior unless they override it. The broader tool execution flow asks for these permissions before choosing how the command should be sandboxed.


##### `Approvable::should_bypass_approval`  (lines 334–340)

```
fn should_bypass_approval(&self, policy: AskForApproval, already_approved: bool) -> bool
```

**Purpose**: Answers whether the approval prompt can be skipped. By default, it skips approval if the request was already approved or if the global policy says never ask.

**Data flow**: It receives the configured approval policy and a flag saying whether this request has already been approved. If already approved, it returns true. Otherwise it returns true only for the “never ask” policy and false for other policies.

**Call relations**: Tool runtimes use this default decision unless they need custom behavior. It is part of the approval path that decides whether to show a prompt or move straight to execution.

*Call graph*: 1 external calls (matches!).


##### `Approvable::exec_approval_requirement`  (lines 344–346)

```
fn exec_approval_requirement(&self, _req: &Req) -> Option<ExecApprovalRequirement>
```

**Purpose**: Lets a tool provide a custom approval requirement for a specific request. The default provides no custom answer, meaning the shared policy-based rules should be used instead.

**Data flow**: It receives the tool request but, by default, does not inspect it. It returns nothing, which signals the caller to fall back to the normal approval requirement calculation.

**Call relations**: The approval orchestration asks this before using default policy logic. Tool runtimes can override it when they have special knowledge about whether a command should be allowed, denied, or approved.


##### `Approvable::permission_request_payload`  (lines 350–352)

```
fn permission_request_payload(&self, _req: &Req) -> Option<PermissionRequestPayload>
```

**Purpose**: Lets a tool describe its request in a standard form for approval-time policy hooks. The default says there is no extra payload.

**Data flow**: It receives the tool request but, by default, ignores it. It returns nothing, meaning no hook-specific permission payload is supplied.

**Call relations**: Approval flows can ask a runtime for this payload before guardian or user approval. Tools that need policy hooks to inspect command details override this, often using helpers such as `PermissionRequestPayload::bash`.


##### `Approvable::wants_no_sandbox_approval`  (lines 355–363)

```
fn wants_no_sandbox_approval(&self, policy: AskForApproval) -> bool
```

**Purpose**: Decides whether the tool should ask for approval to run without the sandbox. This is used for cases where the normal sandbox might block the command and the system may need permission to retry with fewer restrictions.

**Data flow**: It receives the configured approval policy. It returns true for policies that allow asking after failure or when trust is required, false for policies that never ask or only ask on request, and follows the granular policy’s sandbox-approval setting when granular controls are active.

**Call relations**: Tool approval and retry logic use this default unless a runtime overrides it. It helps determine whether a failed sandboxed command can lead to a no-sandbox approval prompt.


##### `Sandboxable::escalate_on_failure`  (lines 374–376)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: States whether a sandboxed tool is allowed to try a more permissive path after failure. The default says yes.

**Data flow**: It takes no request-specific input. It returns true, meaning the runtime may consider escalation after a sandbox-related failure.

**Call relations**: Tool runtimes that implement `Sandboxable` inherit this unless they override it. The execution flow can consult it when deciding whether a failed sandbox attempt should lead to an approval or retry path.


##### `ToolRuntime::network_approval_spec`  (lines 393–395)

```
fn network_approval_spec(&self, _req: &Req, _ctx: &ToolCtx) -> Option<NetworkApprovalSpec>
```

**Purpose**: Lets a tool describe what network access it wants approved. The default says the tool does not need a special network approval request.

**Data flow**: It receives the tool request and the tool context, but by default does not inspect them. It returns nothing, meaning no network approval specification is provided.

**Call relations**: The tool-running orchestration can ask this before execution when network access may matter. Specific runtimes override it when they need to request or explain network use.


##### `ToolRuntime::sandbox_cwd`  (lines 397–399)

```
fn sandbox_cwd(&self, _req: &'a Req) -> Option<&'a AbsolutePathBuf>
```

**Purpose**: Lets a tool provide a custom working directory for sandbox policy decisions. The default says there is no special sandbox working directory.

**Data flow**: It receives the tool request and, by default, ignores it. It returns nothing, so the caller uses the normal sandbox working directory.

**Call relations**: Execution setup can call this while preparing a sandbox attempt. Tools that need path rules interpreted from a particular directory can override it.


##### `SandboxAttempt::env_for`  (lines 424–452)

```
fn env_for(
        &self,
        command: SandboxCommand,
        options: ExecOptions,
        network: Option<&NetworkProxy>,
    ) -> Result<crate::sandboxing::ExecRequest, CodexErr>
```

**Purpose**: Builds the final executable request for a command under a specific sandbox attempt. It translates high-level sandbox settings into the concrete environment the command runner needs.

**Data flow**: It receives a sandbox command, execution options, and an optional network proxy. It sends the command plus permissions, sandbox type, working directory, platform-specific sandbox settings, and network enforcement choice to the sandbox manager for transformation. If that succeeds, it wraps the transformed request with execution options and workspace roots and returns it. If transformation fails, it returns a Codex error.

**Call relations**: Tool runtimes call this during their `run` paths, including command and zsh-fork execution flows. It hands the sandbox manager all the details needed to prepare the command, then gives the resulting execution request back to the runner.

*Call graph*: calls 2 internal fn (from_sandbox_exec_request, transform); called by 3 (run, try_run_zsh_fork, run); 1 external calls (to_vec).


### `core/src/exec_policy.rs`

`domain_logic` · `config load, request handling, and policy updates`

This file is the command gatekeeper. Before Codex runs a command, it needs to know whether the command is explicitly allowed, needs approval, or is forbidden. Without this file, commands would either run too freely or be blocked without a consistent reason.

The file works like a security desk. First it loads rule files ending in `.rules` from configured `rules` folders. Lower-priority configuration layers are read first, so higher-priority layers can override them. If a rule file has a parsing problem, the system can keep going with an empty policy but report a warning.

At run time, `ExecPolicyManager` holds the current policy in a safely replaceable shared pointer. When a command arrives, it may split wrapper commands such as `bash -lc "..."` into the real inner commands. It then checks all parsed commands against policy rules. If no rule matches, it falls back to safety heuristics: known safe commands may run, dangerous commands usually prompt or fail, and sandbox settings influence whether approval is needed.

The file can also append new allow rules or network rules to the default policy file and immediately refresh the in-memory policy. A semaphore, which is a one-at-a-time lock, prevents two updates from writing at once.

#### Function details

##### `child_uses_parent_exec_policy`  (lines 137–159)

```
fn child_uses_parent_exec_policy(parent_config: &Config, child_config: &Config) -> bool
```

**Purpose**: Checks whether a child configuration should reuse the parent configuration's executable policy. This matters when spawning related sessions, because policy inheritance is only safe if both configurations point at the same policy sources and requirements.

**Data flow**: It receives a parent `Config` and a child `Config`. It extracts the active configuration folders from each, compares whether user and project policy rules are ignored in the same way, and compares any required policy overlay. It returns `true` only when all those policy-related pieces match.

**Call relations**: When `inherited_exec_policy_for_source` is deciding whether a child can inherit policy from its parent, it calls this function as the compatibility check.

*Call graph*: called by 1 (inherited_exec_policy_for_source).


##### `is_policy_match`  (lines 161–166)

```
fn is_policy_match(rule_match: &RuleMatch) -> bool
```

**Purpose**: Tells whether a rule match came from an explicit policy rule rather than from a fallback safety guess. This distinction is important because explicit user or project rules should be treated differently from automatic heuristics.

**Data flow**: It receives a `RuleMatch`. If the match is a prefix rule from policy, it returns `true`; if it is a heuristic match, it returns `false`.

**Call relations**: This is a small local helper used when later decisions need to know whether a policy rule, not a built-in safety fallback, caused a prompt, allow, or forbid result.


##### `prompt_is_rejected_by_policy`  (lines 174–197)

```
fn prompt_is_rejected_by_policy(
    approval_policy: AskForApproval,
    prompt_is_rule: bool,
) -> Option<&'static str>
```

**Purpose**: Decides whether the current approval settings forbid showing an approval prompt to the user. For example, if approval is set to never ask, a command that would need approval must be rejected instead.

**Data flow**: It receives the approval policy and a flag saying whether the prompt came from a rule. It checks broad modes like `Never` and detailed granular settings for rule approval or sandbox approval. It returns no reason when prompting is allowed, or a fixed human-readable rejection reason when prompting is not allowed.

**Call relations**: `ExecPolicyManager::create_exec_approval_requirement_for_command` calls this after policy evaluation says a command should prompt, so the final result can become either `NeedsApproval` or `Forbidden` depending on user settings.

*Call graph*: called by 1 (create_exec_approval_requirement_for_command).


##### `ExecPolicyManager::new`  (lines 250–255)

```
fn new(policy: Arc<Policy>) -> Self
```

**Purpose**: Creates an `ExecPolicyManager` around an already-built policy. It sets up both the current shared policy and the one-at-a-time update lock.

**Data flow**: It receives a shared `Policy`. It stores that policy in an atomic swap container, which lets readers see the current policy while updates replace it safely, and creates a semaphore with one permit. It returns a ready-to-use manager.

**Call relations**: This is used by loading code, defaults, runtime setup, and tests whenever a manager is needed around a known policy.

*Call graph*: called by 4 (exec_approval_requirement_for_command, mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision, mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled, verify_approval_requirement_for_unsafe_powershell_command); 2 external calls (from, new).


##### `ExecPolicyManager::load`  (lines 258–264)

```
async fn load(config_stack: &ConfigLayerStack) -> Result<Self, ExecPolicyError>
```

**Purpose**: Loads executable policy rules from the configuration stack and returns a manager for them. If rule parsing fails, it logs a warning and uses an empty policy rather than stopping the whole system.

**Data flow**: It receives a `ConfigLayerStack`. It asks `load_exec_policy_with_warning` for a policy plus any non-fatal warning, logs the warning if present, wraps the policy in an `Arc`, and returns a new `ExecPolicyManager`.

**Call relations**: Startup and spawning paths call this when they need the policy manager for a session. It delegates the actual file reading and parsing to `load_exec_policy_with_warning`, then uses `ExecPolicyManager::new` to package the result.

*Call graph*: calls 1 internal fn (load_exec_policy_with_warning); called by 3 (returns_empty_policy_when_no_policy_files_exist, spawn_internal, guardian_subagent_does_not_inherit_parent_exec_policy_rules); 3 external calls (new, new, warn!).


##### `ExecPolicyManager::current`  (lines 266–268)

```
fn current(&self) -> Arc<Policy>
```

**Purpose**: Returns the policy that is currently active. Callers use it when they need a stable snapshot for checking or updating rules.

**Data flow**: It reads the manager's atomically stored policy pointer and returns a cloned shared pointer to the current `Policy`. The policy itself is not changed.

**Call relations**: Command checking and both update methods call this before evaluating or cloning the current policy.

*Call graph*: called by 3 (append_amendment_and_update, append_network_rule_and_update, create_exec_approval_requirement_for_command); 1 external calls (load_full).


##### `ExecPolicyManager::create_exec_approval_requirement_for_command`  (lines 270–375)

```
async fn create_exec_approval_requirement_for_command(
        &self,
        req: ExecApprovalRequest<'_>,
    ) -> ExecApprovalRequirement
```

**Purpose**: Turns a command into the final answer Codex needs: run it, ask for approval, or block it. It combines explicit policy rules, command parsing, safety heuristics, sandbox state, and approval settings.

**Data flow**: It receives an approval request containing the command, approval mode, permission profile, sandbox details, and any requested prefix rule. It gets the current policy, rewrites shell wrapper commands into the inner commands when possible, checks them against policy with a fallback decision function, and then builds an `ExecApprovalRequirement`. The result may include a reason and a proposed policy amendment for future runs.

**Call relations**: This is the main request-time policy decision point. It calls `current`, `commands_for_exec_policy`, `render_decision_for_unmatched_command` through a fallback closure, amendment-derivation helpers, `prompt_is_rejected_by_policy`, and reason-formatting helpers before returning the decision to the command execution path.

*Call graph*: calls 7 internal fn (current, commands_for_exec_policy, derive_forbidden_reason, derive_prompt_reason, derive_requested_execpolicy_amendment_from_prefix_rule, prompt_is_rejected_by_policy, try_derive_execpolicy_amendment_for_allow_rules).


##### `ExecPolicyManager::append_amendment_and_update`  (lines 377–425)

```
async fn append_amendment_and_update(
        &self,
        codex_home: &Path,
        amendment: &ExecPolicyAmendment,
    ) -> Result<(), ExecPolicyUpdateError>
```

**Purpose**: Adds a new allow-prefix rule to the default policy file and updates the in-memory policy so the change takes effect immediately. This is used after a user approves a suggested executable policy amendment.

**Data flow**: It receives the Codex home directory and an `ExecPolicyAmendment`. It takes the update lock, computes the default rules file path, appends the allow rule on a blocking worker thread, checks whether the current policy already allows it, and if not, clones the current policy, adds the rule, and swaps the updated policy into place. It returns success or a detailed update error.

**Call relations**: Policy amendment flows call this after approval. It uses `default_policy_path` for the file location and `current` to compare and refresh the in-memory policy.

*Call graph*: calls 2 internal fn (current, default_policy_path); 4 external calls (new, store, acquire, spawn_blocking).


##### `ExecPolicyManager::append_network_rule_and_update`  (lines 427–471)

```
async fn append_network_rule_and_update(
        &self,
        codex_home: &Path,
        host: &str,
        protocol: NetworkRuleProtocol,
        decision: Decision,
        justification: Option<
```

**Purpose**: Adds a network policy rule to disk and updates the active in-memory policy. This lets newly approved or denied network access be remembered and applied right away.

**Data flow**: It receives the Codex home directory, host, protocol, decision, and optional justification. It takes the update lock, appends the rule to the default policy file on a blocking worker thread, clones the current policy, adds the same network rule in memory, and swaps that updated policy into active use. It returns success or an update error.

**Call relations**: Network approval flows use this when a host/protocol decision should be saved. It follows the same lock, file-append, and in-memory-refresh pattern as `append_amendment_and_update`.

*Call graph*: calls 2 internal fn (current, default_policy_path); 4 external calls (new, store, acquire, spawn_blocking).


##### `ExecPolicyManager::default`  (lines 475–477)

```
fn default() -> Self
```

**Purpose**: Creates a manager with no executable policy rules. This is a safe baseline for tests or cases where policy has not been loaded yet.

**Data flow**: It builds an empty `Policy`, wraps it in a shared pointer, and passes it to `ExecPolicyManager::new`. The returned manager will rely on fallback heuristics unless rules are later added.

**Call relations**: Many tests and some internal setup paths use this when they need a working manager without reading policy files.

*Call graph*: called by 13 (append_execpolicy_amendment_rejects_empty_prefix, append_execpolicy_amendment_updates_policy_and_file, empty_bash_lc_script_falls_back_to_original_command, exec_approval_requirement_falls_back_to_heuristics, request_rule_falls_back_when_prefix_rule_does_not_approve_all_commands, request_rule_uses_prefix_rule, whitespace_bash_lc_script_falls_back_to_original_command, spawn_internal, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx (+3 more)); 3 external calls (new, new, empty).


##### `check_execpolicy_for_warnings`  (lines 480–485)

```
async fn check_execpolicy_for_warnings(
    config_stack: &ConfigLayerStack,
) -> Result<Option<ExecPolicyError>, ExecPolicyError>
```

**Purpose**: Loads policy only far enough to find non-fatal warnings, especially parse warnings. This lets the application report rule problems without necessarily failing startup.

**Data flow**: It receives a configuration stack, calls `load_exec_policy_with_warning`, ignores the loaded policy, and returns the optional warning. Serious read errors still come back as errors.

**Call relations**: Warning-checking code calls this as a lightweight validation path. It shares the same loader as `ExecPolicyManager::load`, so warnings are discovered consistently.

*Call graph*: calls 1 internal fn (load_exec_policy_with_warning).


##### `exec_policy_message_for_display`  (lines 487–507)

```
fn exec_policy_message_for_display(source: &codex_execpolicy::Error) -> String
```

**Purpose**: Turns a raw policy parser error into a shorter message suitable for showing to a person. Parser errors can contain extra technical wrapping, so this pulls out the useful part.

**Data flow**: It receives a `codex_execpolicy::Error`, converts it to text, looks for a line starting with `error: ` or a Starlark error detail, and otherwise uses the first trimmed line. It returns the cleaned-up message string.

**Call relations**: `format_exec_policy_error_with_source` calls this when building the final user-facing error message for a parse failure.

*Call graph*: called by 1 (format_exec_policy_error_with_source); 1 external calls (to_string).


##### `parse_starlark_line_from_message`  (lines 509–523)

```
fn parse_starlark_line_from_message(message: &str) -> Option<(PathBuf, usize)>
```

**Purpose**: Tries to recover a file path and line number from a Starlark parser error message. Starlark is the rule language engine used underneath, and its raw messages sometimes hide the useful location in text.

**Data flow**: It receives an error message string. It inspects the first line, splits out a path, line, and column if they match the expected format, rejects line zero, and returns the path and line number when successful.

**Call relations**: `format_exec_policy_error_with_source` uses this as a backup source of location information when structured error location data is missing or misleading.

*Call graph*: called by 1 (format_exec_policy_error_with_source); 1 external calls (from).


##### `format_exec_policy_error_with_source`  (lines 525–556)

```
fn format_exec_policy_error_with_source(error: &ExecPolicyError) -> String
```

**Purpose**: Formats an executable policy error into a clear message for humans, including source location when possible. This is especially helpful when a `.rules` file has a syntax or policy-language problem.

**Data flow**: It receives an `ExecPolicyError`. For parse errors, it gathers structured location data from the parser, also tries to parse location from the raw message, chooses the best line number, cleans the message, and returns a formatted string. For other errors, it returns the normal error text.

**Call relations**: User-facing error reporting calls this when policy loading fails or warns. It combines `exec_policy_message_for_display` and `parse_starlark_line_from_message` to make parser errors easier to act on.

*Call graph*: calls 2 internal fn (exec_policy_message_for_display, parse_starlark_line_from_message); 2 external calls (to_string, format!).


##### `load_exec_policy_with_warning`  (lines 558–566)

```
async fn load_exec_policy_with_warning(
    config_stack: &ConfigLayerStack,
) -> Result<(Policy, Option<ExecPolicyError>), ExecPolicyError>
```

**Purpose**: Loads executable policy while treating parse failures as warnings instead of fatal errors. This allows Codex to continue with an empty policy if the rules are malformed.

**Data flow**: It receives a configuration stack and calls `load_exec_policy`. If loading succeeds, it returns the policy and no warning. If parsing fails, it returns an empty policy plus the parse error as a warning. If reading directories or files fails, it returns the error.

**Call relations**: `ExecPolicyManager::load` and `check_execpolicy_for_warnings` call this so both startup and validation use the same warning behavior.

*Call graph*: calls 1 internal fn (load_exec_policy); called by 2 (load, check_execpolicy_for_warnings); 1 external calls (empty).


##### `load_exec_policy`  (lines 568–625)

```
async fn load_exec_policy(config_stack: &ConfigLayerStack) -> Result<Policy, ExecPolicyError>
```

**Purpose**: Reads all applicable `.rules` files from the active configuration layers and builds one executable policy from them. It also overlays any policy required directly by configuration.

**Data flow**: It receives a `ConfigLayerStack`. It walks active layers from lowest to highest precedence, skips user/project rule folders when configured to ignore them, collects `.rules` files from each layer's `rules` directory, reads and parses each file, builds the combined `Policy`, and merges any required policy overlay. It returns the final policy or a read/parse error.

**Call relations**: This is the core loader behind `load_exec_policy_with_warning` and other config-state building paths. It delegates directory scanning to `collect_policy_files` and parsing to `PolicyParser`.

*Call graph*: calls 5 internal fn (get_layers, ignore_user_and_project_exec_policy_rules, requirements, collect_policy_files, new); called by 4 (loads_requirements_exec_policy_without_rules_files, merges_requirements_exec_policy_with_file_rules, load_exec_policy_with_warning, build_config_state_with_mtimes); 5 external calls (new, read_to_string, matches!, debug!, trace!).


##### `render_decision_for_unmatched_command`  (lines 628–745)

```
fn render_decision_for_unmatched_command(
    command: &[String],
    context: UnmatchedCommandContext<'_>,
) -> Decision
```

**Purpose**: Chooses what to do with a command when no explicit executable policy rule matched it. It is the safety fallback that balances known-safe commands, dangerous commands, approval settings, and sandbox protection.

**Data flow**: It receives command words and an `UnmatchedCommandContext` containing approval mode, permission profile, sandbox state, parsing details, and command origin. It checks whether the command is known safe, whether it might be dangerous, whether Windows filesystem restrictions lack a sandbox backend, and how the current approval mode treats unmatched commands. It returns `Allow`, `Prompt`, or `Forbidden`.

**Call relations**: `ExecPolicyManager::create_exec_approval_requirement_for_command` passes this as the fallback used by policy evaluation whenever no explicit rule applies. It calls `profile_has_managed_filesystem_restrictions` and command safety classifiers.

*Call graph*: calls 5 internal fn (profile_has_managed_filesystem_restrictions, command_might_be_dangerous, is_dangerous_powershell_words, is_known_safe_command, is_safe_powershell_words); 2 external calls (cfg!, matches!).


##### `profile_has_managed_filesystem_restrictions`  (lines 747–755)

```
fn profile_has_managed_filesystem_restrictions(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Checks whether a permission profile represents managed, restricted filesystem access without full disk write permission. This matters for conservative decisions when sandbox enforcement may not really be active.

**Data flow**: It receives a `PermissionProfile`, gets its filesystem sandbox policy, and checks that the profile is managed, restricted, and not allowed full disk writes. It returns a boolean.

**Call relations**: `render_decision_for_unmatched_command` calls this when deciding whether unmatched commands should be treated more cautiously, especially on Windows when the sandbox backend is disabled.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy); called by 1 (render_decision_for_unmatched_command); 1 external calls (matches!).


##### `default_policy_path`  (lines 757–759)

```
fn default_policy_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the default executable policy file under the Codex home directory. This keeps all rule-appending code writing to the same place.

**Data flow**: It receives the Codex home path, appends `rules`, then appends `default.rules`, and returns the resulting path.

**Call relations**: Both `append_amendment_and_update` and `append_network_rule_and_update` call this before writing saved policy changes.

*Call graph*: called by 2 (append_amendment_and_update, append_network_rule_and_update); 1 external calls (join).


##### `commands_for_exec_policy`  (lines 761–799)

```
fn commands_for_exec_policy(command: &[String]) -> ExecPolicyCommands
```

**Purpose**: Prepares a command for policy checking by extracting the real commands hidden inside common shell wrappers when possible. This lets rules apply to `python script.py` inside `bash -lc "python script.py"`, not just to `bash` itself.

**Data flow**: It receives the original command argument list. It first tries plain parsing for shell `-lc` forms, then on Windows tries PowerShell command parsing, then falls back to a single-command prefix parser, and finally uses the original command unchanged. It returns the list of command segments, whether complex parsing was used, and the command origin.

**Call relations**: `ExecPolicyManager::create_exec_approval_requirement_for_command` calls this before evaluating policy, so all later rule checks and fallback heuristics operate on the best available command words.

*Call graph*: calls 3 internal fn (parse_shell_lc_plain_commands, parse_shell_lc_single_command_prefix, parse_powershell_command_into_plain_commands); called by 1 (create_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `try_derive_execpolicy_amendment_for_prompt_rules`  (lines 811–830)

```
fn try_derive_execpolicy_amendment_for_prompt_rules(
    matched_rules: &[RuleMatch],
) -> Option<ExecPolicyAmendment>
```

**Purpose**: Suggests an allow rule when a command prompted only because of fallback heuristics, not because of an explicit prompt rule. This helps future similar commands avoid repeated approval prompts.

**Data flow**: It receives the matched rule records from an evaluation. If any explicit policy rule already prompted, it returns nothing because an amendment would not remove that requirement. Otherwise it finds the first heuristic prompt match and turns its command into an `ExecPolicyAmendment`.

**Call relations**: The prompt branch of `ExecPolicyManager::create_exec_approval_requirement_for_command` uses this as a fallback suggestion when no user-requested prefix amendment was suitable.

*Call graph*: 1 external calls (iter).


##### `try_derive_execpolicy_amendment_for_allow_rules`  (lines 835–851)

```
fn try_derive_execpolicy_amendment_for_allow_rules(
    matched_rules: &[RuleMatch],
) -> Option<ExecPolicyAmendment>
```

**Purpose**: Suggests an allow rule for a command that was allowed only by heuristics. The suggestion can later be used to bypass sandbox for similar commands after a sandbox failure approval flow.

**Data flow**: It receives matched rule records. If any explicit policy rule matched, it returns nothing because policy already says what to do. Otherwise it finds a heuristic allow match and turns its command into an `ExecPolicyAmendment`.

**Call relations**: `ExecPolicyManager::create_exec_approval_requirement_for_command` calls this in the allow case to attach a possible amendment to a `Skip` result.

*Call graph*: called by 1 (create_exec_approval_requirement_for_command); 1 external calls (iter).


##### `derive_requested_execpolicy_amendment_from_prefix_rule`  (lines 853–892)

```
fn derive_requested_execpolicy_amendment_from_prefix_rule(
    prefix_rule: Option<&Vec<String>>,
    matched_rules: &[RuleMatch],
    exec_policy: &Policy,
    commands: &[Vec<String>],
    exec_poli
```

**Purpose**: Validates a user-requested prefix rule before suggesting it as a policy amendment. It avoids overly broad suggestions like allowing all `bash` or all `python` commands.

**Data flow**: It receives an optional prefix rule, existing matched rules, the current policy, parsed commands, the fallback decision function, and match options. It rejects missing, empty, banned, or conflicting prefixes, then tests whether adding the prefix would allow every parsed command. It returns an amendment only if the proposed rule is safe and effective.

**Call relations**: `ExecPolicyManager::create_exec_approval_requirement_for_command` calls this before using other amendment suggestions. It delegates the simulated-policy check to `prefix_rule_would_approve_all_commands`.

*Call graph*: calls 1 internal fn (prefix_rule_would_approve_all_commands); called by 1 (create_exec_approval_requirement_for_command); 2 external calls (new, iter).


##### `prefix_rule_would_approve_all_commands`  (lines 894–915)

```
fn prefix_rule_would_approve_all_commands(
    exec_policy: &Policy,
    prefix_rule: &[String],
    commands: &[Vec<String>],
    exec_policy_fallback: &impl Fn(&[String]) -> Decision,
    match_opti
```

**Purpose**: Tests a proposed allow-prefix rule without changing the real policy. It answers whether that new rule would actually approve all command pieces being evaluated.

**Data flow**: It receives the current policy, proposed prefix, parsed command list, fallback decision function, and match options. It clones the policy, tries to add the allow rule, then checks every command against the cloned policy. It returns `true` only if every command would become allowed.

**Call relations**: `derive_requested_execpolicy_amendment_from_prefix_rule` calls this as the final proof that a requested prefix amendment would solve the approval need.

*Call graph*: called by 1 (derive_requested_execpolicy_amendment_from_prefix_rule); 1 external calls (clone).


##### `derive_prompt_reason`  (lines 918–944)

```
fn derive_prompt_reason(command_args: &[String], evaluation: &Evaluation) -> Option<String>
```

**Purpose**: Builds a user-facing reason for an approval prompt when an explicit policy rule caused it. If the prompt came only from heuristics, it deliberately returns no reason.

**Data flow**: It receives the original command arguments and the policy evaluation. It renders the command as shell-like text, finds the most specific prompt prefix rule, and uses that rule's justification if present. It returns an optional reason string.

**Call relations**: `ExecPolicyManager::create_exec_approval_requirement_for_command` calls this when returning `NeedsApproval`, so the approval UI can explain policy-driven prompts.

*Call graph*: calls 1 internal fn (render_shlex_command); called by 1 (create_exec_approval_requirement_for_command); 1 external calls (format!).


##### `render_shlex_command`  (lines 946–948)

```
fn render_shlex_command(args: &[String]) -> String
```

**Purpose**: Formats command arguments into a readable shell-style command string. This makes error and prompt messages easier to understand.

**Data flow**: It receives a list of command arguments. It tries to quote and join them using shell-style escaping, and if that fails, falls back to joining with spaces. It returns the rendered command string.

**Call relations**: `derive_prompt_reason` and `derive_forbidden_reason` call this whenever they need to include a command in a human-readable message.

*Call graph*: called by 2 (derive_forbidden_reason, derive_prompt_reason); 1 external calls (try_join).


##### `derive_forbidden_reason`  (lines 953–980)

```
fn derive_forbidden_reason(command_args: &[String], evaluation: &Evaluation) -> String
```

**Purpose**: Builds a clear explanation for why a command was blocked. If a policy rule supplied a justification, that message is used.

**Data flow**: It receives the original command arguments and the evaluation result. It renders the command, finds the most specific forbidden prefix rule, and returns a message using either the rule's justification, the forbidden prefix, or a generic policy-blocked reason.

**Call relations**: `ExecPolicyManager::create_exec_approval_requirement_for_command` calls this when policy evaluation returns `Forbidden`, so callers can show a useful rejection message.

*Call graph*: calls 1 internal fn (render_shlex_command); called by 1 (create_exec_approval_requirement_for_command); 1 external calls (format!).


##### `collect_policy_files`  (lines 982–1032)

```
async fn collect_policy_files(dir: impl AsRef<Path>) -> Result<Vec<PathBuf>, ExecPolicyError>
```

**Purpose**: Finds all `.rules` files in one policy directory. Missing directories are treated as normal, because not every configuration layer has policy rules.

**Data flow**: It receives a directory path. It tries to read the directory, returns an empty list if it does not exist, reports read errors otherwise, scans entries, keeps regular files whose extension is `.rules`, sorts the paths, and returns them.

**Call relations**: `load_exec_policy` calls this for each configuration layer's `rules` directory before reading and parsing the files in precedence order.

*Call graph*: called by 1 (load_exec_policy); 5 external calls (as_ref, to_path_buf, new, read_dir, debug!).


### `core/src/network_policy_decision.rs`

`domain_logic` · `request handling and approval persistence`

This file sits between the network proxy, the user approval flow, and the execution policy system. In plain terms, it answers two questions: “Can we ask the user about this network request?” and “How do we record the user's answer as a rule?” Without this file, blocked network requests would be harder to explain, and approved network changes would not be converted into the format used by the sandbox policy engine.

The file first defines a small internal record, ExecPolicyNetworkRuleAmendment, which is the shape needed when saving a new network rule for the execution policy. It includes the network protocol, the allow-or-deny decision, and a human-readable reason.

For incoming policy decision payloads, the file checks that the request is actually one where the decider wants to ask the user. It then extracts the protocol and a non-empty host name, producing a NetworkApprovalContext that the approval prompt can use.

For already-blocked requests, it creates friendly messages such as “Network access to example.com was blocked...” and explains the reason in everyday terms where possible.

Finally, when a user approves or denies a network rule, it maps protocol names and actions from the approval system into the execution policy system. This is like translating a form filled out by a person into the exact wording needed by the rulebook.

#### Function details

##### `parse_network_policy_decision`  (lines 18–24)

```
fn parse_network_policy_decision(value: &str) -> Option<NetworkPolicyDecision>
```

**Purpose**: This small helper reads a text value from a blocked request and turns known policy words into the program's internal decision type. It only accepts the meaningful values this file cares about: deny and ask.

**Data flow**: It receives a string such as "deny" or "ask". It compares that string against the supported policy decision words. If the word is recognized, it returns the matching NetworkPolicyDecision; otherwise it returns nothing, so the caller knows the value was not useful.

**Call relations**: This function is used inside denied_network_policy_message when the code needs to decide whether a blocked request was truly denied by policy. It keeps that message-building function from having to compare raw text itself.


##### `network_approval_context_from_payload`  (lines 26–44)

```
fn network_approval_context_from_payload(
    payload: &NetworkPolicyDecisionPayload,
) -> Option<NetworkApprovalContext>
```

**Purpose**: This function decides whether a network policy decision payload contains enough trustworthy information to show an approval prompt. If it does, it builds the small context object the prompt needs: the host and the protocol.

**Data flow**: It receives a NetworkPolicyDecisionPayload, which may or may not represent a request that should be shown to the user. First it asks the payload whether it is an "ask" decision from the decider. Then it requires a protocol and a host name. It trims extra space from the host and rejects an empty host. If everything is valid, it returns a NetworkApprovalContext with the cleaned host and protocol; otherwise it returns nothing.

**Call relations**: This function calls is_ask_from_decider on the payload as its first gate. It is meant to be used when the system receives a network policy decision and needs to know whether that decision can become a user approval request.

*Call graph*: calls 1 internal fn (is_ask_from_decider).


##### `denied_network_policy_message`  (lines 46–72)

```
fn denied_network_policy_message(blocked: &BlockedRequest) -> Option<String>
```

**Purpose**: This function turns a blocked network request into a clear message for a person. It only produces a message when the request was actually denied by policy.

**Data flow**: It receives a BlockedRequest from the network proxy. It reads the request's decision text and uses parse_network_policy_decision to understand it. If the decision is not "deny", it returns nothing. If the host is blank, it returns a general blocked-by-policy message. If there is a host, it looks at the reason code and chooses a plain-language explanation, then returns a sentence naming the host and the reason it was blocked.

**Call relations**: record_blocked_request calls this when a blocked network request is being recorded or reported. This function does the user-facing explanation work, using format! to assemble the final sentence.

*Call graph*: called by 1 (record_blocked_request); 1 external calls (format!).


##### `execpolicy_network_rule_amendment`  (lines 74–102)

```
fn execpolicy_network_rule_amendment(
    amendment: &NetworkPolicyAmendment,
    network_approval_context: &NetworkApprovalContext,
    host: &str,
) -> ExecPolicyNetworkRuleAmendment
```

**Purpose**: This function converts a user's network policy choice into the rule-amendment format used by the execution policy system. It is used when the system needs to persist an allow or deny rule after an approval decision.

**Data flow**: It receives the user's NetworkPolicyAmendment, the NetworkApprovalContext that says which protocol was involved, and the host name the rule applies to. It maps the approval protocol into the matching execution-policy protocol. It maps the user's action into either an allow decision or a forbidden decision. It also builds a short justification such as allowing HTTPS access to a host. It returns an ExecPolicyNetworkRuleAmendment containing those translated pieces.

**Call relations**: persist_network_policy_amendment calls this when saving a network policy change. This function acts as the translator between the approval layer's language and the execution policy layer's language, then hands back a ready-to-save amendment.

*Call graph*: called by 1 (persist_network_policy_amendment); 1 external calls (format!).


### `core/src/safety.rs`

`domain_logic` · `request handling`

This file protects the user’s files when Codex applies a patch. A patch can create, delete, update, or move files, so the program needs a clear answer before doing anything: is this patch allowed automatically, does the user need to approve it, or should it be rejected outright?

The main idea is similar to a building security desk. If a visitor only wants to enter rooms they are already allowed to enter, they may pass with the right badge. If their request is unclear or goes outside the allowed area, security asks a human. If the rules say not to ask and the request is unsafe, security refuses.

The file uses several pieces of information: the patch contents, the user’s approval setting, the current permission profile, the filesystem sandbox policy, the current working directory, and Windows sandbox settings. A sandbox is a controlled environment that limits what the patch process can touch, like putting a messy task inside a sealed workbench.

The key result is a `SafetyCheck`: automatically approve with a chosen sandbox, ask the user, or reject with a human-readable reason. The file also checks whether every file path in the patch falls within writable roots, including move destinations. Importantly, even when paths look allowed, the code may still require a sandbox because filesystem tricks such as hard links could point outside the apparent project area.

#### Function details

##### `assess_patch_safety`  (lines 33–116)

```
fn assess_patch_safety(
    action: &ApplyPatchAction,
    policy: AskForApproval,
    permission_profile: &PermissionProfile,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Absol
```

**Purpose**: This is the main decision point for patch safety. It looks at the patch, approval rules, permission profile, writable filesystem areas, and sandbox availability, then decides whether to auto-approve, ask the user, or reject the patch.

**Data flow**: It receives the patch action, approval policy, permission settings, filesystem sandbox rules, current directory, and Windows sandbox level. First it rejects an empty patch. Then it checks whether the user’s approval policy allows automatic decisions, whether the patch stays inside writable paths, and whether a real sandbox can be used. It returns a `SafetyCheck`: either approval with a sandbox type, a request to ask the user, or rejection with a reason.

**Call relations**: This function is called by `apply_patch` before the patch is actually applied. During its decision, it asks `is_write_patch_constrained_to_writable_paths` whether the patch only writes where it should, calls `get_platform_sandbox` to see whether the operating system can enforce a sandbox, and uses `patch_rejection_reason` when it needs a clear explanation for refusing the patch.

*Call graph*: calls 3 internal fn (is_empty, is_write_patch_constrained_to_writable_paths, patch_rejection_reason); called by 1 (apply_patch); 2 external calls (get_platform_sandbox, matches!).


##### `patch_rejection_reason`  (lines 118–136)

```
fn patch_rejection_reason(
    permission_profile: &PermissionProfile,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> &'static str
```

**Purpose**: This helper chooses the message shown when a patch is rejected. It distinguishes between a truly read-only sandbox and a patch that tries to write outside the project or allowed area.

**Data flow**: It receives the permission profile, filesystem sandbox policy, and current directory. It checks whether the managed sandbox has full disk write access or any writable roots for the current directory. From that, it returns one of two fixed explanation strings: either writing is blocked by a read-only sandbox, or the patch is trying to write outside the project.

**Call relations**: This function is used only by `assess_patch_safety`, at the moments when the policy says Codex should not ask the user for sandbox approval and therefore must reject unsafe work instead. It calls into the sandbox policy to understand what write access exists before choosing the user-facing reason.

*Call graph*: calls 3 internal fn (get_writable_roots_with_cwd, has_full_disk_write_access, as_path); called by 1 (assess_patch_safety).


##### `is_write_patch_constrained_to_writable_paths`  (lines 138–193)

```
fn is_write_patch_constrained_to_writable_paths(
    action: &ApplyPatchAction,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> bool
```

**Purpose**: This helper checks whether every file path touched by a patch is inside an area that the sandbox policy says is writable. It is used to decide whether a patch can be treated as safely contained.

**Data flow**: It receives the patch action, filesystem sandbox policy, and current directory. For each changed file, it turns the path into an absolute path relative to the current directory, cleans up `.` and `..` path pieces without reading the disk, and asks the sandbox policy whether that path can be written. Adds, deletes, and updates must have writable source paths; moves must also have writable destination paths. It returns `true` only if every relevant path is writable.

**Call relations**: This function is called by `assess_patch_safety` while deciding whether automatic approval is possible. It reads the patch’s list of changes through `changes`, checks each one against the filesystem policy, and hands back a simple yes-or-no answer that drives the larger safety decision.

*Call graph*: calls 1 internal fn (changes); called by 1 (assess_patch_safety).


### Legacy policy compilation and matching
These legacy-policy files expose the old API, parse Starlark policies, and implement argument and program matching against compiled specs.

### `execpolicy-legacy/src/lib.rs`

`config` · `startup / config load`

This file is like the public counter at a workshop: the real tools live in separate rooms, but this is where outside code comes to ask for them. It declares the library’s internal modules, such as argument matching, policy parsing, program rules, and validation of executable calls. Then it re-exports the important types, so users of the library can write simple imports instead of knowing the internal file layout.

The file also embeds a default policy file directly into the compiled program. That means the program does not need to find a separate policy file on disk just to get its baseline rules. The helper function `get_default_policy` takes that embedded text, creates a `PolicyParser` for it, and turns it into a `Policy` object the rest of the system can use.

Without this file, other parts of the project would have to know many internal module paths, and there would be no single easy way to load the standard built-in policy. The important behavior to notice is that the default policy is included at compile time, not read from disk at runtime.

#### Function details

##### `get_default_policy`  (lines 42–45)

```
fn get_default_policy() -> starlark::Result<Policy>
```

**Purpose**: Loads the library’s built-in default execution policy and turns it into a usable `Policy`. Code uses this when it wants the standard rules without supplying a separate policy file.

**Data flow**: It starts with `DEFAULT_POLICY`, which is policy text embedded in the program when it is built. It creates a `PolicyParser` with the label `#default` and that text, then asks the parser to parse it. The result is either a ready-to-use `Policy` or an error explaining why the built-in policy could not be parsed.

**Call relations**: The application’s `main` function calls this during setup when it needs the default rules. `get_default_policy` hands the embedded text to `PolicyParser::new`, then relies on the parser to produce the final policy object that later checks attempted program executions.

*Call graph*: calls 1 internal fn (new); called by 1 (main).


### `execpolicy-legacy/src/policy_parser.rs`

`config` · `config load`

This file is the bridge between a policy file people write and the structured rules the execution policy engine uses later. The policy text is written in Starlark, a small Python-like configuration language. Instead of treating that text as plain data, the parser runs it in a controlled environment that exposes only the policy-building commands this project wants to allow.

The main flow starts with PolicyParser. It stores where the policy came from and the policy text itself. When asked to parse, it reads the text as Starlark, creates a temporary Starlark module, and installs special constants such as ARG_RFILE or ARG_POS_INT. These constants describe what kind of command-line argument is acceptable, for example a readable file or a positive integer.

A PolicyBuilder sits behind the scenes while the Starlark policy runs. Think of it like a clipboard held by the parser: every time the policy script calls define_program, forbid_substrings, or forbid_program_regex, information is added to that clipboard. After the script finishes, the builder turns the collected information into a Policy.

Important behavior: option names are checked for duplicates within a program definition, and forbidden program regular expressions are compiled during parsing. That means mistakes in the policy are caught early, before the policy is used to approve or reject real commands.

#### Function details

##### `PolicyParser::new`  (lines 29–34)

```
fn new(policy_source: &str, unparsed_policy: &str) -> Self
```

**Purpose**: Creates a parser for one policy text. It remembers both the policy source name, such as a filename, and the raw policy content that will be parsed later.

**Data flow**: It receives two pieces of text: where the policy came from and the policy body. It copies both into a new PolicyParser object. The result is a ready-to-use parser, but no parsing has happened yet.

**Call relations**: This is the setup step before PolicyParser::parse does the real work. Code that wants to load a policy first creates this object, then asks it to parse the stored text.


##### `PolicyParser::parse`  (lines 36–67)

```
fn parse(&self) -> starlark::Result<Policy>
```

**Purpose**: Reads and executes the Starlark policy text, then returns a structured Policy. This is where a written policy becomes enforceable rules.

**Data flow**: It starts with the stored policy source name and policy text. It parses the text as Starlark using an extended dialect, prepares a controlled set of global policy functions and argument-matcher constants, and runs the policy script. As the script runs, it fills a PolicyBuilder. After execution, it asks the builder to produce a Policy, or returns an error if parsing, execution, duplicate checks, or regular expression compilation fail.

**Call relations**: This is the central flow in the file. It creates the PolicyBuilder with PolicyBuilder::new, uses Starlark parsing and temporary module setup, exposes policy_builtins to the script, and finally relies on PolicyBuilder::build to hand back the finished Policy.

*Call graph*: calls 1 internal fn (new); 3 external calls (parse, extended_by, with_temp_heap).


##### `PolicyBuilder::new`  (lines 84–90)

```
fn new() -> Self
```

**Purpose**: Creates an empty collector for policy rules. It starts with no allowed program definitions, no forbidden program regular expressions, and no forbidden substrings.

**Data flow**: It takes no input. It creates empty internal containers: one for program rules, one for forbidden regex rules, and one for forbidden text snippets. The output is a PolicyBuilder ready to be filled while the Starlark policy runs.

**Call relations**: PolicyParser::parse calls this before evaluating the policy script. The built-in policy functions then add information to this builder as the script describes rules.

*Call graph*: 3 external calls (new, new, new).


##### `PolicyBuilder::build`  (lines 92–97)

```
fn build(self) -> Result<Policy, regex_lite::Error>
```

**Purpose**: Turns the collected rule pieces into a final Policy object. This marks the end of policy loading.

**Data flow**: It consumes the builder, takes out the accumulated program definitions, forbidden regex rules, and forbidden substrings, and passes them into Policy::new. The result is either a valid Policy or an error from policy construction.

**Call relations**: PolicyParser::parse calls this after the Starlark policy has finished running. It is the handoff point from temporary collection to the Policy used by the rest of the system.

*Call graph*: 1 external calls (new).


##### `PolicyBuilder::add_program_spec`  (lines 99–104)

```
fn add_program_spec(&self, program_spec: ProgramSpec)
```

**Purpose**: Adds one allowed-program rule to the policy being built. A program rule says which command name is recognized and what options and arguments are acceptable for it.

**Data flow**: It receives a ProgramSpec, logs that it is being added, reads the program name from it, and stores the rule under that name. The builder is changed by adding this new program specification.

**Call relations**: The define_program Starlark built-in creates a ProgramSpec from the policy script and then uses this builder method to store it. Later, PolicyBuilder::build includes these stored program rules in the final Policy.

*Call graph*: 1 external calls (info!).


##### `PolicyBuilder::add_forbidden_substrings`  (lines 106–109)

```
fn add_forbidden_substrings(&self, substrings: &[String])
```

**Purpose**: Adds text fragments that should be forbidden wherever the policy later checks for dangerous command content. This is a simple way to block known bad snippets.

**Data flow**: It receives a list of strings from the policy script. It appends those strings to the builder’s existing forbidden-substring list. Nothing is returned, but the builder now contains more blocked text patterns.

**Call relations**: The forbid_substrings Starlark built-in uses this when a policy author names substrings to block. PolicyBuilder::build later carries these strings into the final Policy.


##### `PolicyBuilder::add_forbidden_program_regex`  (lines 111–114)

```
fn add_forbidden_program_regex(&self, regex: Regex, reason: String)
```

**Purpose**: Adds one forbidden program-name pattern, along with a human-readable reason. A regular expression is a text pattern used to match many possible strings, not just one exact name.

**Data flow**: It receives an already-compiled regular expression and a reason string. It wraps them together as a ForbiddenProgramRegex and appends that rule to the builder. The builder is changed by gaining another forbidden pattern.

**Call relations**: The forbid_program_regex Starlark built-in compiles the pattern text and then calls this method to store it. When PolicyBuilder::build runs, these stored regex rules become part of the final Policy.


##### `policy_builtins`  (lines 118–222)

```
fn policy_builtins(builder: &mut GlobalsBuilder)
```

**Purpose**: Defines the small set of functions policy authors are allowed to call from Starlark. These functions are the policy language: define_program, forbid_substrings, forbid_program_regex, opt, and flag.

**Data flow**: It adds policy-specific commands to Starlark’s global environment. When the policy script calls define_program, the inputs from the script are converted into Rust data such as ProgramSpec, Opt, and ArgMatcher values, duplicate option names are rejected, and the current PolicyBuilder is updated. forbid_substrings adds blocked text snippets. forbid_program_regex compiles a pattern and stores it with its reason. opt and flag create option descriptions that define_program can use.

**Call relations**: PolicyParser::parse registers these built-ins before running the policy script. During script evaluation, these functions are the controlled doorway from Starlark into Rust: they collect policy facts into the PolicyBuilder, which PolicyParser::parse later turns into the final Policy.


### `execpolicy-legacy/src/arg_resolver.rs`

`domain_logic` · `policy check / argument validation`

This file is like the seating plan for command-line arguments. A policy may say, for example, “the first argument is a file, then there may be many labels, then the last argument is an output path.” The code here lines up the real arguments with those expected patterns.

The main challenge is variable-length arguments: one pattern may accept many values, like “zero or more files” or “at least one option.” The resolver first splits the patterns into three parts: fixed patterns before the variable part, the one variable pattern if there is one, and fixed patterns after it. Then it matches the beginning arguments to the prefix, reserves enough arguments for the suffix, and gives whatever remains in the middle to the variable pattern.

Along the way it checks for policy mistakes and user mistakes. It rejects policies with more than one variable-length pattern, reports when there are not enough arguments, catches overlap between prefix and suffix, and reports extra arguments that no pattern claimed. For each successful match it creates a MatchedArg, which records the original argument position, the expected argument type, and the value. This matters because later policy checks need to know not just the raw text, but what role each argument was meant to play.

#### Function details

##### `resolve_observed_args_with_patterns`  (lines 15–145)

```
fn resolve_observed_args_with_patterns(
    program: &str,
    args: Vec<PositionalArg>,
    arg_patterns: &Vec<ArgMatcher>,
) -> Result<Vec<MatchedArg>>
```

**Purpose**: This is the main resolver. It takes the arguments observed for a program and the patterns allowed by policy, then tries to pair each real argument with the correct pattern and produce validated MatchedArg records.

**Data flow**: It receives a program name, a list of positional arguments, and a list of argument matchers. First it asks partition_args to split the matchers into fixed prefix patterns, one possible variable-length middle pattern, and fixed suffix patterns. It then safely slices the observed arguments with get_range_checked, creates MatchedArg values for each matched argument, and returns the full list. If the arguments do not fit, it returns a specific error, such as not enough arguments, too many arguments, a missing required variable argument, or an internal range/cardinality problem.

**Call relations**: This function is called by check when the system is deciding whether an observed command matches an execution policy. It relies on partition_args to understand the shape of the pattern list before matching begins, and on get_range_checked whenever it needs a safe section of the argument list. For every successful pairing, it hands the raw value and expected type to MatchedArg::new so the rest of the policy checker can work with typed matched arguments instead of loose strings.

*Call graph*: calls 3 internal fn (get_range_checked, partition_args, new); called by 1 (check); 1 external calls (new).


##### `partition_args`  (lines 156–188)

```
fn partition_args(program: &str, arg_patterns: &Vec<ArgMatcher>) -> Result<ParitionedArgs>
```

**Purpose**: This helper sorts the policy’s argument patterns into the fixed part before a variable-length pattern, the variable-length pattern itself, and the fixed part after it. It also counts how many real arguments the fixed prefix and suffix require.

**Data flow**: It receives the program name and the list of argument matchers. It walks through the patterns in order. Exact-size patterns go into the prefix until a variable-length pattern is found; after that, exact-size patterns go into the suffix. The first variable-length pattern is saved as the middle pattern. If a second variable-length pattern appears, it returns an error because the resolver would not know how to divide the arguments between two open-ended patterns.

**Call relations**: resolve_observed_args_with_patterns calls this before doing any matching. The returned split tells the resolver how many arguments must be kept for the fixed beginning and ending, and which pattern, if any, should receive the flexible middle section.

*Call graph*: called by 1 (resolve_observed_args_with_patterns); 1 external calls (default).


##### `get_range_checked`  (lines 190–204)

```
fn get_range_checked(vec: &[T], range: std::ops::Range<usize>) -> Result<&[T]>
```

**Purpose**: This small safety helper returns a slice of a list only if the requested start and end positions make sense. It turns bad ranges into clear project errors instead of risking a crash.

**Data flow**: It receives a list and a requested range. If the start is after the end, it returns a RangeStartExceedsEnd error. If the end goes past the list length, it returns a RangeEndOutOfBounds error. Otherwise it returns the requested section of the list without changing the list.

**Call relations**: resolve_observed_args_with_patterns calls this whenever it needs the prefix, variable-length middle, suffix, or unexpected extra arguments. This keeps the main matching logic readable while centralizing the boundary checks in one place.

*Call graph*: called by 1 (resolve_observed_args_with_patterns); 1 external calls (len).


### `execpolicy-legacy/src/program.rs`

`domain_logic` · `command validation and policy self-checking`

This file is the heart of deciding whether a command is allowed for a particular program. A `ProgramSpec` is like a checklist for one executable: its name, where it may be found on the system path, which options are allowed, which options are required, what normal arguments should look like, and whether the whole program is forbidden for a stated reason.

The main work happens when an `ExecCall` arrives. An `ExecCall` is the observed command someone wants to run: a program plus its command-line arguments. `ProgramSpec::check` walks through those arguments from left to right. It separates plain arguments from options, records simple flags, and makes sure options that need a value actually get one. If it sees an unknown option, a missing value, or a not-yet-supported `--` marker, it returns an error instead of approving the command.

After the basic option parsing, it asks the argument resolver to match the remaining positional arguments against the allowed argument patterns. Then it confirms that every required option was present. If everything fits, it builds a `ValidExec`, which is the cleaned-up, trusted version of the command. If the spec says the program is forbidden, it returns a forbidden result with the reason instead of a normal match.

The file also supports self-checking rule files: “should match” examples must pass, and “should not match” examples must fail.

#### Function details

##### `ProgramSpec::new`  (lines 33–66)

```
fn new(
        program: String,
        system_path: Vec<String>,
        option_bundling: bool,
        combined_format: bool,
        allowed_options: HashMap<String, Opt>,
        arg_patterns: Ve
```

**Purpose**: Creates a complete rulebook for one program. It also precomputes which options are required, so later checks can quickly tell whether a command forgot any mandatory option.

**Data flow**: It receives the program name, allowed system paths, option behavior settings, the allowed options, argument patterns, an optional forbidden reason, and example argument lists. It scans the allowed options, collects the names marked as required, and stores everything inside a new `ProgramSpec`. The result is a ready-to-use policy object for that program.

**Call relations**: This is the setup step for the rest of the file. Once a `ProgramSpec` has been built, callers can use `ProgramSpec::check` to test real commands and can use the verification functions to test the examples stored inside the spec.


##### `ProgramSpec::check`  (lines 94–195)

```
fn check(&self, exec_call: &ExecCall) -> Result<MatchedExec>
```

**Purpose**: Decides whether one requested command line fits this program’s rules. It turns a raw command into either a trusted `ValidExec`, a forbidden result with a reason, or a clear error explaining what was wrong.

**Data flow**: It takes an `ExecCall`, which contains a program and its raw argument strings. It reads each argument in order, sorting them into flags, options with values, and plain positional arguments. If an option needs a value, it treats the next argument as that value and rejects the command if the next item is another option or if no value appears. It rejects unknown options and unsupported `--` usage. Then it sends the collected positional arguments to `resolve_observed_args_with_patterns`, which matches them against the allowed argument patterns. After that, it compares the seen options with the required options. If all checks pass, it builds a `ValidExec`; if this program spec is marked forbidden, it wraps that valid command in a forbidden result instead of approving it.

**Call relations**: This is the central checker used by the file. `ProgramSpec::verify_should_match_list` calls it for examples that ought to pass, and `ProgramSpec::verify_should_not_match_list` calls it for examples that ought to fail. Inside the check, it hands positional arguments to `resolve_observed_args_with_patterns` because argument matching is handled by that separate resolver, and it creates matched option records so the final `ValidExec` contains structured, validated command data rather than raw strings.

*Call graph*: calls 2 internal fn (resolve_observed_args_with_patterns, new); called by 2 (verify_should_match_list, verify_should_not_match_list); 3 external calls (new, new, new).


##### `ProgramSpec::verify_should_match_list`  (lines 197–216)

```
fn verify_should_match_list(&self) -> Vec<PositiveExampleFailedCheck>
```

**Purpose**: Tests the positive examples stored in the program spec. These are example commands that the policy author says should be accepted.

**Data flow**: It reads each argument list from `should_match` and turns it into an `ExecCall` for this program. It passes that command to `ProgramSpec::check`. If the check succeeds, nothing is recorded. If the check returns an error, it creates a `PositiveExampleFailedCheck` containing the program, the example arguments, and the error. The output is a list of all positive examples that unexpectedly failed.

**Call relations**: This function is a policy sanity check. It relies on `ProgramSpec::check` as the real source of truth, so it does not duplicate the validation rules. It is useful when loading or testing policy definitions: if a supposed good example fails, the rulebook or the example is probably wrong.

*Call graph*: calls 1 internal fn (check); 1 external calls (new).


##### `ProgramSpec::verify_should_not_match_list`  (lines 218–233)

```
fn verify_should_not_match_list(&self) -> Vec<NegativeExamplePassedCheck>
```

**Purpose**: Tests the negative examples stored in the program spec. These are example commands that the policy author says should be rejected.

**Data flow**: It reads each argument list from `should_not_match` and turns it into an `ExecCall` for this program. It passes that command to `ProgramSpec::check`. If the check fails, that is expected and nothing is recorded. If the check succeeds, it creates a `NegativeExamplePassedCheck` containing the program and arguments. The output is a list of bad examples that were unexpectedly accepted.

**Call relations**: This function is the mirror image of `ProgramSpec::verify_should_match_list`. It calls `ProgramSpec::check` to use the same validation path as real commands. It helps catch policies that are too loose, because any negative example that passes shows a command the current rules would allow even though the author expected it to be blocked.

*Call graph*: calls 1 internal fn (check); 1 external calls (new).


### `execpolicy-legacy/src/policy.rs`

`domain_logic` · `request handling and policy validation`

This file is the heart of the legacy execution-policy checker. Its job is to look at an attempted command, made of a program name and its arguments, and compare it with a stored set of rules. Without this file, the system would have rule data but no central place that turns those rules into a yes-or-no decision.

The `Policy` struct is like a security desk with three lists. First, it has allowed program specifications, grouped by program name. Second, it has regular expressions, which are text patterns, for program names that are always forbidden. Third, it can build one combined pattern for argument text that must never appear.

When a command is checked, the strict bans are tried first. If the program name matches a forbidden pattern, the command is rejected right away. Then every argument is scanned for forbidden pieces of text. Only if those checks pass does the policy look up the detailed rule list for that program and ask each matching `ProgramSpec` whether the command fits. The first successful match wins. If none match, the last useful error is returned, such as “no rule for this program.”

The file also includes two self-check methods. They walk through all program rules and test the policy author’s positive and negative examples, helping catch mistakes in the rulebook itself.

#### Function details

##### `Policy::new`  (lines 22–42)

```
fn new(
        programs: MultiMap<String, ProgramSpec>,
        forbidden_program_regexes: Vec<ForbiddenProgramRegex>,
        forbidden_substrings: Vec<String>,
    ) -> std::result::Result<Self, Re
```

**Purpose**: Builds a `Policy` from already-parsed rule data. It also turns the list of forbidden argument substrings into one reusable regular expression, so later checks can scan arguments quickly.

**Data flow**: It receives the allowed program rules, the forbidden program-name patterns, and a list of forbidden text snippets for arguments. If there are no forbidden snippets, it stores no argument pattern. If there are snippets, it escapes them so they are treated as literal text, joins them into one pattern, and tries to compile that pattern. The result is either a ready-to-use `Policy` or a regular-expression error if the pattern could not be built.

**Call relations**: This is the setup step for the policy object. It calls the regular expression constructor to prepare the forbidden-substring scanner, then stores all rule lists together so later calls to `Policy::check` and the example-checking methods can use the same prepared policy.

*Call graph*: 2 external calls (new, format!).


##### `Policy::check`  (lines 44–86)

```
fn check(&self, exec_call: &ExecCall) -> Result<MatchedExec>
```

**Purpose**: Decides what happens to one attempted execution. It returns a successful match when the command is allowed by a rule, a forbidden result when it hits a ban, or an error when no rule accepts it.

**Data flow**: It receives an `ExecCall`, which contains a program name and its argument list. First it compares the program name with every forbidden program pattern. If one matches, it returns a forbidden result explaining that the program itself is banned. Next it scans each argument for forbidden substrings; if one is found, it returns a forbidden result explaining which argument caused the problem. If those checks pass, it looks up all specifications stored for that program name and asks each one to check the command. The first successful specification result is returned. If all fail, it returns the last error seen, or a “no spec for program” error if there were no rules for that program.

**Call relations**: This is the main decision point other parts of the system would call when a command is about to run. It uses the stored forbidden-pattern lists directly, looks up candidate program rules through the multimap, and then hands the detailed argument matching work to each `ProgramSpec`. It clones pieces of the command only when it needs to include them in the returned explanation.

*Call graph*: 3 external calls (get_vec, clone, format!).


##### `Policy::check_each_good_list_individually`  (lines 88–94)

```
fn check_each_good_list_individually(&self) -> Vec<PositiveExampleFailedCheck>
```

**Purpose**: Checks the positive examples written inside every program rule. A positive example is a command that the policy author expected to match; this function reports any that fail.

**Data flow**: It starts with an empty list of violations. It walks through every stored program specification, asks that specification to verify its “should match” examples, and adds any failures to the list. The output is a collection of positive examples that did not pass their rule.

**Call relations**: This is a policy self-test helper rather than a command-decision function. It walks through all stored rules using the multimap’s flat iterator and delegates the actual example testing to each `ProgramSpec`, collecting the results into one report.

*Call graph*: 2 external calls (flat_iter, new).


##### `Policy::check_each_bad_list_individually`  (lines 96–102)

```
fn check_each_bad_list_individually(&self) -> Vec<NegativeExamplePassedCheck>
```

**Purpose**: Checks the negative examples written inside every program rule. A negative example is a command that the policy author expected not to match; this function reports any that accidentally pass.

**Data flow**: It starts with an empty list of violations. It visits every stored program specification, asks that specification to verify its “should not match” examples, and appends any mistakes it finds. The output is a collection of negative examples that were accepted even though they were meant to be rejected.

**Call relations**: This complements the positive-example self-test. It iterates over every program specification in the policy and hands off to each `ProgramSpec` for the detailed check, then returns a combined list that can be shown to the policy author or a test runner.

*Call graph*: 2 external calls (flat_iter, new).


### Legacy execution verification
This final legacy checker performs post-match validation of filesystem access and executable resolution before execution proceeds.

### `execpolicy-legacy/src/execv_checker.rs`

`domain_logic` · `command validation before execution`

This file provides `ExecvChecker`, a checker that sits between a requested command and actually running it. First, it asks a policy whether the command shape is allowed: for example, whether `cp` is expected to have one readable file argument and one writeable file argument. Then it checks the real paths in those arguments against folder lists supplied by the caller.

The key idea is simple: a command may be allowed in general, but its file arguments still need boundaries. A kitchen knife is allowed in a kitchen, but not everywhere. Here, readable files must be under approved readable folders, and writeable files must be under approved writeable folders.

The checker also turns relative paths into absolute paths using the current working directory. This matters because `../secret` might look small but point outside the safe area. If there is no current working directory for a relative path, the checker refuses to guess.

Finally, it chooses the actual program path to run. If the policy lists possible system paths, it picks the first one that exists and is executable. The tests build a fake `cp` command and verify that the checker accepts safe inputs and rejects paths outside the allowed folders.

#### Function details

##### `ExecvChecker::new`  (lines 34–36)

```
fn new(execv_policy: Policy) -> Self
```

**Purpose**: Creates a new command checker from an execution policy. Use this when the policy has already been parsed and you want an object that can apply it to requested commands.

**Data flow**: It receives a `Policy`, stores it inside a new `ExecvChecker`, and returns that checker. Nothing is checked yet; this only prepares the checker for later use.

**Call relations**: The test helper builds a policy from a small policy text, then calls this constructor so the tests can exercise the real checker behavior.

*Call graph*: called by 1 (setup).


##### `ExecvChecker::r#match`  (lines 38–40)

```
fn r#match(&self, exec_call: &ExecCall) -> Result<MatchedExec>
```

**Purpose**: Compares a requested command against the stored policy to see whether it matches an allowed command pattern. This is the first safety step before checking folders and file paths.

**Data flow**: It receives an `ExecCall`, which contains the requested program name and arguments. It passes that request to the policy, and returns the policy's answer: either a matched, structured command or an error/no-match result.

**Call relations**: Callers use this before `ExecvChecker::check`. In the tests, the requested `cp` command is matched first, and only the resulting validated command shape is passed on for folder permission checks.

*Call graph*: 1 external calls (check).


##### `ExecvChecker::check`  (lines 44–98)

```
fn check(
        &self,
        valid_exec: ValidExec,
        cwd: &Option<OsString>,
        readable_folders: &[PathBuf],
        writeable_folders: &[PathBuf],
    ) -> Result<String>
```

**Purpose**: Checks that the file arguments of an already matched command stay inside the folders the caller allowed for reading and writing. It also chooses the executable program path that should be used.

**Data flow**: It receives a `ValidExec`, an optional current working directory, readable folders, and writeable folders. For each argument or option marked as a readable or writeable file, it converts the path to an absolute path and confirms it starts inside one of the matching allowed folders. Arguments that are not file paths are ignored for folder checks. Then it looks through the policy's possible system paths and returns the first one that is an executable file, or falls back to the program name if none is found. If any path is outside its allowed folders, it returns a clear error instead.

**Call relations**: This is the main enforcement step after `ExecvChecker::r#match` has produced a `ValidExec`. It relies on `ensure_absolute_path` so relative paths cannot hide where they really point, uses the folder-checking macro to reject paths outside the allowed areas, and calls `is_executable_file` when selecting a concrete program path.

*Call graph*: calls 2 internal fn (ensure_absolute_path, is_executable_file); 1 external calls (check_file_in_folders!).


##### `ensure_absolute_path`  (lines 101–117)

```
fn ensure_absolute_path(path: &str, cwd: &Option<OsString>) -> Result<PathBuf>
```

**Purpose**: Turns a file path into an absolute, cleaned-up path so it can be safely compared with allowed folders. This prevents misleading relative paths such as `../something` from bypassing folder checks.

**Data flow**: It receives a path string and an optional current working directory. If the path is relative, it combines it with the current working directory; if there is no current working directory, it returns an error. If the path is already absolute, it cleans it directly. The result is a `PathBuf` that represents the path in absolute form, or an error explaining why that could not be done.

**Call relations**: `ExecvChecker::check` calls this for every readable or writeable file argument before comparing it with the approved folder lists. Its output becomes the path that the folder check trusts.

*Call graph*: called by 1 (check); 1 external calls (from).


##### `is_executable_file`  (lines 119–140)

```
fn is_executable_file(path: &str) -> bool
```

**Purpose**: Answers the practical question: does this path point to a file that can be run as a program? This helps the checker pick a real executable from the policy's possible system paths.

**Data flow**: It receives a path string, asks the operating system for information about that path, and returns `true` only if it is a file that appears executable. On Unix-like systems it checks the executable permission bits; on Windows it currently treats any file as executable. If the file does not exist or metadata cannot be read, it returns `false`.

**Call relations**: `ExecvChecker::check` calls this while walking through candidate system paths. The first candidate that passes this test becomes the program path returned to the caller.

*Call graph*: called by 1 (check); 2 external calls (new, metadata).


##### `tests::setup`  (lines 152–165)

```
fn setup(fake_cp: &Path) -> ExecvChecker
```

**Purpose**: Builds a small test policy that allows a fake `cp` command with one readable file and one writeable file. It keeps the tests focused on checker behavior instead of repeating policy setup.

**Data flow**: It receives the path to a fake `cp` executable, writes that path into a policy string, parses the policy, and returns an `ExecvChecker` built from it.

**Call relations**: The main test calls this after creating a temporary fake executable. This helper then uses `ExecvChecker::new` to produce the checker that the test will run through several safe and unsafe cases.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (format!).


##### `tests::test_check_valid_input_files`  (lines 168–294)

```
fn test_check_valid_input_files() -> Result<()>
```

**Purpose**: Tests the main safety behavior of the checker: safe file paths are accepted, missing folder permissions are rejected, executable lookup works, and parent folders cannot be used to escape the allowed area.

**Data flow**: It creates a temporary directory, places a fake executable there, builds source and destination paths, and creates a checker with the test policy. It matches a `cp` call, then runs `check` with different readable and writeable folder lists. The expected outputs are explicit: errors when folders are missing or too broad in the wrong direction, and success when both file paths are inside approved folders.

**Call relations**: This test drives the whole flow the way a real caller would: set up policy, match a command with `ExecvChecker::r#match`, then enforce folder boundaries with `ExecvChecker::check`. It also uses `tests::setup` to keep policy construction out of the main test story.

*Call graph*: 8 external calls (default, new, assert_eq!, setup, panic!, create, set_permissions, vec!).
