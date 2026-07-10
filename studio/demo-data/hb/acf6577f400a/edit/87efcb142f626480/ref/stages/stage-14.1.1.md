# Approval policy and request-decision engines  `stage-14.1.1`

This stage is the system’s gatekeeper. It sits in the main decision path whenever the agent wants to run a command, edit files with a patch, use the network, or relax sandbox limits. Its job is to answer a simple question: can this go through automatically, does it need the user’s approval, or must it be blocked?

The newer execpolicy files are the main engine. The parser reads rule files and turns them into an internal policy, while keeping source locations so error messages can point to the right line. The rule and policy files define what a rule looks like and how a real command or network request is checked against it, including host-name cleanup and layered policy merging. The public library file ties these pieces into one API.

In core, exec_policy.rs uses those policies with sandbox state, fallback heuristics, and approval settings to make final command and network decisions. sandboxing.rs provides shared approval memory and sandbox override rules. network_policy_decision.rs converts blocked network events into prompts and saved rule updates. safety.rs does the same kind of judgment for apply_patch.

The legacy execpolicy files are the older checker kept for compatibility. They parse older policy files, match programs and arguments, and do a final file-path safety check before execution.

## Files in this stage

### Execution policy model and parsing
These files define the modern execution-policy API, rule model, parser, and runtime evaluation used to decide command and network access.

### `execpolicy/src/lib.rs`

`orchestration` · `policy API use during config load and command evaluation`

This file defines the module structure and public surface of the `execpolicy` crate. Internally it splits responsibilities across amendment logic (`amend`), decision and evaluation types, parser and policy representation, executable-name handling, and rule definitions. Most modules are crate-private, while `rule` is public, signaling that rule types are intended for direct consumer use.

The bulk of the file is `pub use` re-exports that flatten those internals into a coherent API. Consumers get amendment helpers and `AmendError`; decision and evaluation outputs (`Decision`, `Evaluation`); parser entrypoints (`PolicyParser`); the main `Policy` type and `MatchOptions`; rich error reporting (`Error`, `Result`, `ErrorLocation`, `TextPosition`, `TextRange`); the `ExecPolicyCheckCommand`; and the rule vocabulary including `Rule`, `RuleRef`, `RuleMatch`, `PrefixRule`, `PrefixPattern`, `PatternToken`, and `NetworkRuleProtocol`.

This crate root therefore encodes the intended layering of the policy subsystem: parse policy text into structured rules, evaluate commands or network actions against those rules, optionally amend policies programmatically, and report precise source locations on failure. There is no executable logic here, but it is the authoritative import surface that external code relies on instead of reaching into internal modules directly.


### `execpolicy/src/rule.rs`

`domain_logic` · `policy load and request handling`

This file contains the low-level domain objects that `Policy` and the parser manipulate. `PatternToken` models one command-position matcher as either an exact string or a set of alternatives, and `PrefixPattern` combines a fixed first token with an `Arc<[PatternToken]>` tail so rules can be keyed efficiently by program name while still supporting alternative tokens later in the command. `PrefixRule` implements the `Rule` trait by delegating to `PrefixPattern::matches_prefix` and packaging successful matches as `RuleMatch::PrefixRuleMatch`, including optional justification text.

`RuleMatch` is the serialized runtime evidence returned by policy evaluation. It can represent either a concrete prefix-rule match or a synthetic heuristics fallback, and it supports post-processing through `with_resolved_program` so basename-based host executable matches can retain the original absolute path. The file also defines `NetworkRuleProtocol` parsing and string rendering, plus `normalize_network_rule_host`, which aggressively rejects malformed hosts: empty strings, schemes, paths, queries, fragments, wildcards, whitespace, invalid bracketed IPv6 literals, and unsupported suffixes. It strips ports where supported, trims trailing dots, and lowercases the host.

Finally, the example validators are semantic checks used during parsing. They build on `Policy::matches_for_command_with_options` with host executable resolution enabled, ensuring positive examples match at least one rule and negative examples match none. Error payloads include rendered shell commands via `shlex::try_join` and debug-formatted rules for diagnostics.

#### Function details

##### `PatternToken::matches`  (lines 22–27)

```
fn matches(&self, token: &str) -> bool
```

**Purpose**: Checks whether one command token satisfies this pattern token. It supports either exact equality or membership in an alternatives list.

**Data flow**: It takes `&self` and a candidate `&str`. For `Single`, it compares directly to the stored string; for `Alts`, it scans the alternatives for equality. It returns a boolean and does not mutate state.

**Call relations**: Used internally by `PrefixPattern::matches_prefix` while comparing a command against a stored prefix pattern.


##### `PatternToken::alternatives`  (lines 29–34)

```
fn alternatives(&self) -> &[String]
```

**Purpose**: Returns the token’s allowed strings as a slice regardless of whether it is stored as a single value or multiple alternatives. This gives callers a uniform view of head-token expansion choices.

**Data flow**: It borrows `self` and returns `&[String]`: a one-element slice via `from_ref` for `Single`, or the underlying alternatives slice for `Alts`.

**Call relations**: Used by the parser’s `prefix_rule` builtin when expanding only the first pattern token into multiple concrete `PrefixRule` instances.

*Call graph*: 1 external calls (from_ref).


##### `PrefixPattern::matches_prefix`  (lines 46–59)

```
fn matches_prefix(&self, cmd: &[String]) -> Option<Vec<String>>
```

**Purpose**: Determines whether a command begins with this prefix pattern and, if so, returns the matched prefix tokens. It enforces both minimum command length and per-position token matching.

**Data flow**: It takes a command slice, computes the required pattern length as `rest.len() + 1`, returns `None` if the command is too short or the first token differs from `first`, then zips tail pattern tokens with the corresponding command tokens and rejects on the first mismatch. On success it clones `cmd[..pattern_length]` into a new `Vec<String>` and returns `Some` of that prefix.

**Call relations**: Called by `PrefixRule::matches` to implement the actual prefix-matching semantics for runtime evaluation.

*Call graph*: called by 1 (matches).


##### `RuleMatch::decision`  (lines 85–90)

```
fn decision(&self) -> Decision
```

**Purpose**: Extracts the decision carried by any rule match variant. This lets aggregation code treat concrete and heuristics matches uniformly.

**Data flow**: It matches on `self` and returns the stored `Decision` from either `PrefixRuleMatch` or `HeuristicsRuleMatch`.

**Call relations**: Used by `Evaluation::from_matches` when computing the strictest decision across all matches.


##### `RuleMatch::with_resolved_program`  (lines 92–107)

```
fn with_resolved_program(self, resolved_program: &AbsolutePathBuf) -> Self
```

**Purpose**: Annotates a prefix-rule match with the original absolute executable path that was resolved to a basename. Non-prefix matches are left unchanged.

**Data flow**: It takes ownership of a `RuleMatch` and a borrowed `AbsolutePathBuf`. For `PrefixRuleMatch`, it reconstructs the variant with `resolved_program: Some(resolved_program.clone())` while preserving matched prefix, decision, and justification; for any other variant it returns the original value unchanged.

**Call relations**: Used by `Policy::match_host_executable_rules` after matching basename-keyed rules against a rewritten command.

*Call graph*: 1 external calls (clone).


##### `NetworkRuleProtocol::parse`  (lines 126–136)

```
fn parse(raw: &str) -> Result<Self>
```

**Purpose**: Parses the textual protocol name accepted by network policy declarations. It also accepts a couple of compatibility aliases for HTTPS.

**Data flow**: It takes a raw `&str`, matches known strings to enum variants (`http`, `https`, `https_connect`, `http-connect`, `socks5_tcp`, `socks5_udp`), and returns `Error::InvalidRule` for anything else.

**Call relations**: Used by the parser’s `network_rule` builtin before constructing a `NetworkRule`.

*Call graph*: 2 external calls (InvalidRule, format!).


##### `NetworkRuleProtocol::as_policy_string`  (lines 138–145)

```
fn as_policy_string(self) -> &'static str
```

**Purpose**: Returns the canonical policy-language string for a protocol enum value. This is the inverse display form used when serializing or appending rules.

**Data flow**: It takes the enum by value and returns a static string literal corresponding to the variant.

**Call relations**: Used by higher-level code that emits policy text, such as network-rule append helpers.

*Call graph*: called by 1 (blocking_append_network_rule).


##### `normalize_network_rule_host`  (lines 156–212)

```
fn normalize_network_rule_host(raw: &str) -> Result<String>
```

**Purpose**: Validates and canonicalizes a network rule host string into a lowercase host/IP literal without scheme, path, wildcard, or unsupported suffixes. It also strips supported port syntax and trailing dots.

**Data flow**: Input is raw host text. It trims whitespace, rejects empty strings and any value containing `://`, `/`, `?`, or `#`; handles bracketed IPv6 literals by validating the closing bracket and optional numeric port; handles single-colon host:port syntax for non-bracketed hosts; trims trailing dots and whitespace; lowercases the result; then rejects empty normalized values, wildcards, and embedded whitespace. On success it returns the normalized host string.

**Call relations**: Called by parser-side and programmatic network-rule creation so both paths share identical host validation semantics.

*Call graph*: called by 2 (blocking_append_network_rule, add_network_rule); 2 external calls (InvalidRule, format!).


##### `PrefixRule::program`  (lines 225–227)

```
fn program(&self) -> &str
```

**Purpose**: Returns the first token used to key this rule in policy storage. For prefix rules, that is always the fixed `pattern.first` string.

**Data flow**: It borrows `self` and returns `&str` referencing `self.pattern.first`.

**Call relations**: Used by `PolicyBuilder::add_rule` when inserting a generic `RuleRef` into the multimap.


##### `PrefixRule::matches`  (lines 229–238)

```
fn matches(&self, cmd: &[String]) -> Option<RuleMatch>
```

**Purpose**: Attempts to match this prefix rule against a command and, on success, produces a concrete `RuleMatch`. It preserves the rule’s decision and optional justification in the output.

**Data flow**: It takes a command slice, delegates to `self.pattern.matches_prefix(cmd)`, and maps a successful matched prefix into `RuleMatch::PrefixRuleMatch { matched_prefix, decision: self.decision, resolved_program: None, justification: self.justification.clone() }`. It returns `Option<RuleMatch>`.

**Call relations**: Called by policy evaluation when iterating candidate rules from `match_exact_rules` or `match_host_executable_rules`.

*Call graph*: calls 1 internal fn (matches_prefix).


##### `PrefixRule::as_any`  (lines 240–242)

```
fn as_any(&self) -> &dyn Any
```

**Purpose**: Exposes the rule as `dyn Any` for downcasting. This supports inspection code that needs to recover concrete rule types from `RuleRef` trait objects.

**Data flow**: It borrows `self` and returns `self` as `&dyn Any` without mutation.

**Call relations**: Used by `Policy::get_allowed_prefixes` and test helpers that downcast `RuleRef` values back to `PrefixRule`.


##### `validate_match_examples`  (lines 246–279)

```
fn validate_match_examples(
    policy: &Policy,
    rules: &[RuleRef],
    matches: &[Vec<String>],
) -> Result<()>
```

**Purpose**: Checks that every positive example command matches at least one rule in the supplied temporary policy. It reports all unmatched examples together in one error.

**Data flow**: Inputs are a `Policy`, the declaration’s `rules`, and a slice of positive example token vectors. It enables `MatchOptions { resolve_host_executables: true }`, iterates examples, calls `policy.matches_for_command_with_options(example, None, &options)`, and collects shell-rendered strings for any examples that produce no matches. It returns `Ok(())` if none are unmatched, otherwise `Error::ExampleDidNotMatch { rules: debug-formatted rules, examples: unmatched_examples, location: None }`.

**Call relations**: Called by `PolicyBuilder::validate_pending_examples_from` after negative examples have been checked, so parse-time validation can reject rules whose declared positive examples do not actually match.

*Call graph*: called by 1 (validate_pending_examples_from); 4 external calls (iter, new, matches_for_command_with_options, try_join).


##### `validate_not_match_examples`  (lines 282–306)

```
fn validate_not_match_examples(
    policy: &Policy,
    _rules: &[RuleRef],
    not_matches: &[Vec<String>],
) -> Result<()>
```

**Purpose**: Checks that every negative example command fails to match the supplied temporary policy. It stops at the first violating example and reports the matching rule.

**Data flow**: Inputs are a `Policy`, an unused rules slice, and negative example token vectors. It enables host executable resolution in `MatchOptions`, iterates examples, and for each one calls `policy.matches_for_command_with_options(example, None, &options)`. If the first match exists, it returns `Error::ExampleDidMatch { rule: format!("{rule:?}"), example: rendered shell string, location: None }`; otherwise it returns `Ok(())` after all examples pass.

**Call relations**: Called by `PolicyBuilder::validate_pending_examples_from` before positive-example validation so parse-time errors can identify examples that unexpectedly match.

*Call graph*: called by 1 (validate_pending_examples_from); 3 external calls (matches_for_command_with_options, format!, try_join).


### `execpolicy/src/parser.rs`

`orchestration` · `policy load`

This file is the policy-language front end for the exec policy subsystem. `PolicyParser` owns a mutable `PolicyBuilder` behind `RefCell` so Starlark builtin functions can mutate shared parse state through `Evaluator.extra` while a module is being evaluated. Parsing proceeds by configuring the Starlark `Dialect` with f-strings enabled, building a globals table containing the custom builtins from `policy_builtins`, evaluating the AST, and then validating only the newly added example assertions from this parse call. That incremental validation matters because a single parser instance can ingest multiple policy files, and each file’s examples should be checked against the cumulative host executable map and the rules introduced so far.

`PolicyBuilder` accumulates three concrete policy data sets: prefix rules keyed by program in a `MultiMap<String, RuleRef>`, `Vec<NetworkRule>`, and host executable allowlists in `HashMap<String, Arc<[AbsolutePathBuf]>>`. It also stores deferred `PendingExampleValidation` records because example checks need a temporary `Policy` assembled after all declarations in the current file have run. Helper parsers convert Starlark values into `PatternToken`s and example token vectors, reject empty patterns/examples, enforce absolute host paths, and ensure host executable names are bare basenames. Error helpers translate `FileSpan` into the crate’s `ErrorLocation` and attach that location to validation failures, so semantic example mismatches point back to the originating rule declaration rather than only reporting a generic validation error.

#### Function details

##### `PolicyParser::default`  (lines 43–45)

```
fn default() -> Self
```

**Purpose**: Provides the default parser instance by delegating to the normal constructor. It exists so callers and tests can create a fresh parser through standard Rust defaults.

**Data flow**: It takes no inputs, creates no custom state itself, and forwards construction to `PolicyParser::new`. It returns a parser whose internal `builder` contains empty rule, network, host-executable, and pending-validation collections.

**Call relations**: This is invoked implicitly or explicitly wherever a default parser is desired; in practice it is just a thin wrapper over the main constructor and adds no extra behavior.

*Call graph*: 1 external calls (new).


##### `PolicyParser::new`  (lines 49–53)

```
fn new() -> Self
```

**Purpose**: Constructs a fresh parser with an empty mutable `PolicyBuilder`. The parser is reusable across multiple policy files so later parses append to the same accumulated state.

**Data flow**: It allocates a new `PolicyBuilder`, wraps it in `RefCell`, and stores it in `PolicyParser`. The returned parser starts with no rules, no network rules, no host executable mappings, and no deferred example validations.

**Call relations**: This is the main entry used by policy-loading code and many tests before calling `parse` one or more times and finally `build`.

*Call graph*: calls 1 internal fn (new); called by 40 (load_exec_policy, heuristics_apply_when_other_commands_match_policy, mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision, mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled, policy_from_src, denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled, evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled, intercepted_exec_policy_rejects_disallowed_host_executable_mapping (+15 more)); 1 external calls (new).


##### `PolicyParser::parse`  (lines 57–79)

```
fn parse(&mut self, policy_identifier: &str, policy_file_contents: &str) -> Result<()>
```

**Purpose**: Parses and evaluates one Starlark policy source string, then validates any examples introduced by that source. It tags syntax/runtime errors with the supplied policy identifier and preserves source locations for later semantic validation failures.

