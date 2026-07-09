## crosscut-X2 · Output Length Limiting

#### (a) Opening Explanation

This stage exists to stop raw terminal text from overwhelming the LLM. A terminal can easily produce huge output: long logs, file dumps, test failures, or commands that hang and keep printing. If all of that is passed through unchanged, the agent wastes context window, pays more, and can bury the few lines that actually matter. Output Length Limiting owns one simple job: cap terminal output before it becomes model input. It is not a standalone phase of the loop. Instead, it sits anywhere terminal text is about to cross the boundary into the LLM, including initial terminal capture, normal observations, warning paths, and timeout messages. Its value is consistency: every path enforces the same size limit and uses the same truncation signal.

#### (b) Main Flow

1. Terminal-producing parts of the system gather text from a tmux session (a terminal you can drive remotely) or from command execution paths.

2. Before that text is shown to the LLM, `_limit_output_length()` (trim terminal text to a safe byte size) is called.

3. The function keeps the output within a fixed byte budget and adds a `[OUTPUT TRUNCATED]` marker if cutting was needed.

4. The result is a smaller, predictable piece of text that still tells the model two important things:
   - here is the most relevant output we can fit
   - more existed, but it was cut

5. This is used in several places on purpose. The system does not want one observation path to be safe while another accidentally sends a giant blob into the prompt.

6. If this helper did not exist, stage-3, stage-4.9, and timeout formatting would each need their own ad hoc limit logic. That would be easy to get wrong and hard to keep consistent.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `无` — this helper does not write any explicit register in the provided skeleton
- reads: `无` — no explicit register is listed for this crosscut helper
- clears: `无` — it does not clear agent state
- triggers downstream: `stage-3 / stage-4.9 / subsys-tmux consumers` — runs whenever terminal output is about to be embedded into LLM-facing text

#### (d) Pipeline Hand-Off

Upstream stages produce raw terminal output, often from command execution or terminal-state capture. This helper turns that raw text into bounded, LLM-safe text, which downstream observation-building and prompt-formatting code can include without risking prompt bloat or inconsistent truncation behavior.

<details id="fn-terminus2_limit_output_length">
<summary><b>Terminus2._limit_output_length</b> — terminus_2.py:531-567 · UTF-8 byte-based middle truncation helper</summary>

> **Stage context**: This function is a small utility in the owning stage's output-length limiting concern. The body itself only transforms the `output` argument under a `max_bytes` threshold and does not show its call sites; it contributes the stage's truncation behavior by returning either the original text or a middle-omitted variant.

**What this code does**

`_limit_output_length` takes a text string `output` and a byte budget `max_bytes`, then returns either the original string or a shortened string with a truncation notice inserted between preserved beginning and ending portions. It measures size with `output.encode("utf-8")`, not with Python character count. It reads no `self._*` state and writes no state. The `max_bytes` value bounds the preserved byte slices taken from the original output, not necessarily the byte length of the final returned string after the notice and newline separators are added.

**Interface · params / IO**

`(self, output: str, max_bytes: int = 10000) -> str`

- params: `output`: `str` — text to return unchanged or truncate; `max_bytes`: `int` — byte budget used for the kept prefix and suffix slices
- returns: A `str`: either the original `output` if `len(output.encode("utf-8")) <= max_bytes`, or a new string made from a decoded leading slice, a notice line, and a decoded trailing slice.

**Execution flow**

1. It encodes `output` to UTF-8 for the size check and returns `output` immediately when `len(output.encode("utf-8")) <= max_bytes`.
2. On the truncation path, it sets `portion_size = max_bytes // 2`, then encodes `output` again into `output_bytes` for byte-accurate slicing.
3. It takes the first `portion_size` bytes and the last `portion_size` bytes from `output_bytes`, then decodes each slice with `errors="ignore"` into `first_portion` and `last_portion`.
4. It computes `omitted_bytes` as `len(output_bytes) - len(first_portion.encode("utf-8")) - len(last_portion.encode("utf-8"))`, so the count reflects the re-encoded decodable bytes actually kept after boundary cuts.
5. It returns a formatted string that concatenates `first_portion`, a newline-delimited notice containing `max_bytes` and `omitted_bytes`, and `last_portion`.

**Source**

```python
    def _limit_output_length(self, output: str, max_bytes: int = 10000) -> str:
        """
        Limit output to specified byte length, keeping first and last portions.

        Args:
            output: The terminal output to potentially truncate
            max_bytes: Maximum allowed bytes (default 10000)

        Returns:
            str: Original output if under limit, or truncated with middle omitted
        """
        if len(output.encode("utf-8")) <= max_bytes:
            return output

        # Calculate portions (half each for first and last)
        portion_size = max_bytes // 2

        # Convert to bytes for accurate splitting
        output_bytes = output.encode("utf-8")

        # Get first portion
        first_portion = output_bytes[:portion_size].decode("utf-8", errors="ignore")

        # Get last portion
        last_portion = output_bytes[-portion_size:].decode("utf-8", errors="ignore")

        # Calculate omitted bytes
        omitted_bytes = (
            len(output_bytes)
            - len(first_portion.encode("utf-8"))
            - len(last_portion.encode("utf-8"))
        )

        return (
            f"{first_portion}\n[... output limited to {max_bytes} bytes; "
            f"{omitted_bytes} interior bytes omitted ...]\n{last_portion}"
        )
```

**Non-obvious design decisions**

- The function uses `output.encode("utf-8")` for both the initial size test and the truncation path, so all limits and slices are based on UTF-8 bytes rather than Python characters. That choice keeps the measurement aligned with the byte-oriented `max_bytes` parameter visible in the code.
- It preserves approximately half the budget from the front and half from the back by setting `portion_size = max_bytes // 2`. This favors showing both the start and end of the original byte stream instead of keeping only a prefix or only a suffix.
- It decodes sliced byte ranges with `errors="ignore"`, which deliberately drops incomplete multibyte characters at slice boundaries instead of raising a decode error. The trade-off is visible in the later `omitted_bytes` calculation: because it subtracts `len(first_portion.encode("utf-8"))` and `len(last_portion.encode("utf-8"))`, ignored boundary bytes count as omitted even though they were inside the raw slices.
- The code does not enforce `max_bytes` on the final returned string. `max_bytes` limits only the preserved original byte portions; the inserted notice text and newline separators can make the returned string longer than `max_bytes`.

**Relations**

- **Callers**: unknown from this function body; external code calls this helper; owning stage utility path for output-length limiting; methods that need a shortened `str` before passing text onward; any `Terminus2` method that supplies `output` and optional `max_bytes`
- **Core callees**: `str.encode` with `"utf-8"`; byte-slice operations on `output_bytes`; `bytes.decode` with `errors="ignore"`; formatted string construction for the truncation notice
- **Config / state sources**: argument `output`; argument `max_bytes`; local `portion_size = max_bytes // 2`; derived local `output_bytes = output.encode("utf-8")`
- **Results to**: the caller as the function's return value; either the unchanged `output` branch result; or the synthesized truncated string with notice; downstream consumers chosen by the caller, not shown here

</details>