**Data flow**: Inputs are `policy_identifier` and raw file contents. It reads the current length of `pending_example_validations`, configures `Dialect::Extended` with f-strings enabled, parses an `AstModule`, builds globals with `policy_builtins`, and evaluates the module inside `Module::with_temp_heap` using an `Evaluator` whose `extra` points at the shared builder. After evaluation, it asks the builder to validate deferred examples starting at the saved index, returning `Result<()>`; on success the builder has been mutated with newly declared rules, network rules, host executable mappings, and validated example metadata.

**Call relations**: Callers use this during policy ingestion, often repeatedly on the same parser. Internally it drives the whole parse/eval flow and relies on the Starlark builtins to populate builder state; after evaluation it triggers `PolicyBuilder::validate_pending_examples_from` for only the newly added validations.

*Call graph*: 3 external calls (parse, standard, with_temp_heap).


##### `PolicyParser::build`  (lines 81–83)

```
fn build(self) -> crate::policy::Policy
```

**Purpose**: Consumes the parser and produces the final immutable `Policy`. It is the handoff point from parse-time accumulation to runtime policy evaluation.

**Data flow**: It takes ownership of `self`, extracts the inner `PolicyBuilder` from the `RefCell`, and converts that builder into `crate::policy::Policy`. The returned policy contains all accumulated prefix rules, network rules, and host executable mappings.

**Call relations**: This is called after one or more successful `parse` calls. It delegates the actual assembly to `PolicyBuilder::build`.


##### `PolicyBuilder::new`  (lines 95–102)

```
fn new() -> Self
```

**Purpose**: Initializes the mutable accumulator used while evaluating policy files. It centralizes the empty-state setup for all parse-time collections.

**Data flow**: It creates an empty `MultiMap` for rules, empty `Vec`s for network rules and pending validations, and an empty `HashMap` for host executable mappings. It returns the fully initialized builder.

**Call relations**: Used by `PolicyParser::new` and nowhere else directly in normal flow; it defines the baseline state that Starlark builtins mutate.

*Call graph*: called by 2 (parse, new); 3 external calls (new, new, new).


##### `PolicyBuilder::add_rule`  (lines 104–107)

```
fn add_rule(&mut self, rule: RuleRef)
```

**Purpose**: Adds one parsed rule into the builder under its program lookup key. The key comes from the rule object itself via dynamic dispatch.

**Data flow**: It takes a `RuleRef`, reads `rule.program()`, clones that program name into a `String`, and inserts the rule into `rules_by_program`. It mutates builder state but returns no value.

**Call relations**: This is used by the `prefix_rule` builtin after constructing one or more `PrefixRule` instances, especially when the first pattern token expands into multiple head alternatives.

*Call graph*: 2 external calls (insert, program).


##### `PolicyBuilder::add_network_rule`  (lines 109–111)

```
fn add_network_rule(&mut self, rule: NetworkRule)
```

**Purpose**: Appends a parsed `NetworkRule` to the builder’s ordered network rule list. Ordering is preserved for later compilation semantics.

**Data flow**: It accepts a concrete `NetworkRule` and pushes it onto `network_rules`. It mutates only that vector and returns nothing.

**Call relations**: Called from the `network_rule` builtin once protocol, decision, host normalization, and justification validation have succeeded.


##### `PolicyBuilder::add_host_executable`  (lines 113–115)

```
fn add_host_executable(&mut self, name: String, paths: Vec<AbsolutePathBuf>)
```

**Purpose**: Registers the allowed absolute paths for a host executable name. A later definition replaces any earlier mapping for the same normalized name.

**Data flow**: It takes a normalized executable `name` and a `Vec<AbsolutePathBuf>`, converts the vector into `Arc<[AbsolutePathBuf]>`, and inserts it into `host_executables_by_name`. Existing entries for the same key are overwritten.

**Call relations**: Used by the `host_executable` builtin after validating the name, parsing each path, checking basename consistency, and deduplicating repeated paths.


##### `PolicyBuilder::add_pending_example_validation`  (lines 117–131)

```
fn add_pending_example_validation(
        &mut self,
        rules: Vec<RuleRef>,
        matches: Vec<Vec<String>>,
        not_matches: Vec<Vec<String>>,
        location: Option<ErrorLocation>,
```

**Purpose**: Queues example assertions for deferred validation after the current policy file finishes evaluating. Deferral allows examples to see declarations that appear later in the same file, such as `host_executable` mappings.

**Data flow**: It receives the concrete `rules` created for one declaration, parsed positive and negative example token lists, and an optional source `location`. It packages them into `PendingExampleValidation` and pushes that record onto `pending_example_validations`.

**Call relations**: Called by the `prefix_rule` builtin immediately after rule construction and before the rules are inserted, so semantic checks can run later against a temporary policy assembled from the relevant rules plus current host executable state.


##### `PolicyBuilder::validate_pending_examples_from`  (lines 133–152)

```
fn validate_pending_examples_from(&self, start: usize) -> Result<()>
```

**Purpose**: Runs semantic validation for deferred `match` and `not_match` examples added since a given index. Each validation is checked against a temporary policy containing only the declaration’s rules plus the current host executable map.

**Data flow**: Input is a starting index into `pending_example_validations`. For each queued validation from that slice, it rebuilds a temporary `MultiMap<String, RuleRef>` from the validation’s `rules`, constructs a temporary `Policy` with no network rules and a clone of `host_executables_by_name`, then runs `validate_not_match_examples` followed by `validate_match_examples`. Any returned `Error` is rewritten with `attach_validation_location`; on success it returns `Ok(())` without mutating builder state.

**Call relations**: Invoked by `PolicyParser::parse` after Starlark evaluation completes. It delegates the actual matching semantics to the rule-layer validators and exists to bridge parse-time declarations into runtime-style policy checks.

*Call graph*: calls 2 internal fn (validate_match_examples, validate_not_match_examples); 3 external calls (new, new, from_parts).


##### `PolicyBuilder::build`  (lines 154–160)

```
fn build(self) -> crate::policy::Policy
```

**Purpose**: Converts the accumulated parse state into the runtime `Policy` object. It is the final assembly step once parsing and validation are complete.

**Data flow**: It consumes the builder, moving out `rules_by_program`, `network_rules`, and `host_executables_by_name`, and passes them to `Policy::from_parts`. It returns the resulting `Policy`.

**Call relations**: Reached from `PolicyParser::build` after all desired files have been parsed.

*Call graph*: 1 external calls (from_parts).


##### `parse_pattern`  (lines 171–182)

```
fn parse_pattern(pattern: UnpackList<Value<'v>>) -> Result<Vec<PatternToken>>
```

**Purpose**: Parses a Starlark list representing a command pattern into internal `PatternToken`s. It also enforces the invariant that a rule pattern cannot be empty.

**Data flow**: It takes `UnpackList<Value>` from Starlark, maps each item through `parse_pattern_token`, and collects the results into `Vec<PatternToken>`. If the resulting vector is empty it returns `Error::InvalidPattern`; otherwise it returns the parsed token vector.

**Call relations**: Used by the `prefix_rule` builtin before rule construction so malformed patterns fail early with policy-parse errors.

*Call graph*: 1 external calls (InvalidPattern).


##### `parse_pattern_token`  (lines 184–217)

```
fn parse_pattern_token(value: Value<'v>) -> Result<PatternToken>
```

**Purpose**: Converts one Starlark pattern element into either a single-token matcher or an alternatives matcher. It accepts a string or a list of strings and rejects all other shapes.

**Data flow**: Input is a Starlark `Value`. If it unpacks as a string, it returns `PatternToken::Single`; if it is a list, it iterates the list content, requires every element to be a string, and returns `Single` for a one-element list or `Alts(Vec<String>)` for multiple alternatives. Empty alternative lists and non-string elements produce `Error::InvalidPattern` with type-specific messages.

**Call relations**: Called by `parse_pattern` for each element of a `prefix_rule` pattern. Its output directly determines whether the first token expands into multiple rules or later tokens remain grouped as alternatives.

*Call graph*: 6 external calls (from_value, unpack_str, InvalidPattern, Alts, Single, format!).


##### `parse_examples`  (lines 219–221)

```
fn parse_examples(examples: UnpackList<Value<'v>>) -> Result<Vec<Vec<String>>>
```

**Purpose**: Parses a Starlark list of example commands into tokenized command vectors. It is a bulk wrapper around single-example parsing.

**Data flow**: It takes `UnpackList<Value>`, applies `parse_example` to each item, and collects the resulting `Vec<String>` commands into `Vec<Vec<String>>`. Any invalid example aborts the whole parse with an `Error`.

**Call relations**: Used by the `prefix_rule` builtin for both `match` and `not_match` arguments.


##### `parse_literal_absolute_path`  (lines 223–232)

```
fn parse_literal_absolute_path(raw: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Validates that a raw string is an absolute filesystem path and converts it into `AbsolutePathBuf`. It produces user-facing `InvalidRule` errors with the original literal embedded.

**Data flow**: Input is a raw `&str`. It first checks `Path::new(raw).is_absolute()`, then attempts `AbsolutePathBuf::try_from(raw.to_string())`; success returns the typed absolute path, while either failure path returns `Error::InvalidRule` describing the problem.

**Call relations**: Called from the `host_executable` builtin for each declared path before basename checks and deduplication.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (new, InvalidRule, format!).


##### `validate_host_executable_name`  (lines 234–251)

```
fn validate_host_executable_name(name: &str) -> Result<()>
```

**Purpose**: Ensures a `host_executable` name is a non-empty bare executable basename rather than a path. This prevents ambiguous or platform-dependent lookup keys.

**Data flow**: It takes a `&str`, rejects the empty string, then uses `Path` component and filename checks to ensure the value consists of exactly one path component whose file name round-trips to the original string. It returns `Ok(())` on success or `Error::InvalidRule` on failure.

**Call relations**: Used by the `host_executable` builtin before any path parsing so invalid names fail immediately.

*Call graph*: 3 external calls (new, InvalidRule, format!).


##### `parse_network_rule_decision`  (lines 253–258)

```
fn parse_network_rule_decision(raw: &str) -> Result<Decision>
```

**Purpose**: Parses the decision string for `network_rule`, with a compatibility alias that maps `deny` to `Decision::Forbidden`. Other values are delegated to the standard decision parser.

**Data flow**: It accepts a raw decision string, matches the special case `"deny"`, otherwise calls `Decision::parse`. It returns the parsed `Decision` or an error from the delegated parser.

**Call relations**: Called only by the `network_rule` builtin because network policy syntax accepts `deny` in addition to the generic decision vocabulary.

*Call graph*: calls 1 internal fn (parse).


##### `error_location_from_file_span`  (lines 260–275)

```
fn error_location_from_file_span(span: FileSpan) -> ErrorLocation
```

**Purpose**: Translates a Starlark `FileSpan` into the crate’s source-location structure with 1-based line and column numbers. This normalizes parser/runtime spans into the error format used elsewhere in the policy subsystem.

**Data flow**: It reads the span filename and resolved begin/end positions, increments line and column values from Starlark’s zero-based coordinates, and constructs `ErrorLocation { path, range: TextRange { start, end } }`. It returns that location object without side effects.

**Call relations**: Used by the `prefix_rule` builtin when capturing the declaration site for deferred example validation errors.

*Call graph*: 2 external calls (filename, resolve_span).


##### `attach_validation_location`  (lines 277–282)

```
fn attach_validation_location(error: Error, location: Option<ErrorLocation>) -> Error
```

**Purpose**: Adds an optional source location to a validation error if one is available. It preserves the original error unchanged when no location was captured.

**Data flow**: It takes an `Error` and `Option<ErrorLocation>`. If the option is `Some`, it calls `with_location` on the error and returns the enriched error; otherwise it returns the original error.

**Call relations**: Used inside `PolicyBuilder::validate_pending_examples_from` to rewrite semantic example-validation failures with the originating rule’s source span.

*Call graph*: 1 external calls (with_location).


##### `parse_example`  (lines 284–295)

```
fn parse_example(value: Value<'v>) -> Result<Vec<String>>
```

**Purpose**: Parses one example command from either shell-like string syntax or an explicit token list. It rejects any other Starlark value type.

**Data flow**: Input is a Starlark `Value`. If it unpacks as a string, it delegates to `parse_string_example`; if it is a list, it delegates to `parse_list_example`; otherwise it returns `Error::InvalidExample` mentioning the actual Starlark type. The output is a non-empty `Vec<String>` token sequence.

**Call relations**: Called by `parse_examples` for each `match` or `not_match` entry.

*Call graph*: calls 2 internal fn (parse_list_example, parse_string_example); 4 external calls (from_value, unpack_str, InvalidExample, format!).


##### `parse_string_example`  (lines 297–309)

```
fn parse_string_example(raw: &str) -> Result<Vec<String>>
```

**Purpose**: Tokenizes a shell-style example string using `shlex`. It ensures the resulting command is syntactically valid and non-empty.

**Data flow**: It takes a raw string, runs `shlex::split`, converts split failure into `Error::InvalidExample`, and rejects an empty token vector with a dedicated message. On success it returns the parsed tokens.

**Call relations**: Reached from `parse_example` when an example is written as a single string literal such as `"git status"`.

*Call graph*: called by 1 (parse_example); 2 external calls (InvalidExample, split).


##### `parse_list_example`  (lines 311–335)

```
fn parse_list_example(list: &ListRef) -> Result<Vec<String>>
```

**Purpose**: Parses an example written as an explicit list of string tokens. It enforces that every element is a string and that the list is not empty.

**Data flow**: It iterates `ListRef::content()`, unpacks each value as a string, clones each token into a `Vec<String>`, and returns that vector. Non-string elements or an empty list produce `Error::InvalidExample`.

**Call relations**: Reached from `parse_example` when an example is written as a Starlark list like `["git", "status"]`.

*Call graph*: called by 1 (parse_example); 2 external calls (content, InvalidExample).


##### `policy_builder`  (lines 337–345)

```
fn policy_builder(eval: &Evaluator<'v, 'a, '_>) -> RefMut<'a, PolicyBuilder>
```

**Purpose**: Retrieves the mutable `PolicyBuilder` stored in the current Starlark evaluator. It is the bridge that lets builtin functions mutate parser state during module evaluation.

**Data flow**: It takes an `Evaluator`, reads `eval.extra`, downcasts it to `RefCell<PolicyBuilder>`, and returns a `RefMut<PolicyBuilder>`. Missing or wrongly typed `extra` triggers internal `expect` panics because this is treated as an evaluator setup invariant.

**Call relations**: Used by all stateful builtins inside `policy_builtins` after argument parsing succeeds.


##### `policy_builtins`  (lines 348–473)

```
fn policy_builtins(builder: &mut GlobalsBuilder)
```

**Purpose**: Registers the Starlark functions that policy files can call: `prefix_rule`, `network_rule`, and `host_executable`. These builtins parse user syntax, validate arguments, and mutate the shared `PolicyBuilder`.

**Data flow**: It receives a mutable `GlobalsBuilder` and defines three builtin functions. `prefix_rule` parses decision, justification, pattern tokens, and optional examples; captures source location; expands first-token alternatives into multiple `PrefixRule` values; queues deferred example validation; and inserts each rule. `network_rule` parses protocol and decision, normalizes the host, validates optional justification, and appends a `NetworkRule`. `host_executable` validates the executable name, parses each path as `AbsolutePathBuf`, checks basename consistency via executable lookup helpers, deduplicates repeated paths, and stores the normalized mapping. Each builtin returns `NoneType` on success and surfaces crate errors through `anyhow::Result`.

**Call relations**: This function is passed into `GlobalsBuilder::with` by `PolicyParser::parse`, making the declared builtins available during Starlark module evaluation. The nested builtins all rely on `policy_builder` to reach shared parse state.


### `execpolicy/src/policy.rs`

`domain_logic` · `request handling`

This file contains the core runtime representation of parsed execution policy. `Policy` stores prefix rules in a `MultiMap<String, RuleRef>` keyed by the command’s first token, network rules in insertion order, and optional host executable allowlists keyed by normalized executable name. The matching path is intentionally layered: `matches_for_command_with_options` first tries exact first-token lookup, then optionally rewrites an absolute executable path to its basename through `match_host_executable_rules`, and only if both produce no matches does it synthesize a `RuleMatch::HeuristicsRuleMatch` from the caller-provided fallback. Exact matches always win over host-executable resolution, and host resolution can be constrained by an explicit allowlist or allowed to fall back when no mapping exists.

The file also exposes mutation helpers used by tests and higher-level code: adding prefix rules constructs `PrefixRule` objects from raw token slices, adding network rules normalizes hosts and rejects blank justifications, and host executable paths can be set directly. `merge_overlay` preserves base rules while appending overlay rules and network rules, but host executable mappings are replaced per key by the overlay. `compiled_network_domains` reduces ordered network rules into final allow and deny domain lists, removing earlier contradictory entries and ignoring prompt-only rules. `Evaluation::from_matches` encodes the invariant that callers must only construct evaluations from non-empty match sets, deriving the final decision as the maximum severity across all matched rules.

#### Function details

##### `Policy::new`  (lines 35–37)

```
fn new(rules_by_program: MultiMap<String, RuleRef>) -> Self
```

**Purpose**: Constructs a policy from only prefix rules, defaulting network rules and host executable mappings to empty collections. It is the simplest constructor for callers that already have a populated rule multimap.

**Data flow**: It takes `rules_by_program`, supplies `Vec::new()` and `HashMap::new()` for the other two fields, and forwards all three pieces to `Policy::from_parts`. It returns the assembled `Policy`.

**Call relations**: Used by `Policy::empty` and any caller that wants a policy without network or host-executable metadata.

*Call graph*: 3 external calls (new, from_parts, new).


##### `Policy::from_parts`  (lines 39–49)

```
fn from_parts(
        rules_by_program: MultiMap<String, RuleRef>,
        network_rules: Vec<NetworkRule>,
        host_executables_by_name: HashMap<String, Arc<[AbsolutePathBuf]>>,
    ) -> Self
```

**Purpose**: Builds a `Policy` from its three concrete storage components. It is the canonical constructor used by parsing, merging, and temporary validation policies.

**Data flow**: It consumes a `MultiMap<String, RuleRef>`, `Vec<NetworkRule>`, and `HashMap<String, Arc<[AbsolutePathBuf]>>`, stores them directly in the struct, and returns the resulting `Policy`.

**Call relations**: Called by constructors in this file, by the parser when finalizing a policy, and by parse-time example validation when creating temporary policies.


##### `Policy::empty`  (lines 51–53)

```
fn empty() -> Self
```

**Purpose**: Creates a policy with no rules of any kind. It is mainly a convenience for tests and fallback scenarios.

**Data flow**: It constructs an empty `MultiMap` and passes it to `Policy::new`, which fills in the remaining empty collections. It returns the empty policy.

**Call relations**: Used in tests and any code path that needs a baseline policy before adding rules incrementally.

*Call graph*: 2 external calls (new, new).


##### `Policy::rules`  (lines 55–57)

```
fn rules(&self) -> &MultiMap<String, RuleRef>
```

**Purpose**: Exposes the internal prefix-rule multimap for inspection. It provides read-only access to the keyed rule storage.

**Data flow**: It takes `&self` and returns `&MultiMap<String, RuleRef>` referencing `rules_by_program` without copying or mutation.

**Call relations**: Primarily used by tests and introspection code to inspect parsed rules.


##### `Policy::network_rules`  (lines 59–61)

```
fn network_rules(&self) -> &[NetworkRule]
```

**Purpose**: Returns the ordered slice of configured network rules. This lets callers inspect the exact parsed network policy.

**Data flow**: It borrows `self.network_rules` and returns it as `&[NetworkRule]`.

**Call relations**: Used by tests and any code that needs direct access to network rule declarations.


##### `Policy::host_executables`  (lines 63–65)

```
fn host_executables(&self) -> &HashMap<String, Arc<[AbsolutePathBuf]>>
```

**Purpose**: Returns the host executable mapping table. The map associates normalized executable names with allowed absolute paths.

**Data flow**: It borrows `self.host_executables_by_name` and returns `&HashMap<String, Arc<[AbsolutePathBuf]>>`.

**Call relations**: Used by tests and policy consumers that need to inspect host executable resolution state.


##### `Policy::get_allowed_prefixes`  (lines 67–89)

```
fn get_allowed_prefixes(&self) -> Vec<Vec<String>>
```

**Purpose**: Extracts a deduplicated, human-readable list of all allow-decision prefix rules. It ignores non-prefix rule types and non-allow decisions.

**Data flow**: It iterates `rules_by_program.iter_all()`, downcasts each `RuleRef` to `PrefixRule`, filters to `Decision::Allow`, reconstructs each prefix as `Vec<String>` by combining `pattern.first` with rendered tail tokens, then sorts and deduplicates the resulting list. It returns the final `Vec<Vec<String>>`.

**Call relations**: This is an inspection/helper path rather than part of command evaluation. It depends on `render_pattern_token` semantics to stringify alternative tokens.

*Call graph*: 3 external calls (iter_all, new, with_capacity).


##### `Policy::add_prefix_rule`  (lines 91–111)

```
fn add_prefix_rule(&mut self, prefix: &[String], decision: Decision) -> Result<()>
```

**Purpose**: Adds a simple prefix rule directly from a token slice and decision. It is a programmatic counterpart to the parsed `prefix_rule` builtin and does not support examples or justification.

**Data flow**: Input is a token slice and `Decision`. It splits the slice into first token and rest, errors with `InvalidPattern` if empty, converts the rest into `PatternToken::Single` values, wraps them in a `PrefixRule` with `justification: None`, stores it as `RuleRef`, inserts it into `rules_by_program` under the first token, and returns `Result<()>`.

**Call relations**: Used by tests and any code constructing policies without going through the Starlark parser.

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

**Purpose**: Appends a network rule after validating and normalizing its host and optional justification. It is the programmatic equivalent of the parsed `network_rule` declaration.

**Data flow**: It takes raw host text, a `NetworkRuleProtocol`, a `Decision`, and optional justification. It normalizes the host with `normalize_network_rule_host`, rejects blank justifications after trimming, pushes a `NetworkRule` into `self.network_rules`, and returns `Result<()>`.

**Call relations**: Used by callers building policies in memory rather than through the parser. It shares host-normalization rules with parse-time network rule handling.

*Call graph*: calls 1 internal fn (normalize_network_rule_host); 1 external calls (InvalidRule).


##### `Policy::set_host_executable_paths`  (lines 137–139)

```
fn set_host_executable_paths(&mut self, name: String, paths: Vec<AbsolutePathBuf>)
```

**Purpose**: Sets or replaces the allowed absolute paths for one executable name. It is a direct mutator for host executable resolution state.

**Data flow**: It takes a normalized `name` and `Vec<AbsolutePathBuf>`, converts the vector into `Arc<[AbsolutePathBuf]>`, and inserts it into `host_executables_by_name`, overwriting any previous entry for that key.

**Call relations**: Used by programmatic policy construction paths; unlike parser-side validation, it assumes the caller already provides valid normalized data.


##### `Policy::merge_overlay`  (lines 141–165)

```
fn merge_overlay(&self, overlay: &Policy) -> Policy
```

**Purpose**: Combines a base policy with an overlay policy, preserving all base rules while layering overlay additions and replacements on top. Overlay host executable mappings override base mappings by key.

**Data flow**: It clones the base rule multimap, appends every overlay rule into it, clones and extends network rules, clones the host executable map and extends it with overlay entries, then returns a new `Policy` from those combined parts. The original policies are left unchanged.

**Call relations**: This is used when policy sources are layered. It delegates final assembly to `Policy::from_parts` after performing collection-level merge semantics.

*Call graph*: 2 external calls (clone, from_parts).


##### `Policy::compiled_network_domains`  (lines 167–186)

```
fn compiled_network_domains(&self) -> (Vec<String>, Vec<String>)
```

**Purpose**: Reduces ordered network rules into final allow and deny domain lists suitable for downstream enforcement. Later allow/deny rules replace earlier contradictory entries for the same host, while prompt rules do not contribute.

**Data flow**: It iterates `self.network_rules`, maintaining mutable `allowed` and `denied` vectors. For `Allow`, it removes the host from `denied` and upserts it into `allowed`; for `Forbidden`, it removes from `allowed` and upserts into `denied`; for `Prompt`, it does nothing. It returns `(allowed, denied)`.

**Call relations**: Used after policy load when network policy needs to be compiled into coarse domain lists. It relies on `upsert_domain` to preserve last-writer ordering semantics.

*Call graph*: calls 1 internal fn (upsert_domain); 1 external calls (new).


##### `Policy::check`  (lines 188–198)

```
fn check(&self, cmd: &[String], heuristics_fallback: &F) -> Evaluation
```

**Purpose**: Evaluates one command against the policy using default match options and a required heuristics fallback. It returns an aggregate `Evaluation` rather than raw matches.

**Data flow**: It takes a command slice and fallback closure, calls `matches_for_command_with_options` with `MatchOptions::default()`, then converts the resulting non-empty match list into `Evaluation` via `Evaluation::from_matches`. The returned evaluation contains the strictest decision and all contributing matches.

**Call relations**: This is the common single-command entrypoint. It delegates matching to `matches_for_command_with_options` and aggregation to `Evaluation::from_matches`.

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

**Purpose**: Evaluates one command with explicit matching options, such as host executable resolution. It is the configurable variant of `check`.

**Data flow**: Inputs are command tokens, fallback closure, and `MatchOptions`. It forwards them to `matches_for_command_with_options`, then wraps the resulting matches in `Evaluation::from_matches`.

**Call relations**: Used when callers need to enable or disable host executable resolution while still receiving an aggregate evaluation.

*Call graph*: calls 2 internal fn (from_matches, matches_for_command_with_options).


##### `Policy::check_multiple`  (lines 215–226)

```
fn check_multiple(
        &self,
        commands: Commands,
        heuristics_fallback: &F,
    ) -> Evaluation
```

**Purpose**: Evaluates multiple commands and aggregates all matches into one `Evaluation` using default options. The final decision is the strictest across every matched rule from every command.

**Data flow**: It takes any iterable of command-like items plus a fallback closure, supplies `MatchOptions::default()`, and delegates to `check_multiple_with_options`. It returns the combined evaluation.

**Call relations**: This is the convenience wrapper for batch evaluation and simply forwards to the configurable multi-command path.

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

**Purpose**: Evaluates an iterable of commands with explicit options and aggregates all resulting matches. It preserves duplicate matches across commands rather than deduplicating them.

**Data flow**: It consumes `commands`, iterates them, calls `matches_for_command_with_options` for each command reference, flattens all `Vec<RuleMatch>` results into one `Vec<RuleMatch>`, and passes that vector to `Evaluation::from_matches`. It returns the aggregate evaluation.

**Call relations**: Called by `check_multiple`; internally it repeatedly uses the same single-command matching logic so batch and single evaluation share semantics.

*Call graph*: calls 1 internal fn (from_matches); called by 1 (check_multiple); 1 external calls (into_iter).


##### `Policy::matches_for_command`  (lines 260–266)

```
fn matches_for_command(
        &self,
        cmd: &[String],
        heuristics_fallback: HeuristicsFallback<'_>,
    ) -> Vec<RuleMatch>
```

**Purpose**: Returns the raw rule matches for one command using default options. If no policy rule matches and a fallback is supplied, it returns a single heuristics match.

**Data flow**: It takes a command slice and optional fallback closure, supplies `MatchOptions::default()`, and returns the `Vec<RuleMatch>` from `matches_for_command_with_options` directly.

**Call relations**: This is the raw-match counterpart to `check`, used when callers want detailed matches without immediate aggregation.

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

**Purpose**: Implements the full command-matching algorithm with optional host executable resolution and optional heuristics fallback. It enforces the precedence order exact match > resolved-host match > heuristics.

**Data flow**: Inputs are command tokens, optional fallback closure, and `MatchOptions`. It first calls `match_exact_rules`; if that yields a non-empty vector, those matches are used. Otherwise, if `options.resolve_host_executables` is true, it calls `match_host_executable_rules` and uses those matches if non-empty. If both paths produce no matches and a fallback exists, it returns a one-element vector containing `RuleMatch::HeuristicsRuleMatch { command: cmd.to_vec(), decision: heuristics_fallback(cmd) }`; otherwise it returns the matched rules or an empty vector.

**Call relations**: This is the central runtime matcher used by `check`, `check_with_options`, `check_multiple_with_options`, `matches_for_command`, and parse-time example validation in `rule.rs`.

*Call graph*: calls 1 internal fn (match_exact_rules); called by 3 (check, check_with_options, matches_for_command); 1 external calls (vec!).


##### `Policy::match_exact_rules`  (lines 297–305)

```
fn match_exact_rules(&self, cmd: &[String]) -> Option<Vec<RuleMatch>>
```

**Purpose**: Looks up and evaluates rules keyed by the command’s literal first token. It does not attempt any path-to-basename rewriting.

**Data flow**: It takes a command slice, returns `None` if the command is empty, otherwise fetches `rules_by_program.get_vec(first)` and runs `rule.matches(cmd)` for each candidate, collecting successful `RuleMatch` values into a vector. It wraps that vector in `Some`, even if empty.

**Call relations**: Called first by `matches_for_command_with_options` because exact first-token matches have highest precedence.

*Call graph*: called by 1 (matches_for_command_with_options); 1 external calls (get_vec).


##### `Policy::match_host_executable_rules`  (lines 307–334)

```
fn match_host_executable_rules(&self, cmd: &[String]) -> Vec<RuleMatch>
```

**Purpose**: Attempts to match a command whose first token is an absolute executable path against basename-keyed rules. It optionally enforces that the path appears in a configured allowlist for that basename.

**Data flow**: It takes a command slice and returns an empty vector on any early failure: empty command, non-absolute first token, missing basename, or no rules for that basename. If a host executable mapping exists for the basename and the absolute path is not in that list, it also returns empty. Otherwise it builds a rewritten command whose first token is the basename and remaining tokens are copied from the original command, matches all basename-keyed rules against that rewritten command, then rewrites each resulting `RuleMatch` with `with_resolved_program(&program)` so the original absolute path is preserved in the output.

**Call relations**: Called by `matches_for_command_with_options` only when exact matching found nothing and `resolve_host_executables` is enabled.

*Call graph*: calls 2 internal fn (executable_path_lookup_key, try_from); 3 external calls (get_vec, new, once).


##### `upsert_domain`  (lines 337–340)

```
fn upsert_domain(entries: &mut Vec<String>, host: &str)
```

**Purpose**: Maintains a domain list with last-write-wins semantics for one host. It removes any existing occurrence before appending the new one.

**Data flow**: It takes a mutable `Vec<String>` and a host string, retains only entries not equal to the host, then pushes `host.to_string()`. It mutates the vector in place and returns nothing.

**Call relations**: Used exclusively by `Policy::compiled_network_domains` to keep allow and deny lists free of duplicates while preserving rule order.

*Call graph*: called by 1 (compiled_network_domains).


##### `render_pattern_token`  (lines 342–347)

```
fn render_pattern_token(token: &PatternToken) -> String
```

**Purpose**: Converts a `PatternToken` into a displayable string form. Alternative tokens are rendered in bracketed pipe-separated notation.

**Data flow**: It matches on `PatternToken`: `Single(value)` clones and returns the string, while `Alts(alternatives)` formats them as `[a|b|c]`. It has no side effects.

**Call relations**: Used by `Policy::get_allowed_prefixes` when reconstructing readable prefixes from stored rule patterns.

*Call graph*: 1 external calls (format!).


##### `Evaluation::is_match`  (lines 358–362)

```
fn is_match(&self) -> bool
```

**Purpose**: Reports whether an evaluation contains at least one real policy-rule match rather than only heuristics fallback. This distinguishes explicit policy coverage from default behavior.

**Data flow**: It reads `self.matched_rules` and returns `true` if any element is not `RuleMatch::HeuristicsRuleMatch`, otherwise `false`.

**Call relations**: Used by callers inspecting evaluation results after `check` or `check_multiple`.


##### `Evaluation::from_matches`  (lines 365–374)

```
fn from_matches(matched_rules: Vec<RuleMatch>) -> Self
```

**Purpose**: Builds an aggregate evaluation from a non-empty list of rule matches. The final decision is the maximum-severity decision among those matches.

**Data flow**: It takes ownership of `matched_rules`, maps each match through `RuleMatch::decision`, computes the maximum decision, panics if the vector is empty, and returns `Evaluation { decision, matched_rules }`.

**Call relations**: Called by `Policy::check`, `Policy::check_with_options`, and `Policy::check_multiple_with_options` after those methods ensure a non-empty match list via either policy matches or heuristics fallback.

*Call graph*: called by 3 (check, check_multiple_with_options, check_with_options).


### Core approval decision engines
These core modules apply approval, sandbox, patch, and network-decision logic on top of execution-policy results for user-facing enforcement.

### `core/src/tools/sandboxing.rs`

`domain_logic` · `cross-cutting during approval and sandbox orchestration`

This file is the common contract layer between tool-specific runtimes and the orchestrator. `ApprovalStore` is a simple serialized-key cache of `ReviewDecision`s, used by `with_cached_approval` to skip repeated prompts when all approval keys for a request were previously approved for the session. `ApprovalCtx` carries the session, turn, call id, optional Guardian review id, retry reason, and optional network approval context needed to start an approval flow. `PermissionRequestPayload` standardizes hook input as a tool name plus JSON payload; the provided `bash` constructor emits `{command, description?}` under the bash hook tool name.

`ExecApprovalRequirement` captures whether a tool call should be skipped, prompted, or forbidden, including optional proposed exec-policy amendments and a `bypass_sandbox` bit for trusted allow decisions. `default_exec_approval_requirement` derives that requirement from `AskForApproval` and the current filesystem sandbox kind. The file also encodes a subtle invariant around denied reads: `unsandboxed_execution_allowed` returns false when the filesystem policy contains deny-read restrictions, because bypassing the sandbox would silently drop those restrictions. That invariant drives both `sandbox_override_for_first_attempt` and `sandbox_permissions_preserving_denied_reads`, ensuring explicit escalation or policy-based sandbox bypass does not erase deny-read enforcement.

Finally, the traits `Approvable`, `Sandboxable`, and `ToolRuntime` define the hooks runtimes expose to orchestration, while `SandboxAttempt` packages the concrete sandbox transform context and provides `env_for`, which turns a `SandboxCommand` plus `ExecOptions` into an executable `ExecRequest` via `SandboxManager::transform`.

#### Function details

##### `ApprovalStore::get`  (lines 46–52)

```
fn get(&self, key: &K) -> Option<ReviewDecision>
```

**Purpose**: Looks up a cached approval decision by serializing an arbitrary approval key to JSON. This lets different runtimes share one generic approval cache without custom key storage logic.

**Data flow**: Takes a serializable key reference, attempts `serde_json::to_string(key)`, returns `None` on serialization failure, otherwise looks up the resulting string in `self.map`, clones the stored `ReviewDecision`, and returns it.

**Call relations**: Used indirectly by `with_cached_approval` when checking whether all approval keys for a request were already approved for the session.

*Call graph*: 1 external calls (to_string).


##### `ApprovalStore::put`  (lines 54–61)

```
fn put(&mut self, key: K, value: ReviewDecision)
```

**Purpose**: Stores a cached approval decision under a serialized approval key. Failed key serialization is ignored rather than surfacing an error.

**Data flow**: Takes an owned serializable key and a `ReviewDecision`, serializes the key with `serde_json::to_string(&key)`, and if successful inserts the string/value pair into `self.map`.

**Call relations**: Called by `with_cached_approval` when a request receives `ApprovedForSession`, so future equivalent requests can bypass prompting.

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

**Purpose**: Wraps an approval fetch operation with session-level caching semantics across one or more approval keys. It skips prompting when all keys are already approved for session, records telemetry for actual approval requests, and stores `ApprovedForSession` decisions per key.

**Data flow**: Consumes session services, a tool name string, a vector of serializable keys, and an async `fetch` closure. If `keys` is empty it immediately awaits `fetch`. Otherwise it locks `services.tool_approvals`, checks whether every key maps to `ReviewDecision::ApprovedForSession`, and returns that decision early if so. If not, it awaits `fetch`, increments the `codex.approval.requested` telemetry counter with tool and opaque decision labels, and if the decision is `ApprovedForSession`, locks the approval store again and writes that decision for each key. Returns the final `ReviewDecision`.

**Call relations**: Called by shell, unified-exec, and other runtimes’ `start_approval_async` implementations to share consistent approval caching behavior.

*Call graph*: called by 3 (start_approval_async, start_approval_async, start_approval_async); 1 external calls (matches!).


##### `PermissionRequestPayload::bash`  (lines 141–155)

```
fn bash(command: String, description: Option<String>) -> Self
```

**Purpose**: Constructs the standard hook payload for bash-like command approval checks. It always includes the command string and includes a description only when one is provided.

**Data flow**: Takes a command `String` and optional description `String`. It builds a `serde_json::Map` with `command`, conditionally inserts `description`, wraps it as `serde_json::Value::Object`, and returns `PermissionRequestPayload { tool_name: HookToolName::bash(), tool_input }`.

**Call relations**: Used by shell and unified-exec runtimes for approval-time hooks, and by the Unix execve prompt path when running permission-request hooks before prompting.

*Call graph*: calls 1 internal fn (bash); called by 4 (handle_inline_policy_request, permission_request_payload, prompt, permission_request_payload); 3 external calls (new, Object, String).


##### `ExecApprovalRequirement::proposed_execpolicy_amendment`  (lines 182–194)

```
fn proposed_execpolicy_amendment(&self) -> Option<&ExecPolicyAmendment>
```

**Purpose**: Extracts the optional proposed exec-policy amendment from either `NeedsApproval` or `Skip` variants. This lets approval UIs surface or apply future-approval shortcuts without caring which variant carried the amendment.

**Data flow**: Matches on `self`; returns `Some(&ExecPolicyAmendment)` when the variant is `NeedsApproval` or `Skip` with a populated amendment, otherwise returns `None`.

**Call relations**: Shell and unified-exec approval flows call this when passing approval metadata into `session.request_command_approval`.


##### `default_exec_approval_requirement`  (lines 202–238)

```
fn default_exec_approval_requirement(
    policy: AskForApproval,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> ExecApprovalRequirement
```

**Purpose**: Derives the default exec approval requirement from the current `AskForApproval` policy and filesystem sandbox kind. It also converts granular policies that forbid sandbox approval into an immediate `Forbidden` result.

**Data flow**: Consumes an `AskForApproval` and a `FileSystemSandboxPolicy`. It computes `needs_approval` based on policy and whether the filesystem sandbox kind is `Restricted`. If approval is needed and granular policy disables sandbox approval, it returns `ExecApprovalRequirement::Forbidden` with a fixed reason. If approval is needed otherwise, it returns `NeedsApproval { reason: None, proposed_execpolicy_amendment: None }`. If approval is not needed, it returns `Skip { bypass_sandbox: false, proposed_execpolicy_amendment: None }`.

**Call relations**: Used by higher-level orchestration when a runtime does not provide a custom exec approval requirement.

*Call graph*: 1 external calls (matches!).


##### `sandbox_override_for_first_attempt`  (lines 246–275)

```
fn sandbox_override_for_first_attempt(
    sandbox_permissions: SandboxPermissions,
    exec_approval_requirement: &ExecApprovalRequirement,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
)
```

**Purpose**: Determines whether the first execution attempt should bypass the sandbox entirely. It respects explicit escalation and trusted exec-policy bypasses, but refuses to bypass when deny-read restrictions would be lost.

**Data flow**: Consumes requested `SandboxPermissions`, an `ExecApprovalRequirement`, and the active `FileSystemSandboxPolicy`. It first returns `NoOverride` if `unsandboxed_execution_allowed` is false. Otherwise, if the approval requirement is `Skip { bypass_sandbox: true, .. }`, it returns `BypassSandboxFirstAttempt`. Failing that, it returns `BypassSandboxFirstAttempt` when `sandbox_permissions.requires_escalated_permissions()` is true, else `NoOverride`.

**Call relations**: Called by the main tool orchestration run path when selecting the first sandbox attempt.

*Call graph*: calls 2 internal fn (unsandboxed_execution_allowed, requires_escalated_permissions); called by 1 (run); 1 external calls (matches!).


##### `unsandboxed_execution_allowed`  (lines 283–287)

```
fn unsandboxed_execution_allowed(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> bool
```

**Purpose**: Reports whether the active filesystem policy can be represented safely by running without a filesystem sandbox. Denied-read restrictions make the answer false because they only exist inside the sandbox.

**Data flow**: Reads `file_system_sandbox_policy.has_denied_read_restrictions()` and returns its negation.

**Call relations**: This helper underpins first-attempt sandbox override logic, denied-read-preserving permission normalization, and Unix zsh-fork escalation decisions.

*Call graph*: calls 1 internal fn (has_denied_read_restrictions); called by 5 (run, determine_action, shell_request_escalation_execution, sandbox_override_for_first_attempt, sandbox_permissions_preserving_denied_reads).


##### `sandbox_permissions_preserving_denied_reads`  (lines 289–303)

```
fn sandbox_permissions_preserving_denied_reads(
    sandbox_permissions: SandboxPermissions,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> SandboxPermissions
```

**Purpose**: Normalizes sandbox permissions so explicit escalation does not silently discard deny-read filesystem restrictions. It only rewrites permission modes that would otherwise bypass the sandbox.

**Data flow**: Consumes `SandboxPermissions` and a `FileSystemSandboxPolicy`. If the permission mode requires escalated permissions and `unsandboxed_execution_allowed` is false, it returns `SandboxPermissions::UseDefault`; otherwise it returns the original permission mode.

**Call relations**: Used by shell and unified-exec runtimes, plus the Unix zsh-fork backend, before network approval and execution preparation.

*Call graph*: calls 2 internal fn (unsandboxed_execution_allowed, requires_escalated_permissions); called by 5 (network_approval_spec, run, try_run_zsh_fork, network_approval_spec, run).


##### `managed_network_for_sandbox_permissions`  (lines 305–314)

```
fn managed_network_for_sandbox_permissions(
    network: Option<&NetworkProxy>,
    sandbox_permissions: SandboxPermissions,
) -> Option<&NetworkProxy>
```

**Purpose**: Determines whether managed-network proxying should remain active for a given sandbox permission mode. Explicitly escalated execution disables managed networking.

**Data flow**: Takes an optional `&NetworkProxy` and `SandboxPermissions`. Returns `None` when `sandbox_permissions.requires_escalated_permissions()` is true; otherwise returns the original network proxy reference.

**Call relations**: Called by shell, unified-exec, and zsh-fork execution paths when computing network approval and execution environment.

*Call graph*: calls 1 internal fn (requires_escalated_permissions); called by 6 (explicit_escalation_prepares_exec_without_managed_network, network_approval_spec, run, try_run_zsh_fork, network_approval_spec, run).


##### `Approvable::sandbox_permissions`  (lines 330–332)

```
fn sandbox_permissions(&self, _req: &Req) -> SandboxPermissions
```

**Purpose**: Provides the default per-request sandbox permission mode for runtimes that do not override it. The default is to use the ambient sandbox policy unchanged.

**Data flow**: Ignores the request and returns `SandboxPermissions::UseDefault`.

**Call relations**: Concrete runtimes like shell and unified exec override this when they need request-specific sandbox behavior.


##### `Approvable::should_bypass_approval`  (lines 334–340)

```
fn should_bypass_approval(&self, policy: AskForApproval, already_approved: bool) -> bool
```

**Purpose**: Implements the default rule for skipping approval prompts: skip if the request is already approved, or if policy is `AskForApproval::Never`. This keeps repeated approvals and never-prompt policies centralized.

**Data flow**: Consumes `AskForApproval` and an `already_approved` boolean. Returns true immediately when `already_approved` is true; otherwise returns whether the policy matches `Never`.

**Call relations**: Used by higher-level approval orchestration for runtimes implementing `Approvable`.

*Call graph*: 1 external calls (matches!).


##### `Approvable::exec_approval_requirement`  (lines 344–346)

```
fn exec_approval_requirement(&self, _req: &Req) -> Option<ExecApprovalRequirement>
```

**Purpose**: Default hook for runtimes that do not provide a custom exec approval requirement. Returning `None` tells orchestration to derive the requirement from policy.

**Data flow**: Ignores the request and returns `None`.

**Call relations**: Shell and unified-exec override this to forward request-specific approval requirements.


##### `Approvable::permission_request_payload`  (lines 350–352)

```
fn permission_request_payload(&self, _req: &Req) -> Option<PermissionRequestPayload>
```

**Purpose**: Default hook for runtimes that do not participate in approval-time permission-request hooks. Returning `None` means no hook payload is available.

**Data flow**: Ignores the request and returns `None`.

**Call relations**: Shell and unified-exec override this to provide bash-style hook payloads.


##### `Approvable::wants_no_sandbox_approval`  (lines 355–363)

```
fn wants_no_sandbox_approval(&self, policy: AskForApproval) -> bool
```

**Purpose**: Determines whether a runtime should request approval for no-sandbox execution under the current approval policy. It encodes the policy-specific meaning of sandbox escalation prompts.

**Data flow**: Matches on `AskForApproval`: returns true for `OnFailure` and `UnlessTrusted`, false for `Never` and `OnRequest`, and for `Granular` returns the `sandbox_approval` flag.

**Call relations**: Used by orchestration when deciding whether to ask for approval before retrying outside the sandbox.


##### `Sandboxable::escalate_on_failure`  (lines 374–376)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: Provides the default runtime behavior of allowing escalation after sandbox failure. Runtimes can override this to disable fallback escalation.

**Data flow**: Returns `true` with no inputs beyond `self`.

**Call relations**: Queried by orchestration for any runtime implementing `Sandboxable`.


##### `ToolRuntime::network_approval_spec`  (lines 393–395)

```
fn network_approval_spec(&self, _req: &Req, _ctx: &ToolCtx) -> Option<NetworkApprovalSpec>
```

**Purpose**: Default implementation for runtimes that do not require managed-network approval metadata. It indicates no network approval is needed.

**Data flow**: Ignores request and context and returns `None`.

**Call relations**: Shell and unified-exec override this to provide concrete network approval triggers.


##### `ToolRuntime::sandbox_cwd`  (lines 397–399)

```
fn sandbox_cwd(&self, _req: &'a Req) -> Option<&'a AbsolutePathBuf>
```

**Purpose**: Default implementation for runtimes that do not need a distinct sandbox cwd. It leaves sandbox cwd selection to the orchestrator’s defaults.

**Data flow**: Ignores the request and returns `None`.

**Call relations**: Unified exec overrides this to supply its trusted sandbox cwd.


##### `SandboxAttempt::env_for`  (lines 424–452)

```
fn env_for(
        &self,
        command: SandboxCommand,
        options: ExecOptions,
        network: Option<&NetworkProxy>,
    ) -> Result<crate::sandboxing::ExecRequest, CodexErr>
```

**Purpose**: Transforms a high-level `SandboxCommand` plus execution options into a concrete `ExecRequest` for the current sandbox attempt. It is the shared bridge from runtime-level command preparation into sandbox-manager execution requests.

**Data flow**: Consumes a `SandboxCommand`, `ExecOptions`, and optional network proxy reference. It calls `self.manager.transform` with `SandboxTransformRequest` built from the attempt’s permission profile, sandbox type, managed-network enforcement flag, sandbox cwd, optional Linux sandbox executable, landlock flag, and Windows sandbox settings. It maps transform errors into `CodexErr`, then converts the sandbox manager’s request into `crate::sandboxing::ExecRequest::from_sandbox_exec_request`, cloning workspace roots into the request. Returns the resulting `ExecRequest`.

**Call relations**: Called by shell runtime, unified-exec runtime, and Unix zsh-fork preparation/execution paths whenever they need a concrete executable request for the current attempt.

*Call graph*: calls 2 internal fn (from_sandbox_exec_request, transform); called by 3 (run, try_run_zsh_fork, run); 1 external calls (to_vec).


### `core/src/exec_policy.rs`

`domain_logic` · `command approval and policy load/update`

This file is the heart of command approval logic. It defines `ExecPolicyManager`, which stores the current `codex_execpolicy::Policy` in an `ArcSwap<Policy>` for lock-free reads and uses a single-permit `Semaphore` to serialize on-disk rule amendments. Policy loading walks trusted config layers in precedence order, collects `*.rules` files from each layer’s `rules/` directory, parses them with `PolicyParser`, and overlays any requirements policy from configuration. Parse failures are intentionally downgraded to warnings by `load_exec_policy_with_warning`, yielding an empty policy so the system can continue running.

For command evaluation, `create_exec_approval_requirement_for_command` first lowers wrapper commands such as `bash -lc ...` and, on Windows, PowerShell `-Command` invocations into inner plain commands via `commands_for_exec_policy`. It then evaluates all segments against explicit policy rules, using `render_decision_for_unmatched_command` as the fallback for unmatched commands. That fallback blends command safelists/danger heuristics, `AskForApproval`, filesystem sandbox shape, Windows sandbox backend availability, and requested sandbox escalation into a concrete `Decision`.

The file also derives human-facing reasons for prompt/forbidden outcomes, computes whether sandbox bypass is justified only when every parsed segment is explicitly allowed by policy, and proposes `ExecPolicyAmendment`s when heuristics—not existing rules—caused a prompt or allow. Suggested amendments are carefully suppressed for heredoc fallback parsing, banned broad prefixes like `python -c` or shell wrappers, and cases where an added prefix rule would not approve every parsed command segment. Finally, append methods update both the default rules file on disk and the in-memory policy atomically enough to keep future checks consistent.

#### Function details

##### `child_uses_parent_exec_policy`  (lines 137–159)

```
fn child_uses_parent_exec_policy(parent_config: &Config, child_config: &Config) -> bool
```

**Purpose**: Determines whether a child configuration can safely reuse the parent’s already-loaded exec policy instead of reloading rules. It compares only exec-policy-relevant configuration state, ignoring unrelated layers.

**Data flow**: Reads `parent_config` and `child_config`, extracts each config’s enabled layer config folders in lowest-precedence-first order, compares those folder lists, compares the `ignore_user_and_project_exec_policy_rules` flag, and compares `requirements().exec_policy`. Returns `true` only if all three match.

**Call relations**: This helper is used when deciding inheritance of exec-policy state for spawned/internal child contexts. It does not load policy itself; it isolates the exact config dimensions that affect rule resolution.

*Call graph*: called by 1 (inherited_exec_policy_for_source).


##### `is_policy_match`  (lines 161–166)

```
fn is_policy_match(rule_match: &RuleMatch) -> bool
```

**Purpose**: Classifies a `RuleMatch` as coming from an explicit policy rule rather than heuristic fallback. Prefix-rule matches count as policy; heuristic matches do not.

**Data flow**: Reads a `RuleMatch` enum and pattern-matches it, returning `true` for `PrefixRuleMatch` and `false` for `HeuristicsRuleMatch`.

**Call relations**: This predicate is used throughout amendment derivation, prompt handling, and sandbox-bypass checks to distinguish user-authored policy from heuristic decisions.


##### `prompt_is_rejected_by_policy`  (lines 174–197)

```
fn prompt_is_rejected_by_policy(
    approval_policy: AskForApproval,
    prompt_is_rule: bool,
) -> Option<&'static str>
```

**Purpose**: Translates `AskForApproval` settings into an optional hard rejection reason when a prompt would otherwise be shown. It distinguishes rule-driven prompts from sandbox/escalation prompts so granular settings can reject them independently.

**Data flow**: Reads `approval_policy` and `prompt_is_rule`; matches on `AskForApproval`; returns `Some(&'static str)` with one of the predefined rejection reasons when prompting is disallowed, otherwise `None`.

**Call relations**: It is called during approval-requirement construction after policy evaluation has already decided `Prompt`. The caller uses its result to convert a would-be approval request into `ExecApprovalRequirement::Forbidden`.

*Call graph*: called by 1 (create_exec_approval_requirement_for_command).


##### `ExecPolicyManager::new`  (lines 250–255)

```
fn new(policy: Arc<Policy>) -> Self
```

**Purpose**: Constructs a manager around an already-built policy with serialized update capability. It is the basic in-memory policy holder used by tests and production loaders.

**Data flow**: Consumes an `Arc<Policy>`, stores it in `ArcSwap`, creates a `Semaphore` with one permit, and returns a new `ExecPolicyManager`.

**Call relations**: Called by the async loader, the `Default` implementation, and tests that want to inject a handcrafted policy. It does not parse or evaluate rules itself; it prepares shared state for later reads and updates.

*Call graph*: called by 4 (exec_approval_requirement_for_command, mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision, mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled, verify_approval_requirement_for_unsafe_powershell_command); 2 external calls (from, new).


##### `ExecPolicyManager::load`  (lines 258–264)

```
async fn load(config_stack: &ConfigLayerStack) -> Result<Self, ExecPolicyError>
```

**Purpose**: Loads exec-policy rules from the configuration stack and returns a ready-to-use manager. Parse errors are logged as warnings and replaced with an empty policy rather than aborting startup.

**Data flow**: Reads `config_stack`, awaits `load_exec_policy_with_warning`, logs a warning if the returned warning is `Some`, wraps the resulting `Policy` in `Arc`, and returns `ExecPolicyManager::new(...)`.

**Call relations**: This is the production entry point for policy initialization during startup/config refresh. It delegates file discovery and parsing to `load_exec_policy_with_warning` and only handles warning/reporting plus manager construction.

*Call graph*: calls 1 internal fn (load_exec_policy_with_warning); called by 3 (returns_empty_policy_when_no_policy_files_exist, spawn_internal, guardian_subagent_does_not_inherit_parent_exec_policy_rules); 3 external calls (new, new, warn!).


##### `ExecPolicyManager::current`  (lines 266–268)

```
fn current(&self) -> Arc<Policy>
```

**Purpose**: Returns the current policy snapshot for lock-free readers. It exposes the `Arc<Policy>` currently stored in the manager.

**Data flow**: Reads the internal `ArcSwap<Policy>` and returns `load_full()`.

**Call relations**: Used by evaluation and update methods whenever they need a stable policy snapshot. Because it returns an `Arc`, callers can evaluate without holding locks while updates replace the stored policy atomically.

*Call graph*: called by 3 (append_amendment_and_update, append_network_rule_and_update, create_exec_approval_requirement_for_command); 1 external calls (load_full).


##### `ExecPolicyManager::create_exec_approval_requirement_for_command`  (lines 270–375)

```
async fn create_exec_approval_requirement_for_command(
        &self,
        req: ExecApprovalRequest<'_>,
    ) -> ExecApprovalRequirement
```

**Purpose**: Evaluates a command against explicit exec-policy rules plus heuristic fallback and converts the result into an `ExecApprovalRequirement`. It also computes prompt/forbidden reasons, sandbox-bypass eligibility, and proposed policy amendments.

**Data flow**: Consumes an `ExecApprovalRequest`, reads the current policy, lowers the command into one or more parsed command segments via `commands_for_exec_policy`, builds an unmatched-command fallback closure using `render_decision_for_unmatched_command`, and evaluates all segments with `check_multiple_with_options`. It may derive a requested amendment from `prefix_rule`, or heuristic amendments for prompt/allow outcomes. It returns `Forbidden { reason }`, `NeedsApproval { reason, proposed_execpolicy_amendment }`, or `Skip { bypass_sandbox, proposed_execpolicy_amendment }` based on `evaluation.decision` and approval-policy rejection checks.

**Call relations**: This is the central call path used whenever core needs to decide whether a command can run, needs approval, or must be blocked. It delegates parsing, fallback heuristics, reason rendering, prompt rejection, and amendment derivation to several helpers so each concern stays isolated.

*Call graph*: calls 7 internal fn (current, commands_for_exec_policy, derive_forbidden_reason, derive_prompt_reason, derive_requested_execpolicy_amendment_from_prefix_rule, prompt_is_rejected_by_policy, try_derive_execpolicy_amendment_for_allow_rules).


##### `ExecPolicyManager::append_amendment_and_update`  (lines 377–425)

```
async fn append_amendment_and_update(
        &self,
        codex_home: &Path,
        amendment: &ExecPolicyAmendment,
    ) -> Result<(), ExecPolicyUpdateError>
```

**Purpose**: Appends an allow-prefix amendment to the default rules file and updates the in-memory policy to match. It serializes concurrent updates and avoids duplicating an already-effective allow rule in memory.

**Data flow**: Reads `codex_home` and `amendment`, acquires the single-permit `update_lock`, computes `default_policy_path`, runs `blocking_append_allow_prefix_rule` in `spawn_blocking`, then reloads the current policy snapshot and checks whether the amendment command is already explicitly allowed. If not already allowed, it clones the policy, adds the prefix allow rule in memory, stores the new `Arc<Policy>`, and returns `Ok(())`; otherwise it returns early after the file update.

**Call relations**: This method is called after a user accepts a proposed exec-policy amendment. It coordinates disk persistence and in-memory state replacement so future evaluations immediately see the new rule.

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

**Purpose**: Appends a network rule to the default rules file and mirrors that change into the in-memory policy. It is the network analogue of command-prefix amendment updates.

**Data flow**: Reads `codex_home`, `host`, `protocol`, `decision`, and optional `justification`; acquires `update_lock`; computes the default policy path; clones string inputs for a blocking closure; runs `blocking_append_network_rule` in `spawn_blocking`; clones the current policy, adds the network rule in memory, stores the updated `Arc<Policy>`, and returns success or a structured update error.

**Call relations**: Used when the system persists a user-approved network access decision. Like command amendments, it serializes updates and keeps file-backed and in-memory policy state aligned.

*Call graph*: calls 2 internal fn (current, default_policy_path); 4 external calls (new, store, acquire, spawn_blocking).


##### `ExecPolicyManager::default`  (lines 475–477)

```
fn default() -> Self
```

**Purpose**: Creates a manager with an empty policy for tests and fallback scenarios. It provides a no-rules baseline where all decisions come from heuristics.

**Data flow**: Constructs `Policy::empty()`, wraps it in `Arc`, passes it to `ExecPolicyManager::new`, and returns the manager.

**Call relations**: Widely used by tests that want to exercise heuristic behavior without any explicit rules. It is also a convenient fallback constructor when no policy files exist.

*Call graph*: called by 13 (append_execpolicy_amendment_rejects_empty_prefix, append_execpolicy_amendment_updates_policy_and_file, empty_bash_lc_script_falls_back_to_original_command, exec_approval_requirement_falls_back_to_heuristics, request_rule_falls_back_when_prefix_rule_does_not_approve_all_commands, request_rule_uses_prefix_rule, whitespace_bash_lc_script_falls_back_to_original_command, spawn_internal, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx (+3 more)); 3 external calls (new, new, empty).


##### `check_execpolicy_for_warnings`  (lines 480–485)

```
async fn check_execpolicy_for_warnings(
    config_stack: &ConfigLayerStack,
) -> Result<Option<ExecPolicyError>, ExecPolicyError>
```

**Purpose**: Loads exec policy only far enough to surface parse warnings without constructing a manager. It lets callers report non-fatal policy issues separately from normal loading.

**Data flow**: Reads `config_stack`, awaits `load_exec_policy_with_warning`, discards the returned `Policy`, and returns just the optional warning.

**Call relations**: Called by warning/reporting paths that need to know whether trusted rules contain parse errors. It delegates all actual loading logic to `load_exec_policy_with_warning`.

*Call graph*: calls 1 internal fn (load_exec_policy_with_warning).


##### `exec_policy_message_for_display`  (lines 487–507)

```
fn exec_policy_message_for_display(source: &codex_execpolicy::Error) -> String
```

**Purpose**: Extracts a concise, user-facing error message from a verbose `codex_execpolicy::Error`. It prefers the most actionable line over raw parser output.

**Data flow**: Converts `source` to a string, searches for a line beginning with `error: `, otherwise tries to strip a `: starlark error: ` prefix from the first line, otherwise falls back to the first trimmed line. Returns the chosen message string.

**Call relations**: Used by `format_exec_policy_error_with_source` to produce cleaner diagnostics for UI or logs. It encapsulates parser-message normalization.

*Call graph*: called by 1 (format_exec_policy_error_with_source); 1 external calls (to_string).


##### `parse_starlark_line_from_message`  (lines 509–523)

```
fn parse_starlark_line_from_message(message: &str) -> Option<(PathBuf, usize)>
```

**Purpose**: Parses a `path:line:column: starlark error:` prefix out of a textual parser error message. It recovers source location when structured location data is absent or incomplete.

**Data flow**: Reads the first line of `message`, splits it around `: starlark error:`, parses the trailing column and line numbers with `rsplitn`, converts the remaining prefix into a `PathBuf`, rejects line `0`, and returns `Some((path, line))` or `None`.

**Call relations**: This helper feeds `format_exec_policy_error_with_source`, which combines structured and parsed locations to render better diagnostics.

*Call graph*: called by 1 (format_exec_policy_error_with_source); 1 external calls (from).


##### `format_exec_policy_error_with_source`  (lines 525–556)

```
fn format_exec_policy_error_with_source(error: &ExecPolicyError) -> String
```

**Purpose**: Formats `ExecPolicyError` values into user-facing strings that include source file and approximate line information when available. Parse errors get special treatment; other errors use their default display text.

**Data flow**: Reads an `ExecPolicyError`; for `ParsePolicy`, it renders the underlying source, extracts structured and parsed locations, chooses the best location, derives a concise message via `exec_policy_message_for_display`, and returns a formatted string with `path:line:` and an `on or around line` hint when possible. For non-parse errors it returns `error.to_string()`.

**Call relations**: Used by callers that need a polished diagnostic rather than the raw error enum. It delegates message cleanup and fallback line parsing to dedicated helpers.

*Call graph*: calls 2 internal fn (exec_policy_message_for_display, parse_starlark_line_from_message); 2 external calls (to_string, format!).


##### `load_exec_policy_with_warning`  (lines 558–566)

```
async fn load_exec_policy_with_warning(
    config_stack: &ConfigLayerStack,
) -> Result<(Policy, Option<ExecPolicyError>), ExecPolicyError>
```

**Purpose**: Loads exec policy while downgrading parse failures into warnings and an empty policy. This keeps malformed trusted rules from crashing the system while still surfacing the issue.

**Data flow**: Awaits `load_exec_policy(config_stack)`; on success returns `(policy, None)`; on `ExecPolicyError::ParsePolicy` returns `(Policy::empty(), Some(err))`; on other errors returns `Err(err)`.

**Call relations**: Called by both `ExecPolicyManager::load` and `check_execpolicy_for_warnings`. It is the boundary where parse errors become non-fatal warnings.

*Call graph*: calls 1 internal fn (load_exec_policy); called by 2 (load, check_execpolicy_for_warnings); 1 external calls (empty).


##### `load_exec_policy`  (lines 568–625)

```
async fn load_exec_policy(config_stack: &ConfigLayerStack) -> Result<Policy, ExecPolicyError>
```

**Purpose**: Discovers, reads, parses, and merges all applicable exec-policy rule files from the configuration stack. It also overlays requirements-specified policy after file-based rules are loaded.

**Data flow**: Reads `config_stack`, iterates enabled layers in lowest-precedence-first order, skips user/project layers when `ignore_user_and_project_exec_policy_rules()` is set, collects `rules/*.rules` paths via `collect_policy_files`, reads each file asynchronously with `fs::read_to_string`, parses contents into a `PolicyParser`, builds the final `Policy`, and if `requirements().exec_policy` exists merges it as an overlay before returning.

**Call relations**: This is the core policy-loading routine used by startup, warning checks, and config-state builders. It delegates directory scanning to `collect_policy_files` and leaves warning downgrading to `load_exec_policy_with_warning`.

*Call graph*: calls 5 internal fn (get_layers, ignore_user_and_project_exec_policy_rules, requirements, collect_policy_files, new); called by 4 (loads_requirements_exec_policy_without_rules_files, merges_requirements_exec_policy_with_file_rules, load_exec_policy_with_warning, build_config_state_with_mtimes); 5 external calls (new, read_to_string, matches!, debug!, trace!).


##### `render_decision_for_unmatched_command`  (lines 628–745)

```
fn render_decision_for_unmatched_command(
    command: &[String],
    context: UnmatchedCommandContext<'_>,
) -> Decision
```

**Purpose**: Computes the fallback `Decision` for a command segment that matched no explicit exec-policy rule. It combines command safety heuristics, approval policy, sandbox shape, Windows backend availability, and escalation requests.

**Data flow**: Reads `command` and `UnmatchedCommandContext`; determines whether the command is known-safe using generic or PowerShell-specific classifiers; computes whether managed filesystem restrictions exist without a usable Windows sandbox backend; checks dangerous-command heuristics; then branches on `AskForApproval` and filesystem sandbox kind to return `Decision::Allow`, `Decision::Prompt`, or `Decision::Forbidden`.

**Call relations**: This function is passed as the fallback closure into policy evaluation from `create_exec_approval_requirement_for_command`. It is the heuristic engine used only when no explicit rule decides the command.

*Call graph*: calls 5 internal fn (profile_has_managed_filesystem_restrictions, command_might_be_dangerous, is_dangerous_powershell_words, is_known_safe_command, is_safe_powershell_words); 2 external calls (cfg!, matches!).


##### `profile_has_managed_filesystem_restrictions`  (lines 747–755)

```
fn profile_has_managed_filesystem_restrictions(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Detects whether a `PermissionProfile` represents a managed restricted filesystem policy that does not grant full-disk write access. This is used to decide whether lack of a real Windows sandbox backend should force conservative prompting.

**Data flow**: Reads `permission_profile`, obtains its filesystem sandbox policy, checks that the profile is `PermissionProfile::Managed`, the sandbox kind is `Restricted`, and `has_full_disk_write_access()` is false. Returns a boolean.

**Call relations**: Called only from `render_decision_for_unmatched_command` as part of the Windows-specific conservative fallback logic.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy); called by 1 (render_decision_for_unmatched_command); 1 external calls (matches!).


##### `default_policy_path`  (lines 757–759)

```
fn default_policy_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the path of the default writable rules file under the Codex home directory. This is where appended amendments and network rules are persisted.

**Data flow**: Reads `codex_home`, joins `rules` and `default.rules`, and returns the resulting `PathBuf`.

**Call relations**: Used by both append/update methods to know where to write new rules on disk.

*Call graph*: called by 2 (append_amendment_and_update, append_network_rule_and_update); 1 external calls (join).


##### `commands_for_exec_policy`  (lines 761–799)

```
fn commands_for_exec_policy(command: &[String]) -> ExecPolicyCommands
```

**Purpose**: Normalizes a top-level command into the command segments that exec-policy should evaluate. It understands shell wrappers and PowerShell wrappers and records whether parsing had to fall back to a less precise mode.

**Data flow**: Reads `command`; first tries `parse_shell_lc_plain_commands`, then on Windows tries PowerShell lowering, then tries `parse_shell_lc_single_command_prefix` for complex/heredoc fallback, and finally falls back to the original argv as a single command. Returns `ExecPolicyCommands { commands, used_complex_parsing, command_origin }`.

**Call relations**: Called by `create_exec_approval_requirement_for_command` before policy evaluation. Its output influences both rule matching and whether automatic amendment suggestions are allowed.

*Call graph*: calls 3 internal fn (parse_shell_lc_plain_commands, parse_shell_lc_single_command_prefix, parse_powershell_command_into_plain_commands); called by 1 (create_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `try_derive_execpolicy_amendment_for_prompt_rules`  (lines 811–830)

```
fn try_derive_execpolicy_amendment_for_prompt_rules(
    matched_rules: &[RuleMatch],
) -> Option<ExecPolicyAmendment>
```

**Purpose**: Suggests an exec-policy amendment for a prompt outcome only when no explicit policy rule already prompted. It chooses the first heuristic prompt command as the amendment target.

**Data flow**: Reads `matched_rules`; if any explicit policy match has `Decision::Prompt`, returns `None`; otherwise scans for the first `HeuristicsRuleMatch` with `Decision::Prompt` and converts its command into `ExecPolicyAmendment`.

**Call relations**: Used from `create_exec_approval_requirement_for_command` when a command needs approval and no requested prefix-rule amendment was accepted. It avoids suggesting amendments that would not actually remove a policy-driven prompt.

*Call graph*: 1 external calls (iter).


##### `try_derive_execpolicy_amendment_for_allow_rules`  (lines 835–851)

```
fn try_derive_execpolicy_amendment_for_allow_rules(
    matched_rules: &[RuleMatch],
) -> Option<ExecPolicyAmendment>
```

**Purpose**: Suggests an amendment for heuristic allow decisions so future runs can bypass sandbox for similar commands. It only does so when no explicit policy rule matched at all.

**Data flow**: Reads `matched_rules`; returns `None` if any rule is an explicit policy match; otherwise finds the first `HeuristicsRuleMatch` with `Decision::Allow` and wraps its command in `ExecPolicyAmendment`.

**Call relations**: Called from `create_exec_approval_requirement_for_command` when the overall decision is `Allow`. It is specifically used to propose future sandbox bypasses for commands currently allowed only by heuristics.

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

**Purpose**: Validates and possibly accepts a caller-supplied prefix rule as the proposed amendment for a command. It rejects empty, banned, conflicting, or ineffective prefixes.

**Data flow**: Reads optional `prefix_rule`, `matched_rules`, `exec_policy`, parsed `commands`, fallback closure, and `match_options`; returns `None` if the prefix is missing, empty, exactly matches a banned suggestion, or any explicit policy rule already matched. Otherwise constructs an `ExecPolicyAmendment` and returns it only if `prefix_rule_would_approve_all_commands(...)` is true.

**Call relations**: This helper is consulted first by `create_exec_approval_requirement_for_command` when the caller supplied a preferred amendment prefix. It delegates the effectiveness check to `prefix_rule_would_approve_all_commands`.

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

**Purpose**: Checks whether adding a proposed allow-prefix rule would make every parsed command segment evaluate to `Allow`. This prevents suggesting a prefix that only covers part of a multi-command script.

**Data flow**: Clones `exec_policy`, attempts to add the proposed allow prefix rule, returns `false` if rule insertion fails, otherwise evaluates every command in `commands` with `check_with_options` using the supplied fallback and match options, and returns `true` only if all decisions are `Allow`.

**Call relations**: Used exclusively by `derive_requested_execpolicy_amendment_from_prefix_rule` to validate caller-supplied amendment prefixes against the actual parsed command set.

*Call graph*: called by 1 (derive_requested_execpolicy_amendment_from_prefix_rule); 1 external calls (clone).


##### `derive_prompt_reason`  (lines 918–944)

```
fn derive_prompt_reason(command_args: &[String], evaluation: &Evaluation) -> Option<String>
```

**Purpose**: Builds a human-readable reason string for prompt outcomes when an explicit policy prompt rule caused the prompt. It prefers the most specific matching prompt rule and includes user justification when present.

**Data flow**: Reads original `command_args` and `evaluation`, renders the command with `render_shlex_command`, scans `matched_rules` for `PrefixRuleMatch` entries with `Decision::Prompt`, chooses the longest matched prefix, and returns `Some(String)` with either the rule justification or a generic policy message; returns `None` if no policy prompt rule matched.

**Call relations**: Called by `create_exec_approval_requirement_for_command` when converting a `Decision::Prompt` evaluation into `ExecApprovalRequirement::NeedsApproval`.

*Call graph*: calls 1 internal fn (render_shlex_command); called by 1 (create_exec_approval_requirement_for_command); 1 external calls (format!).


##### `render_shlex_command`  (lines 946–948)

```
fn render_shlex_command(args: &[String]) -> String
```

**Purpose**: Formats argv into a shell-escaped command string suitable for user-facing messages. It falls back to simple space-joining if shell escaping fails.

**Data flow**: Reads `args`, attempts `shlex::try_join` over `&str` slices, and returns the escaped string or `args.join(" ")` on failure.

**Call relations**: Used by both prompt and forbidden reason renderers so user-visible messages show the original command in a readable form.

*Call graph*: called by 2 (derive_forbidden_reason, derive_prompt_reason); 1 external calls (try_join).


##### `derive_forbidden_reason`  (lines 953–980)

```
fn derive_forbidden_reason(command_args: &[String], evaluation: &Evaluation) -> String
```

**Purpose**: Builds the rejection message for forbidden command outcomes. It prefers the most specific matching forbidden prefix rule and includes any rule justification.

**Data flow**: Reads `command_args` and `evaluation`, renders the full command string, scans `matched_rules` for `PrefixRuleMatch` entries with `Decision::Forbidden`, chooses the longest matched prefix, and returns a formatted string using either the rule justification, the matched prefix, or a generic `blocked by policy` fallback.

**Call relations**: Called by `create_exec_approval_requirement_for_command` when the final evaluation decision is `Forbidden`.

*Call graph*: calls 1 internal fn (render_shlex_command); called by 1 (create_exec_approval_requirement_for_command); 1 external calls (format!).


##### `collect_policy_files`  (lines 982–1032)

```
async fn collect_policy_files(dir: impl AsRef<Path>) -> Result<Vec<PathBuf>, ExecPolicyError>
```

**Purpose**: Lists and sorts all `.rules` files in a policy directory, treating a missing directory as empty. It is the filesystem discovery step for policy loading.

**Data flow**: Reads `dir`, attempts `fs::read_dir`; returns an empty vector on `NotFound`, otherwise wraps read errors in `ExecPolicyError::ReadDir`. It iterates directory entries, fetches each `file_type`, keeps only regular files whose extension equals `RULE_EXTENSION`, sorts the resulting `Vec<PathBuf>`, logs a debug message, and returns it.

**Call relations**: Called by `load_exec_policy` for each applicable config layer’s `rules/` directory. It isolates directory traversal and error mapping from parser logic.

*Call graph*: called by 1 (load_exec_policy); 5 external calls (as_ref, to_path_buf, new, read_dir, debug!).


### `core/src/network_policy_decision.rs`

`domain_logic` · `network approval handling and blocked-request reporting`

This file contains small but important conversion logic around network approvals. `ExecPolicyNetworkRuleAmendment` is a local struct representing the subset of an approval amendment needed to write an exec-policy network rule: protocol, allow/forbid decision, and a human-readable justification. The private parser `parse_network_policy_decision` recognizes only the string values `deny` and `ask`, matching the serialized forms used by blocked proxy requests.

`network_approval_context_from_payload` extracts a `NetworkApprovalContext` only from payloads that represent an ask decision originating from the decider. It requires both a protocol and a non-empty trimmed host, so malformed or already-final decisions never produce approval context. `denied_network_policy_message` turns a `BlockedRequest` into a user-facing explanation only when the blocked request’s serialized decision is `deny`; it maps known reason codes like `denied`, `not_allowed`, `not_allowed_local`, `method_not_allowed`, and `proxy_disabled` to explicit text, with a generic fallback and a special host-empty fallback message. Finally, `execpolicy_network_rule_amendment` maps protocol enums from approval-layer types to exec-policy types, converts allow/deny actions into `ExecPolicyDecision::{Allow,Forbidden}`, and synthesizes a justification string such as `Allow https_connect access to example.com`.

#### Function details

##### `parse_network_policy_decision`  (lines 18–24)

```
fn parse_network_policy_decision(value: &str) -> Option<NetworkPolicyDecision>
```

**Purpose**: Parses the serialized decision string found on blocked requests into a `NetworkPolicyDecision` enum for the subset of values this module cares about.

**Data flow**: Takes a `&str`, matches `"deny"` to `Some(NetworkPolicyDecision::Deny)`, `"ask"` to `Some(NetworkPolicyDecision::Ask)`, and returns `None` for any other string.

**Call relations**: Used internally by `denied_network_policy_message` to decide whether a blocked request should produce a denial message.


##### `network_approval_context_from_payload`  (lines 26–44)

```
fn network_approval_context_from_payload(
    payload: &NetworkPolicyDecisionPayload,
) -> Option<NetworkApprovalContext>
```

**Purpose**: Extracts the host/protocol pair needed for a network approval prompt from a network policy decision payload, but only for decider-originated ask decisions.

**Data flow**: Reads `payload.is_ask_from_decider()`, `payload.protocol`, and `payload.host`. If the payload is not an ask-from-decider, lacks a protocol, lacks a host, or has an empty trimmed host, it returns `None`. Otherwise it returns `Some(NetworkApprovalContext { host: trimmed_host.to_string(), protocol })`.

**Call relations**: Called by approval-handling code when deciding whether a blocked network event should be turned into an approval request.

*Call graph*: calls 1 internal fn (is_ask_from_decider).


##### `denied_network_policy_message`  (lines 46–72)

```
fn denied_network_policy_message(blocked: &BlockedRequest) -> Option<String>
```

**Purpose**: Builds a user-facing explanation for a blocked network request when policy has definitively denied it.

**Data flow**: Reads `blocked.decision`, parses it with `parse_network_policy_decision`, and returns `None` unless the result is `Some(Deny)`. It trims `blocked.host`; if empty, it returns a generic denial message. Otherwise it maps `blocked.reason` to a detailed explanation string and returns `Some(format!(...))` naming the host and detail.

**Call relations**: Called by `record_blocked_request` when surfacing blocked network activity to the user or transcript.

*Call graph*: called by 1 (record_blocked_request); 1 external calls (format!).


##### `execpolicy_network_rule_amendment`  (lines 74–102)

```
fn execpolicy_network_rule_amendment(
    amendment: &NetworkPolicyAmendment,
    network_approval_context: &NetworkApprovalContext,
    host: &str,
) -> ExecPolicyNetworkRuleAmendment
```

**Purpose**: Converts an approval-layer network amendment into the exec-policy representation used for persistence.

**Data flow**: Takes a `NetworkPolicyAmendment`, `NetworkApprovalContext`, and host string. It maps `NetworkApprovalProtocol` to `ExecPolicyNetworkRuleProtocol`, maps amendment action `Allow`/`Deny` to `ExecPolicyDecision::Allow`/`Forbidden` plus an action verb, derives a protocol label string, formats a justification like `Deny socks5_udp access to example.com`, and returns `ExecPolicyNetworkRuleAmendment { protocol, decision, justification }`.

**Call relations**: Called by `persist_network_policy_amendment` after the user has approved or denied a network rule change, providing the exact exec-policy fields to write.

*Call graph*: called by 1 (persist_network_policy_amendment); 1 external calls (format!).


### `core/src/safety.rs`

`domain_logic` · `patch application approval check before executing apply_patch`

This file contains the core patch-safety policy for write operations. It defines `SafetyCheck` as the three possible outcomes: auto-approve with a specific `SandboxType` and approval provenance flag, ask the user, or reject with a concrete reason string. `assess_patch_safety` is the main decision engine. It first rejects empty patches outright. It then interprets `AskForApproval`: `UnlessTrusted` immediately forces `AskUser`, while the other modes continue into sandbox analysis. A derived `rejects_sandbox_approval` flag captures the stricter cases where the system is not allowed to ask for sandbox approval (`Never` or granular config with `sandbox_approval: false`).

The key safety test is `is_write_patch_constrained_to_writable_paths`, which checks every changed path in the patch against the filesystem sandbox policy after resolving paths against `cwd` and normalizing `.` and `..` components without touching the filesystem. Adds and deletes must target writable paths; updates must allow both the source path and any move destination. If the patch is constrained to writable paths, or the policy is `OnFailure`, the code tries to auto-approve. For `PermissionProfile::Disabled` and `External`, that means no outer Codex filesystem sandbox (`SandboxType::None`). For managed profiles, auto-approval requires an actual platform sandbox from `get_platform_sandbox`; otherwise the code either rejects with a reason derived by `patch_rejection_reason` or asks the user. `patch_rejection_reason` distinguishes read-only managed sandboxes with no writable roots from the broader "outside project" case.

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

**Purpose**: Determines whether a patch operation should be auto-approved, escalated to the user, or rejected under the current approval mode, permission profile, filesystem sandbox policy, and platform sandbox availability.

**Data flow**: It takes an `ApplyPatchAction`, approval policy, permission profile, filesystem sandbox policy, current working directory, and Windows sandbox level. It first reads `action.is_empty()` and returns `Reject { reason: "empty patch" }` if true. It then branches on `policy`, immediately returning `AskUser` for `UnlessTrusted` and otherwise computing whether sandbox approval is disallowed. Next it evaluates `is_write_patch_constrained_to_writable_paths(action, file_system_sandbox_policy, cwd)` or accepts `OnFailure` as auto-approvable. In that branch it returns `AutoApprove { sandbox_type: None, ... }` for `Disabled` and `External` profiles, or for managed profiles tries `get_platform_sandbox(...)`; success yields `AutoApprove` with that sandbox type, failure yields either `Reject` with `patch_rejection_reason(...).to_string()` or `AskUser`. If the patch is not constrained and sandbox approval is disallowed, it rejects with the same reason; otherwise it returns `AskUser`.

**Call relations**: This function is called by `apply_patch` before patch execution. It delegates path-scope analysis to `is_write_patch_constrained_to_writable_paths`, rejection-message selection to `patch_rejection_reason`, and platform sandbox discovery to `get_platform_sandbox`, making it the top-level policy coordinator for patch approval.

*Call graph*: calls 3 internal fn (is_empty, is_write_patch_constrained_to_writable_paths, patch_rejection_reason); called by 1 (apply_patch); 2 external calls (get_platform_sandbox, matches!).


##### `patch_rejection_reason`  (lines 118–136)

```
fn patch_rejection_reason(
    permission_profile: &PermissionProfile,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> &'static str
```

**Purpose**: Chooses the specific static rejection reason string for a denied patch based on the permission profile and whether the managed filesystem sandbox is effectively read-only.

**Data flow**: It takes references to the permission profile, filesystem sandbox policy, and current working directory. For `PermissionProfile::Managed` it checks `has_full_disk_write_access()` and `get_writable_roots_with_cwd(cwd.as_path())`; if there is no full-disk write access and no writable roots, it returns `PATCH_REJECTED_READ_ONLY_REASON`, otherwise it returns `PATCH_REJECTED_OUTSIDE_PROJECT_REASON`. For `Disabled` and `External` it also returns the outside-project reason. It returns a `&'static str` and mutates nothing.

**Call relations**: This helper is called only by `assess_patch_safety` in rejection paths. It isolates the wording logic so the main decision tree can reuse the same reason selection in multiple branches.

*Call graph*: calls 3 internal fn (get_writable_roots_with_cwd, has_full_disk_write_access, as_path); called by 1 (assess_patch_safety).


##### `is_write_patch_constrained_to_writable_paths`  (lines 138–193)

```
fn is_write_patch_constrained_to_writable_paths(
    action: &ApplyPatchAction,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> bool
```

**Purpose**: Checks whether every path touched by a patch falls within locations writable under the current filesystem sandbox policy. It is the core predicate used to decide whether a patch can be safely auto-approved.

**Data flow**: It takes an `ApplyPatchAction`, filesystem sandbox policy, and current working directory. Internally it defines `normalize`, which removes `.` and resolves `..` path components syntactically, and a closure `is_path_writable` that resolves each candidate path against `cwd` with `resolve_path`, normalizes it, and asks `file_system_sandbox_policy.can_write_path_with_cwd(&abs, cwd)`. It then iterates over `action.changes()`: `Add` and `Delete` require the target path to be writable; `Update` requires both the original path and any `move_path` destination to be writable. It returns `false` on the first violation and `true` only if all touched paths pass.

**Call relations**: This predicate is called by `assess_patch_safety` before any auto-approval decision. It does not call other file-local helpers, but it encapsulates the detailed per-change path validation that the top-level policy depends on.

*Call graph*: calls 1 internal fn (changes); called by 1 (assess_patch_safety).


### Legacy policy compilation and matching
These legacy-policy files expose the old API, parse Starlark policies, and implement argument and program matching against compiled specs.

### `execpolicy-legacy/src/lib.rs`

`orchestration` · `startup`

This is the library root for the legacy exec policy crate. It declares the internal modules that implement argument matching, parsing, policy evaluation, executable checking, and validated command representations, then re-exports the main types (`Policy`, `PolicyParser`, `ExecCall`, `ExecvChecker`, `ProgramSpec`, `MatchedExec`, `ValidExec`, error/result types, and supporting argument/option types) so downstream code can use the crate without importing submodules directly. It also embeds `default.policy` at compile time with `include_str!`, making the default ruleset part of the binary rather than a runtime file dependency.

The only behavior in this file is `get_default_policy`, which constructs a `PolicyParser` with a synthetic source name `#default` and the embedded policy text, then parses it into a `Policy`. Because it returns `starlark::Result<Policy>`, callers can distinguish parser/evaluator failures from later policy-checking errors. This file is intentionally thin: it centralizes module wiring and stable exports while leaving all substantive parsing and checking logic to the dedicated modules.

#### Function details

##### `get_default_policy`  (lines 42–45)

```
fn get_default_policy() -> starlark::Result<Policy>
```

**Purpose**: Parses the built-in `default.policy` text into a `Policy` object ready for command checking.

**Data flow**: Reads the compile-time constant `DEFAULT_POLICY`, constructs a `PolicyParser` with source label `#default`, invokes `parse`, and returns the resulting `starlark::Result<Policy>` without additional transformation.

**Call relations**: Called by the CLI `main` path when the user does not supply `--policy`, providing the default ruleset for the rest of execution.

*Call graph*: calls 1 internal fn (new); called by 1 (main).


### `execpolicy-legacy/src/policy_parser.rs`

`config` · `config load`

This file is the configuration-loading core of the crate. `PolicyParser` stores a source label and raw policy text, then `parse` configures a Starlark `Dialect::Extended` with f-strings enabled, parses the source into an `AstModule`, builds globals extended with typing support plus the local `policy_builtins`, and evaluates the module inside `Module::with_temp_heap`. Before evaluation it seeds the module with constants such as `ARG_RFILE`, `ARG_WFILE`, `ARG_POS_INT`, and `ARG_SED_COMMAND`, each allocated from an `ArgMatcher` variant so policy authors can refer to typed argument patterns directly.

State accumulation happens through `PolicyBuilder`, which is attached to `Evaluator.extra` and uses `RefCell` fields to gather `ProgramSpec`s, forbidden program regexes, and forbidden substrings during evaluation. After the Starlark module runs, `PolicyBuilder::build` consumes those collections and calls `Policy::new`, converting regex-construction failures into Starlark "other" errors.

The `#[starlark_module]` function defines the policy DSL surface. `define_program` normalizes optional parameters, rejects duplicate option names by building a `HashMap<String, Opt>`, constructs a `ProgramSpec`, and registers it with the builder. `forbid_substrings` and `forbid_program_regex` append global bans. `opt` and `flag` are convenience constructors that produce `Opt` values with `OptMeta::Value(...)` or `OptMeta::Flag`. The design keeps parsing declarative: Starlark code only calls builtins, while all semantic objects are created in Rust.

#### Function details

##### `PolicyParser::new`  (lines 29–34)

```
fn new(policy_source: &str, unparsed_policy: &str) -> Self
```

**Purpose**: Creates a parser instance holding the policy source name and raw policy text.

**Data flow**: Copies `policy_source` and `unparsed_policy` into owned `String` fields and returns a `PolicyParser`.

**Call relations**: Used by both library and tests before invoking `parse`; it is the lightweight setup step for policy compilation.


##### `PolicyParser::parse`  (lines 36–67)

```
fn parse(&self) -> starlark::Result<Policy>
```

**Purpose**: Compiles and evaluates the Starlark policy text, then converts the collected declarations into a `Policy`.

**Data flow**: Reads `self.policy_source` and `self.unparsed_policy`, configures a Starlark dialect, parses an `AstModule`, builds globals with `policy_builtins`, creates a fresh `PolicyBuilder`, and evaluates the module in a temporary heap after injecting predefined `ARG_*` constants. Evaluation mutates the builder through `Evaluator.extra`; afterward the builder is consumed with `build()`. Any builder/regex error is wrapped into a Starlark `ErrorKind::Other`.

**Call relations**: This is the main parser entry used by `get_default_policy`, the CLI when loading a policy file, and tests. It delegates declaration handling to the builtins and final assembly to `PolicyBuilder::build`.

*Call graph*: calls 1 internal fn (new); 3 external calls (parse, extended_by, with_temp_heap).


##### `PolicyBuilder::new`  (lines 84–90)

```
fn new() -> Self
```

**Purpose**: Initializes an empty mutable collector for program specs and global forbid rules discovered during policy evaluation.

**Data flow**: Creates empty `MultiMap`, `Vec<ForbiddenProgramRegex>`, and `Vec<String>` values inside `RefCell`s and returns the assembled builder.

**Call relations**: Constructed inside `PolicyParser::parse` and then exposed to builtin functions through `Evaluator.extra`.

*Call graph*: 3 external calls (new, new, new).


##### `PolicyBuilder::build`  (lines 92–97)

```
fn build(self) -> Result<Policy, regex_lite::Error>
```

**Purpose**: Consumes the builder and turns its accumulated declarations into a compiled `Policy`.

**Data flow**: Takes ownership of `self`, extracts the inner `programs`, `forbidden_program_regexes`, and `forbidden_substrings` from their `RefCell`s, and passes them to `Policy::new`, returning its result.

**Call relations**: Called at the end of `PolicyParser::parse` after Starlark evaluation has finished populating the builder.

*Call graph*: 1 external calls (new).


##### `PolicyBuilder::add_program_spec`  (lines 99–104)

```
fn add_program_spec(&self, program_spec: ProgramSpec)
```

**Purpose**: Registers one parsed `ProgramSpec` under its program name in the builder's multimap.

**Data flow**: Reads `program_spec.program` to clone the key, logs the full spec with `info!`, mutably borrows `self.programs`, and inserts the spec into the multimap.

**Call relations**: Invoked by the `define_program` builtin each time the policy declares a program rule.

*Call graph*: 1 external calls (info!).


##### `PolicyBuilder::add_forbidden_substrings`  (lines 106–109)

```
fn add_forbidden_substrings(&self, substrings: &[String])
```

**Purpose**: Appends a batch of forbidden argument substrings to the builder's global list.

**Data flow**: Mutably borrows `self.forbidden_substrings` and extends it from the provided slice of `String`s.

**Call relations**: Called by the `forbid_substrings` builtin when the policy declares globally banned substrings.


##### `PolicyBuilder::add_forbidden_program_regex`  (lines 111–114)

```
fn add_forbidden_program_regex(&self, regex: Regex, reason: String)
```

**Purpose**: Stores one compiled forbidden-program regex and its explanatory reason.

**Data flow**: Mutably borrows `self.forbidden_program_regexes` and pushes a new `ForbiddenProgramRegex { regex, reason }`.

**Call relations**: Called by the `forbid_program_regex` builtin after the regex string has been compiled successfully.


##### `policy_builtins`  (lines 118–222)

```
fn policy_builtins(builder: &mut GlobalsBuilder)
```

**Purpose**: Defines the Starlark builtin functions that make up the policy DSL: program declarations, global forbids, and option constructors.

**Data flow**: Receives a mutable `GlobalsBuilder` and registers nested builtin functions. `define_program` reads typed Starlark arguments, normalizes missing lists/booleans to defaults, builds a deduplicated `HashMap<String, Opt>`, constructs a `ProgramSpec`, retrieves the attached `PolicyBuilder` from `eval.extra`, and stores the spec. `forbid_substrings` and `forbid_program_regex` retrieve the same builder and append global rules, compiling regex text in the latter case. `opt` and `flag` transform Starlark declarations into `Opt` values using `OptMeta` and `ArgMatcher::arg_type()`.

**Call relations**: Installed into the Starlark globals by `PolicyParser::parse`; these builtins are invoked by evaluated policy source and are the only sanctioned way for policy code to mutate the builder.


### `execpolicy-legacy/src/arg_resolver.rs`

`domain_logic` · `request handling`

This file implements the legacy argument-binding algorithm used when checking whether an exec call conforms to a policy. `PositionalArg` stores the original argument index and string value so later errors and matched results preserve source positions. The main function, `resolve_observed_args_with_patterns`, first calls `partition_args` to divide the declared matcher list into fixed-width prefix patterns, an optional single vararg pattern, and fixed-width suffix patterns, while also precomputing how many observed arguments the prefix and suffix must consume.

Matching then proceeds in three phases. First, it slices the observed arguments for the prefix using `get_range_checked`, requires each prefix pattern to have exact cardinality, and constructs `MatchedArg` values with `MatchedArg::new`, which validates each string against the pattern’s derived `ArgType`. Second, if a vararg pattern exists, it binds all arguments between the consumed prefix and the reserved suffix tail; `AtLeastOne` rejects an empty middle section, `ZeroOrMore` accepts zero or more, and `One` is treated as an internal invariant violation because fixed-width patterns should never become the vararg slot. Third, it matches the suffix against the remaining tail slice in the same exact-cardinality manner. The function returns structured errors for too few args, overlapping prefix/suffix ranges, multiple vararg patterns, invalid slice bounds, or leftover unmatched arguments. `get_range_checked` centralizes slice-bound validation so these failures become domain errors instead of panics.

#### Function details

##### `resolve_observed_args_with_patterns`  (lines 15–145)

```
fn resolve_observed_args_with_patterns(
    program: &str,
    args: Vec<PositionalArg>,
    arg_patterns: &Vec<ArgMatcher>,
) -> Result<Vec<MatchedArg>>
```

**Purpose**: Binds a concrete argument vector to a declared matcher sequence and returns validated `MatchedArg` entries in positional order. It is the main legacy policy argument-resolution routine.

**Data flow**: Inputs are the program name, a `Vec<PositionalArg>`, and a pattern list `&Vec<ArgMatcher>`. It partitions the patterns, slices the observed args into prefix/middle/suffix regions with `get_range_checked`, converts each bound argument through `pattern.arg_type()`, validates and wraps it with `MatchedArg::new`, and accumulates the results. It returns `Ok(Vec<MatchedArg>)` on a full match or a domain `Error` for invariant violations, insufficient args, empty required varargs, overlapping ranges, out-of-bounds slices, or extra unmatched arguments.

**Call relations**: This function is called by higher-level policy checking code. Internally it delegates structural preprocessing to `partition_args` and safe slicing to `get_range_checked`, then performs the actual binding and validation loop itself.

*Call graph*: calls 3 internal fn (get_range_checked, partition_args, new); called by 1 (check); 1 external calls (new).


##### `partition_args`  (lines 156–188)

```
fn partition_args(program: &str, arg_patterns: &Vec<ArgMatcher>) -> Result<ParitionedArgs>
```

**Purpose**: Splits the declared matcher list into fixed-width prefix patterns, one optional vararg pattern, and fixed-width suffix patterns. It also counts how many observed arguments the fixed sections must consume.

**Data flow**: Takes the program name and matcher vector reference, initializes a default `ParitionedArgs`, and iterates the patterns in order. Exact-cardinality patterns are cloned into either the prefix or suffix list depending on whether a vararg has been seen; the first variable-cardinality pattern becomes `vararg_pattern` and flips subsequent exact patterns into the suffix; a second variable-cardinality pattern returns `Error::MultipleVarargPatterns`. On success it returns the populated `ParitionedArgs`.

**Call relations**: Only `resolve_observed_args_with_patterns` calls this helper. It performs the one-time structural analysis that lets the main resolver compute the middle vararg span without backtracking.

*Call graph*: called by 1 (resolve_observed_args_with_patterns); 1 external calls (default).


##### `get_range_checked`  (lines 190–204)

```
fn get_range_checked(vec: &[T], range: std::ops::Range<usize>) -> Result<&[T]>
```

**Purpose**: Safely converts a requested index range into a slice, returning domain errors instead of panicking on invalid bounds. It is a small guardrail around Rust slice indexing.

**Data flow**: Accepts a slice `&[T]` and a `Range<usize>`. If `start > end` it returns `Error::RangeStartExceedsEnd`; if `end > vec.len()` it returns `Error::RangeEndOutOfBounds`; otherwise it returns `Ok(&vec[range])`.

**Call relations**: The main resolver calls this repeatedly before indexing prefix, vararg, suffix, and extra-argument regions. Centralizing the checks keeps the matching algorithm explicit and panic-free.

*Call graph*: called by 1 (resolve_observed_args_with_patterns); 1 external calls (len).


### `execpolicy-legacy/src/program.rs`

`domain_logic` · `request handling`

This file contains the heart of command validation. `ProgramSpec` describes one acceptable shape for a program invocation: exact program name, optional concrete `system_path` candidates, option parsing modes, a map of allowed options (`HashMap<String, Opt>`), positional argument patterns (`Vec<ArgMatcher>`), an optional `forbidden` reason that converts a successful parse into a denial, a precomputed `required_options` set, and embedded positive/negative example lists for policy QA. `ProgramSpec::new` derives `required_options` from `allowed_options` once so checks do not need to recompute it.

`ProgramSpec::check` walks `exec_call.args` left to right, maintaining `expecting_option_value` state for options whose `OptMeta` requires a following value. It rejects unsupported `--`, unknown options, missing option values, and the case where an option expecting a value is followed by another option token. Recognized flags become `MatchedFlag`; recognized valued options become `MatchedOpt`; non-option tokens become `PositionalArg` with original index preserved. After the scan, it resolves positional arguments against `self.arg_patterns` using `resolve_observed_args_with_patterns`, then verifies that all required options were present by comparing matched option names against `required_options`. A successful parse yields `ValidExec`; if the spec itself is marked forbidden, the result is `MatchedExec::Forbidden { cause: Forbidden::Exec, reason }`, otherwise `MatchedExec::Match`.

The two verification helpers replay the embedded `should_match` and `should_not_match` examples through `check`, collecting structured violations for policy authors.

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

**Purpose**: Constructs a `ProgramSpec` and precomputes the set of required option names from the supplied allowed-options map.

**Data flow**: Takes ownership of all spec fields, iterates `allowed_options` to collect keys whose `Opt.required` is true into a `HashSet<String>`, and returns a `ProgramSpec` containing both the original map and the derived `required_options`.

**Call relations**: Called by the policy parser's `define_program` builtin when translating a policy declaration into an executable spec.


##### `ProgramSpec::check`  (lines 94–195)

```
fn check(&self, exec_call: &ExecCall) -> Result<MatchedExec>
```

**Purpose**: Parses one `ExecCall` according to this program spec and either returns a validated execution shape or a precise policy error.

**Data flow**: Reads `self.allowed_options`, `self.arg_patterns`, `self.required_options`, `self.system_path`, and `self.forbidden`, then scans `exec_call.args` in order. It accumulates `MatchedFlag`, `MatchedOpt`, and positional `PositionalArg` values while tracking whether the previous option requires a value. It returns early on malformed option sequences or unknown options. After scanning, it resolves positional args with `resolve_observed_args_with_patterns`, computes the set of matched option names, compares it against `required_options`, and may return `MissingRequiredOptions`. On success it builds a `ValidExec`; if `self.forbidden` is `Some`, it wraps that exec in `MatchedExec::Forbidden`, otherwise in `MatchedExec::Match`.

**Call relations**: Invoked by `Policy::check` when trying candidate specs for a program name, and by the example-verification helpers in this same file. It delegates positional-pattern matching to `resolve_observed_args_with_patterns` and constructors for matched option/arg records.

*Call graph*: calls 2 internal fn (resolve_observed_args_with_patterns, new); called by 2 (verify_should_match_list, verify_should_not_match_list); 3 external calls (new, new, new).


##### `ProgramSpec::verify_should_match_list`  (lines 197–216)

```
fn verify_should_match_list(&self) -> Vec<PositiveExampleFailedCheck>
```

**Purpose**: Checks every positive example attached to the spec and records those that fail unexpectedly.

**Data flow**: Creates an empty violations vector, then for each `good` argv list in `self.should_match` constructs an `ExecCall` using `self.program` and `good.clone()`. It calls `self.check(&exec_call)` and, on error, pushes a `PositiveExampleFailedCheck { program, args, error }`. The final vector is returned.

**Call relations**: Called by `Policy::check_each_good_list_individually` during policy self-validation; it uses `ProgramSpec::check` as the oracle.

*Call graph*: calls 1 internal fn (check); 1 external calls (new).


##### `ProgramSpec::verify_should_not_match_list`  (lines 218–233)

```
fn verify_should_not_match_list(&self) -> Vec<NegativeExamplePassedCheck>
```

**Purpose**: Checks every negative example attached to the spec and records those that pass unexpectedly.

**Data flow**: Creates an empty violations vector, then for each `bad` argv list in `self.should_not_match` constructs an `ExecCall` and calls `self.check(&exec_call)`. If the result is `Ok`, it pushes `NegativeExamplePassedCheck { program, args }`. It returns the accumulated violations.

**Call relations**: Called by `Policy::check_each_bad_list_individually` for policy QA, again using `ProgramSpec::check` to determine whether an example incorrectly matches.

*Call graph*: calls 1 internal fn (check); 1 external calls (new).


### `execpolicy-legacy/src/policy.rs`

`domain_logic` · `request handling`

This file defines `Policy`, the compiled form produced by the parser. Its state has three layers: a `MultiMap<String, ProgramSpec>` keyed by program name so multiple specs can exist for one executable, a list of `ForbiddenProgramRegex` entries that immediately ban matching program names with a human-readable reason, and an optional compiled regex that matches any forbidden substring inside arguments. `Policy::new` builds that substring regex once up front by escaping each configured substring and joining them with `|`; if no substrings are configured, it stores `None` to avoid unnecessary regex work.

`Policy::check` enforces policy in a strict order. It first scans forbidden program regexes and returns `MatchedExec::Forbidden` with `Forbidden::Program` if the executable name matches. It then scans every argument against the compiled forbidden-substring regex and returns `Forbidden::Arg` if any argument contains a banned fragment. Only after those global bans pass does it look up program specs by exact program name. It tries each `ProgramSpec` in insertion order, returning the first successful `MatchedExec`; if all specs fail, it preserves the last error encountered, defaulting to `Error::NoSpecForProgram` when no spec exists at all. The two verification helpers iterate every stored spec and aggregate violations from embedded positive and negative example lists, which is useful for validating policy quality rather than checking a live command.

#### Function details

##### `Policy::new`  (lines 22–42)

```
fn new(
        programs: MultiMap<String, ProgramSpec>,
        forbidden_program_regexes: Vec<ForbiddenProgramRegex>,
        forbidden_substrings: Vec<String>,
    ) -> std::result::Result<Self, Re
```

**Purpose**: Constructs a compiled `Policy`, precompiling the forbidden-substring matcher when needed.

**Data flow**: Takes ownership of `programs`, `forbidden_program_regexes`, and `forbidden_substrings`. If the substring list is empty it stores `None`; otherwise it escapes each substring, joins them with `|`, compiles a `Regex` from the grouped pattern, and stores it in `forbidden_substrings_pattern`. It returns either the assembled `Policy` or a regex compilation error.

**Call relations**: Called by `PolicyBuilder::build` after Starlark evaluation has collected all policy declarations.

*Call graph*: 2 external calls (new, format!).


##### `Policy::check`  (lines 44–86)

```
fn check(&self, exec_call: &ExecCall) -> Result<MatchedExec>
```

**Purpose**: Evaluates one `ExecCall` against global forbids and then the set of program-specific specs.

**Data flow**: Reads `exec_call.program` and `exec_call.args`. It first tests the program against each stored forbidden regex and may return `MatchedExec::Forbidden { cause: Forbidden::Program, reason }`. Next it tests each arg against `forbidden_substrings_pattern` and may return `Forbidden::Arg`. If neither global rule fires, it looks up all `ProgramSpec`s for the program name, tries `spec.check(exec_call)` on each, returns the first success, and otherwise returns the last error seen or `Error::NoSpecForProgram` if no spec was found.

**Call relations**: This is the main library entry for policy evaluation. It is called directly by the CLI checker and by `ExecvChecker::r#match`, and it delegates detailed argv interpretation to `ProgramSpec::check`.

*Call graph*: 3 external calls (get_vec, clone, format!).


##### `Policy::check_each_good_list_individually`  (lines 88–94)

```
fn check_each_good_list_individually(&self) -> Vec<PositiveExampleFailedCheck>
```

**Purpose**: Runs every program spec's positive example list and collects examples that unexpectedly fail.

**Data flow**: Creates an empty `Vec<PositiveExampleFailedCheck>`, iterates all `(program, spec)` pairs from `self.programs.flat_iter()`, extends the vector with each spec's `verify_should_match_list()` output, and returns the accumulated violations.

**Call relations**: Used for policy self-validation rather than live command checking; it delegates the actual example execution to each `ProgramSpec`.

*Call graph*: 2 external calls (flat_iter, new).


##### `Policy::check_each_bad_list_individually`  (lines 96–102)

```
fn check_each_bad_list_individually(&self) -> Vec<NegativeExamplePassedCheck>
```

**Purpose**: Runs every program spec's negative example list and collects examples that unexpectedly pass.

**Data flow**: Creates an empty `Vec<NegativeExamplePassedCheck>`, iterates all stored specs via `flat_iter()`, extends the vector with each spec's `verify_should_not_match_list()` output, and returns the combined violations.

**Call relations**: Like the positive-example checker, this supports policy QA and delegates per-spec evaluation to `ProgramSpec`.

*Call graph*: 2 external calls (flat_iter, new).


### Legacy execution verification
This final legacy checker performs post-match validation of filesystem access and executable resolution before execution proceeds.

### `execpolicy-legacy/src/execv_checker.rs`

`domain_logic` · `request handling`

This file wraps a parsed `Policy` in `ExecvChecker` and adds runtime checks that the policy alone cannot decide. `ExecvChecker::r#match` delegates to policy matching and returns a `MatchedExec`; `ExecvChecker::check` then consumes a `ValidExec` and inspects every matched positional argument and option value by iterating over both `valid_exec.args` and `valid_exec.opts` as `(ArgType, String)` pairs. For `ArgType::ReadableFile` and `ArgType::WriteableFile`, it converts the supplied string into an absolute `PathBuf` with `ensure_absolute_path`, using `cwd` for relative paths and returning `CannotCheckRelativePath` if no working directory is available. It then enforces a prefix invariant: the resolved path must start with at least one canonical folder in the corresponding allowlist, otherwise it returns `ReadablePathNotInReadableFolders` or `WriteablePathNotInWriteableFolders` carrying the offending file and the full folder list.

Non-file argument kinds are intentionally ignored here because they were already validated structurally during policy matching. After argument checks pass, the function resolves the executable string to return: it starts with `valid_exec.program`, then scans `valid_exec.system_path` and picks the first entry that exists and is executable according to `is_executable_file` (Unix checks any execute bit via `PermissionsExt`; Windows currently accepts any regular file). Tests exercise missing folder allowlists, folder-vs-file arguments, and parent-directory rejection, and rely on the documented precondition that readable/writeable folder inputs are already canonicalized by the caller.

#### Function details

##### `ExecvChecker::new`  (lines 34–36)

```
fn new(execv_policy: Policy) -> Self
```

**Purpose**: Constructs an `ExecvChecker` by storing the parsed `Policy` that will be used for later matching and validation.

**Data flow**: Takes ownership of a `Policy` as `execv_policy` and returns `Self { execv_policy }`. It does not read external state or perform validation.

**Call relations**: Used by test setup to create the checker instance before exercising matching and path validation behavior.

*Call graph*: called by 1 (setup).


##### `ExecvChecker::r#match`  (lines 38–40)

```
fn r#match(&self, exec_call: &ExecCall) -> Result<MatchedExec>
```

**Purpose**: Runs the policy matcher against an `ExecCall` and returns the policy-level result unchanged.

**Data flow**: Reads `self.execv_policy` and borrows the incoming `ExecCall`; forwards both into `Policy::check` and returns its `Result<MatchedExec>` directly.

**Call relations**: This is the first phase before `ExecvChecker::check`; callers invoke it when they need to classify a raw command line into matched, forbidden, or error outcomes.

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

**Purpose**: Validates a previously matched `ValidExec` against runtime filesystem constraints and resolves the executable path to run.

**Data flow**: Consumes `valid_exec`, reads `cwd`, `readable_folders`, and `writeable_folders`, then iterates through all matched args and opts. File-typed values are converted to absolute `PathBuf`s via `ensure_absolute_path` and checked for prefix membership in the corresponding folder slice; failures return specific `Error` variants. After all values pass, it scans `valid_exec.system_path`, replacing the initial `valid_exec.program` string with the first executable candidate found by `is_executable_file`, and returns that final program string.

**Call relations**: Called after a successful policy match when the caller wants stronger guarantees about file access. Internally it delegates path normalization to `ensure_absolute_path`, executable probing to `is_executable_file`, and uses the `check_file_in_folders!` macro to enforce allowlist membership.

*Call graph*: calls 2 internal fn (ensure_absolute_path, is_executable_file); 1 external calls (check_file_in_folders!).


##### `ensure_absolute_path`  (lines 101–117)

```
fn ensure_absolute_path(path: &str, cwd: &Option<OsString>) -> Result<PathBuf>
```

**Purpose**: Turns a path string into an owned absolute `PathBuf`, using the provided current working directory for relative inputs.

**Data flow**: Builds a `PathBuf` from `path`. If it is relative, it reads `cwd`: with `Some`, it calls `absolutize_from`; with `None`, it returns `CannotCheckRelativePath { file }`. If already absolute, it calls `absolutize`. Successful `Cow<Path>` results are converted into owned `PathBuf`s; failures are mapped into `CannotCanonicalizePath { file, error }` using the original string and the underlying error kind.

**Call relations**: Used only by `ExecvChecker::check` for file-bearing arguments and option values so folder-prefix checks operate on absolute paths.

*Call graph*: called by 1 (check); 1 external calls (from).


##### `is_executable_file`  (lines 119–140)

```
fn is_executable_file(path: &str) -> bool
```

**Purpose**: Checks whether a candidate path on disk should be treated as an executable program.

**Data flow**: Reads filesystem metadata for the supplied string path. On Unix, it returns true only for regular files with any execute bit set (`mode() & 0o111 != 0`); on Windows, it currently returns true for any regular file. Metadata lookup failure or non-file entries produce `false`.

**Call relations**: Called from `ExecvChecker::check` while scanning `ValidExec.system_path` so the checker can prefer a concrete executable path over the bare program name.

*Call graph*: called by 1 (check); 2 external calls (new, metadata).


##### `tests::setup`  (lines 152–165)

```
fn setup(fake_cp: &Path) -> ExecvChecker
```

**Purpose**: Builds a minimal policy containing a single `cp` program spec whose `system_path` points at a temporary executable used by the tests.

**Data flow**: Formats a Starlark policy source string embedding `fake_cp`, parses it with `PolicyParser::new(...).parse().unwrap()`, then wraps the resulting `Policy` in `ExecvChecker::new` and returns it.

**Call relations**: Invoked by the file's test case to centralize creation of a checker configured with a known executable path.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (format!).


##### `tests::test_check_valid_input_files`  (lines 168–294)

```
fn test_check_valid_input_files() -> Result<()>
```

**Purpose**: Exercises the full match-then-check flow for readable/writeable file arguments, including success and several failure modes.

**Data flow**: Creates a temporary directory and fake executable, constructs root/source/dest paths and a `cwd`, then uses `setup` plus `ExecvChecker::r#match` to obtain a `ValidExec`. It repeatedly calls `ExecvChecker::check` with different readable/writeable folder allowlists and asserts exact `Ok` or `Err` values. It also constructs alternate `ExecCall` and `ValidExec` inputs to verify that passing the folder itself is allowed while passing a parent directory is rejected.

**Call relations**: This test drives both public methods and indirectly covers `ensure_absolute_path`, `is_executable_file`, and the folder-prefix macro through realistic command inputs.

*Call graph*: 8 external calls (default, new, assert_eq!, setup, panic!, create, set_permissions, vec!).
