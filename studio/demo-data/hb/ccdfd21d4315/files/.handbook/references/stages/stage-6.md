## 6 · Recording Post-process (External)

#### (a) Opening Explanation

This stage exists to turn a raw terminal recording into a finished recording with the agent’s markers embedded at the right times. During the run, Terminus 2 can note important moments as marker data, but it does not rewrite the asciinema cast file live. That would make recording more fragile and would mix “capture the session” with “edit the finished file.” So this work is deferred to session stop. Concretely, this is the recording-finalization substep inside terminal/session shutdown, not part of the agent’s main `run()` loop. Its job is narrow: take the completed `.cast` file, merge in the saved markers, and leave behind a final recording artifact that external tools can read.

#### (b) Main Flow

1. `TmuxSession.stop()` (shuts down the remotely driven terminal session) is the point where this stage begins. That matters because the recording file is now complete enough to safely finalize.

2. There is an early branch: if no marker data was collected, there is nothing to merge. In that case, stop/finalize leaves the cast file unchanged and returns.

3. If markers do exist, `AsciinemaHandler.merge_markers()` (finalizes the recording by inserting marker events) reads the existing cast file and the saved marker list.

4. The merge keeps the cast header, then walks the recording frame by frame. `AsciinemaHandler._process_recording_line()` (handles one recording line at a time) inserts any marker whose timestamp should appear before that frame. This is the core responsibility of the stage: place markers in time order without disturbing the original terminal output.

5. If some markers fall after the last frame, `AsciinemaHandler._write_remaining_markers()` appends them at the end so they are not lost.

6. The result is a rewritten, finalized `.cast` artifact. The point of the stage is not to change agent behavior. It is to make the recording understandable after the fact.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: none — this stage does not write any Terminus 2 register; it updates the recording artifact instead
- reads: `reg-asciinema-markers` — reads the accumulated `(timestamp, label)` marker tuples to decide whether a merge is needed and, if so, where marker events should be inserted
- clears: none proven — no register clear is evidenced here
- triggers downstream: `side-S1 Context Summarization` — sequencing only; once terminal/session stop finishes, the broader pipeline may continue, but this stage does not hand off a new register

Additional artifact flow for this stage:
- reads: existing `.cast` recording artifact — the already-recorded asciinema file is read as the base material for finalization
- writes: finalized `.cast` recording artifact — if markers exist, the cast is rewritten with embedded marker events; if no markers exist, the cast is left unchanged

#### (d) Pipeline Hand-Off

Upstream leaves behind two things: a finished raw `.cast` recording and, if any were collected, marker entries in `reg-asciinema-markers`. This stage turns those into a finalized recording artifact; downstream sequencing happens after finalization, but no new Terminus 2 register is produced here.

<details id="fn-tmuxsession_stop">
<summary><b>TmuxSession.stop</b> — tmux_session.py:496-508 · Stop-time asciinema marker merge gate</summary>

> **Stage context**: This region performs the stage-6 handoff from in-memory marker collection to cast-file post-processing. The Harbor framework reaches it through `TmuxSession.stop()` after the agent run has already finished, so it runs outside the main `run()` path. In this stage, its job is narrow: decide whether merge work is possible from `_markers` and `_local_asciinema_recording_path`, then delegate the actual file rewrite to `AsciinemaHandler.merge_markers()`.

**What this code does**

This region checks whether `self._markers` contains any recorded markers and whether `self._local_asciinema_recording_path` points to a local cast file. When both are present, it logs the merge, builds an `AsciinemaHandler` from those two inputs, and asks that handler to fold the markers into the recording. Otherwise it only emits a debug message and leaves the recording unchanged.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `TmuxSession` — session object that holds collected markers, recording path, and logger
- reads: `self._markers`, `self._local_asciinema_recording_path`, `self._logger`
- returns: None; the real product is a possible on-disk update to the local asciinema recording file and debug log output.
- effects: writes debug messages through `self._logger.debug(...)`; instantiates `AsciinemaHandler(self._markers, self._local_asciinema_recording_path)`; may rewrite the cast file at `self._local_asciinema_recording_path` via `handler.merge_markers()`

**Execution flow**

1. Check the merge preconditions by reading `self._markers` and `self._local_asciinema_recording_path` in the same branch guard.
2. If both values are truthy, log how many markers will be merged with `len(self._markers)`.
3. Create `AsciinemaHandler` with the current marker list and the local recording path, then call `merge_markers()` to perform the post-process rewrite.
4. After a successful call, log that the merge completed for `self._local_asciinema_recording_path`.
5. If either precondition fails, skip handler creation entirely and log `"No markers to merge"`.

**Source**

```python
            if self._markers and self._local_asciinema_recording_path:
                self._logger.debug(
                    f"Merging {len(self._markers)} markers into recording"
                )
                handler = AsciinemaHandler(
                    self._markers, self._local_asciinema_recording_path
                )
                handler.merge_markers()
                self._logger.debug(
                    f"Successfully merged markers into {self._local_asciinema_recording_path}"
                )
            else:
                self._logger.debug("No markers to merge")
```

**Non-obvious design decisions**

- It gates on both `_markers` and `_local_asciinema_recording_path` before constructing `AsciinemaHandler`. That avoids invoking file post-processing when the session never recorded markers or never obtained a local cast path; a looser check would push missing-input handling into the handler.
- It delegates all merge mechanics to `AsciinemaHandler.merge_markers()` instead of touching the cast file here. That keeps `TmuxSession.stop()` focused on stop-time orchestration, while the specialized handler owns the recording-format logic described for stage-6.
- It treats the no-work case as a debug-only branch (`"No markers to merge"`) rather than as an error. The branch condition shows that missing markers or path are acceptable outcomes at shutdown, not exceptional failures.

**Relations**

- **Callers**: `TmuxSession.stop` surrounding shutdown flow; Harbor framework post-run session teardown; stage-6 external post-process entrypoint after agent return
- **Core callees**: `AsciinemaHandler`; `AsciinemaHandler.merge_markers`; `self._logger.debug`
- **Config / state sources**: `self._markers`; `self._local_asciinema_recording_path`; `self._logger`
- **Results to**: local cast file at `self._local_asciinema_recording_path`; debug logging output; stage-6 recording artifact with markers merged
- **📊 Register interactions**: 👁 reads `reg-asciinema-markers` — consumes accumulated markers during stop-time merge

</details>


<details id="fn-asciinemahandler_init">
<summary><b>AsciinemaHandler.__init__</b> — asciinema_handler.py:11-20 · Constructor storing ordered markers and recording path</summary>

> **Stage context**: This entry covers only `AsciinemaHandler.__init__` itself. Within the owning stage, it prepares an `AsciinemaHandler` instance by putting constructor inputs onto instance state in normalized form.

**What this code does**

`AsciinemaHandler.__init__` takes `markers` and `recording_path` and stores them on the instance. It writes `self._markers` as either a new list sorted by each tuple's timestamp element (`x[0]`) or `[]` when `markers` is falsy. It also writes `self._recording_path` with the provided `Path`. The constructor returns no value; its product is initialized instance state.

**Interface · params / IO**

`(self, markers: list[tuple[float, str]], recording_path: Path)`

- params: `markers`: `list[tuple[float, str]]` — marker pairs to store on the instance; `recording_path`: `Path` — recording file path to store on the instance
- returns: None; it initializes `self._markers` and `self._recording_path`.
- effects: writes `self._markers`; writes `self._recording_path`

**Execution flow**

1. It evaluates `markers` for truthiness. If `markers` is truthy, it builds a new list with `sorted(markers, key=lambda x: x[0])` and assigns that list to `self._markers`.
2. If `markers` is falsy, it assigns an empty list `[]` to `self._markers` instead.
3. It assigns the incoming `recording_path` directly to `self._recording_path`.

**Source**

```python
    def __init__(self, markers: list[tuple[float, str]], recording_path: Path):
        """
        Initialize the AsciinemaHandler.

        Args:
            markers: List of tuples containing (timestamp, label) for each marker
            recording_path: Path to the asciinema recording file
        """
        self._markers = sorted(markers, key=lambda x: x[0]) if markers else []
        self._recording_path = recording_path
```

**Non-obvious design decisions**

- The constructor sorts `markers` eagerly with `sorted(..., key=lambda x: x[0])` instead of storing the input list as-is. That choice makes `self._markers` ordered by the first tuple element at construction time, and because `sorted()` returns a new list, it does not reuse the caller's original list object.
- The `if markers else []` expression collapses any falsy `markers` input to a concrete empty list. That gives the instance a list in both branches rather than preserving the original falsy value.

**Relations**

- **Callers**: code that instantiates `AsciinemaHandler`
- **Core callees**: `sorted`
- **Config / state sources**: constructor argument `markers`; constructor argument `recording_path`
- **Results to**: `self._markers`; `self._recording_path`; the initialized `AsciinemaHandler` instance

</details>


<details id="fn-asciinemahandler_merge_markers">
<summary><b>AsciinemaHandler.merge_markers</b> — asciinema_handler.py:22-39 · Guarded cast-file marker merge entrypoint</summary>

> **Stage context**: This method is the public entrypoint on `AsciinemaHandler` for applying queued marker data to a cast file. Within this class, it sits above `_write_merged_recording`, which does the actual merged-file generation, and it limits itself to the guard, temporary-path setup, and final replacement step.

**What this code does**

`merge_markers` checks two prerequisites from instance state: `self._markers` must be truthy and `self._recording_path` must already exist. If either check fails, it returns `None` immediately and leaves the filesystem unchanged. Otherwise it asks `_write_merged_recording` to write a merged copy to a temporary path derived from `self._recording_path`, then replaces the original recording with that temporary file.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `?` — handler instance with `_markers`, `_recording_path`, and `_write_merged_recording`
- reads: `self._markers`, `self._recording_path`
- returns: Returns `None`; may make no filesystem changes when `self._markers` is falsy or `self._recording_path` does not exist.
- effects: writes a merged recording to a temporary path via `self._write_merged_recording(temp_path)`; replaces `self._recording_path` on disk with `temp_path.replace(self._recording_path)`

**Execution flow**

1. Evaluate the single guard `if not self._markers or not self._recording_path.exists(): return` and stop immediately when there are no markers or no existing recording file.
2. Build `temp_path` from `self._recording_path.with_suffix(".tmp")`.
3. Delegate merged-file creation to `self._write_merged_recording(temp_path)`.
4. Promote the temporary file to the target path with `temp_path.replace(self._recording_path)`.

**Source**

```python
    def merge_markers(self) -> None:
        """
        Merge asciinema markers into a recording.

        Inserts marker events into an asciinema recording file at specified timestamps.
        Markers are added as special events with type 'm' in the recording format.
        The original recording is preserved until the merge is successful.

        In the future Asciinema might support adding markers via RCP:
        https://discourse.asciinema.org/t/add-markers-with-title-from-cli/861
        """
        if not self._markers or not self._recording_path.exists():
            return

        # Create a temporary file in the same directory as the recording
        temp_path = self._recording_path.with_suffix(".tmp")
        self._write_merged_recording(temp_path)
        temp_path.replace(self._recording_path)
```

**Non-obvious design decisions**

- It uses an early-return guard on both `self._markers` and `self._recording_path.exists()` to skip all file work when a merge cannot or should not happen.
- It writes to `temp_path` first and only then calls `replace(...)`, which keeps the original recording in place until the merged output has been produced.

**Relations**

- **Callers**: external caller of `AsciinemaHandler.merge_markers`
- **Core callees**: `self._recording_path.exists`; `self._recording_path.with_suffix`; `self._write_merged_recording`; `temp_path.replace`
- **Config / state sources**: `self._markers`; `self._recording_path`
- **Results to**: merged cast file at `self._recording_path`; filesystem state at the recording path
- **Related siblings**: `AsciinemaHandler.__init__` initializes `self._markers` and `self._recording_path` used here

</details>


<details id="fn-asciinemahandler_write_merged_recording">
<summary><b>AsciinemaHandler._write_merged_recording</b> — asciinema_handler.py:41-60 · Write merged cast file with inserted markers</summary>

> **Stage context**: This helper performs the file-writing part of stage-6's recording post-process. It sits under `AsciinemaHandler.merge_markers`, which decides whether to run the merge and later swaps the temporary output into place; this method only reads the source recording and writes the merged copy.

**What this code does**

`_write_merged_recording` rewrites the recording at `self._recording_path` into `output_path` while delegating marker insertion to helper methods. It copies the first input line unchanged, then feeds each remaining line plus the current `marker_index` into `_process_recording_line`, and finally asks `_write_remaining_markers` to emit any unconsumed tail from `self._markers[marker_index:]`. It returns `None`; its product is the newly written output file.

**Interface · params / IO**

`(self, output_path: Path) -> None`

- params: `output_path`: `Path` — destination path for the rewritten recording file
- reads: `self._recording_path`, `self._markers`
- returns: Returns `None`; the observable result is content written to `output_path`.
- effects: opens `self._recording_path` for reading; creates or overwrites `output_path` and writes merged recording content to it

**Execution flow**

1. It initializes a local `marker_index = 0` to track how much of the marker list downstream helpers have consumed.
2. It opens `self._recording_path` as `input_file` and `output_path` as `output_file` inside one `with` block.
3. It reads the first line from `input_file` with `input_file.readline()` and writes that line directly to `output_file`.
4. For each remaining `line` in `input_file`, it calls `self._process_recording_line(line, output_file, marker_index)` and replaces `marker_index` with that call's return value.
5. After the loop, it slices `self._markers[marker_index:]` and passes that remainder to `self._write_remaining_markers(output_file, ...)`.

**Source**

```python
    def _write_merged_recording(self, output_path: Path) -> None:
        """
        Write a new recording file with markers merged in at the correct timestamps.
        """
        marker_index = 0

        with (
            open(self._recording_path) as input_file,
            open(output_path, "w") as output_file,
        ):
            # Preserve header
            output_file.write(input_file.readline())

            for line in input_file:
                marker_index = self._process_recording_line(
                    line, output_file, marker_index
                )

            # Add any remaining markers at the end
            self._write_remaining_markers(output_file, self._markers[marker_index:])
```

**Non-obvious design decisions**

- It copies the first line separately with `input_file.readline()` before the main loop. That visible split preserves one line verbatim without sending it through `_process_recording_line`.
- It tracks progress with a local `marker_index` returned from `_process_recording_line` instead of mutating `self._markers`. That keeps instance state read-only in this method and makes the final remainder explicit as `self._markers[marker_index:]`.
- It delegates line-level merging and tail emission to `_process_recording_line` and `_write_remaining_markers` rather than embedding both policies here. This keeps `_write_merged_recording` focused on file streaming and output assembly.

**Relations**

- **Callers**: AsciinemaHandler.merge_markers
- **Core callees**: self._process_recording_line; self._write_remaining_markers; open
- **Config / state sources**: self._recording_path; self._markers
- **Results to**: writes merged recording data to `output_path`; produces the temporary file later used by `AsciinemaHandler.merge_markers`
- **Related siblings**: AsciinemaHandler.merge_markers decides whether to call this helper and later replaces the original file with the output it writes.; AsciinemaHandler.__init__ stores the `markers` and `recording_path` values that this method reads.
- **📊 Register interactions**: 👁 reads `reg-asciinema-markers` — reads marker list for per-line and trailing writes

</details>


<details id="fn-asciinemahandler_process_recording_line">
<summary><b>AsciinemaHandler._process_recording_line</b> — asciinema_handler.py:62-90 · Per-line cast merger with marker insertion</summary>

> **Stage context**: This helper does the line-by-line work inside stage-6's cast rewrite. `AsciinemaHandler._write_merged_recording` calls it for each recording line after the header, and `merge_markers` later swaps the merged temp file into place. It complements `_write_remaining_markers`, which handles any markers left after all input lines are consumed.

**What this code does**

`AsciinemaHandler._process_recording_line` examines one cast-file line, tries to read an event timestamp from JSON array lines, and inserts any queued markers from `self._markers` whose timestamps are less than or equal to that event time. It always writes the original `line` to `output_file`, even when parsing fails or the line does not look like an event record. The function returns the next `marker_index` to continue the merge pass; it does not modify instance attributes.

**Interface · params / IO**

`(self, line: str, output_file: TextIO, marker_index: int) -> int`

- params: `line`: `str` — One input line from the asciinema recording being merged; `output_file`: `TextIO` — Destination stream for marker events and the preserved recording line; `marker_index`: `int` — Current position in `self._markers` for the next marker to consider
- reads: `self._markers`
- returns: An updated `marker_index` after consuming any markers written before this line's timestamp
- effects: Writes zero or more marker lines to `output_file` via `self._write_marker`; Writes the original `line` to `output_file`

**Execution flow**

1. If `line` does not start with `"["`, treat it as a non-event line, write it unchanged to `output_file`, and return the incoming `marker_index`.
2. Otherwise, try to parse `line` with `json.loads(line)` and read the event time as `float(data[0])`.
3. While `marker_index` still points inside `self._markers` and that marker's timestamp `self._markers[marker_index][0]` is less than or equal to the parsed `timestamp`, call `_write_marker(output_file, self._markers[marker_index])` and advance `marker_index`.
4. If JSON parsing or timestamp extraction raises `json.JSONDecodeError`, `ValueError`, or `IndexError`, suppress the error and keep the line unchanged.
5. Write the original `line` to `output_file` and return the final `marker_index`.

**Source**

```python
    def _process_recording_line(
        self,
        line: str,
        output_file: TextIO,
        marker_index: int,
    ) -> int:
        """Process a single line from the recording, inserting markers as needed."""
        if not line.startswith("["):
            output_file.write(line)
            return marker_index

        try:
            data = json.loads(line)
            timestamp = float(data[0])

            # Insert any markers that should appear before this timestamp
            while (
                marker_index < len(self._markers)
                and self._markers[marker_index][0] <= timestamp
            ):
                self._write_marker(output_file, self._markers[marker_index])
                marker_index += 1

        except (json.JSONDecodeError, ValueError, IndexError):
            # If we can't parse the line, preserve it as-is
            pass

        output_file.write(line)
        return marker_index
```

**Non-obvious design decisions**

- It gates JSON parsing behind `line.startswith("[")`. That cheap shape check avoids trying to decode obvious non-event lines, while still preserving them verbatim.
- The `except (json.JSONDecodeError, ValueError, IndexError): pass` branch chooses lossless preservation over strict validation. If a cast line is malformed or not an array with a numeric first element, the merge keeps the original content instead of failing the whole post-process.
- The marker loop uses `<= timestamp` against `self._markers[marker_index][0]`. That places markers at the first frame whose time is at or after the marker time, which matches the stage's merge policy described in `merge_markers` and `_write_merged_recording`.

**Relations**

- **Callers**: AsciinemaHandler._write_merged_recording
- **Core callees**: json.loads; float; AsciinemaHandler._write_marker; output_file.write
- **Config / state sources**: self._markers from AsciinemaHandler.__init__; `marker_index` threaded through AsciinemaHandler._write_merged_recording; input `line` read from the cast file by AsciinemaHandler._write_merged_recording
- **Results to**: Updated `marker_index` back to AsciinemaHandler._write_merged_recording; Merged output stream later finalized by AsciinemaHandler._write_merged_recording; Remaining marker handling in AsciinemaHandler._write_remaining_markers after line processing completes
- **Related siblings**: AsciinemaHandler._write_merged_recording drives this helper across the file; AsciinemaHandler.merge_markers decides whether the merge runs at all; AsciinemaHandler.__init__ pre-sorts `self._markers`, which this function consumes in order; TmuxSession.stop triggers the stage by constructing AsciinemaHandler and calling `merge_markers`
- **📊 Register interactions**: 👁 reads `reg-asciinema-markers` — consumes sorted marker tuples during merge

</details>


<details id="fn-asciinemahandler_write_remaining_markers">
<summary><b>AsciinemaHandler._write_remaining_markers</b> — asciinema_handler.py:98-103 · Write trailing markers through delegated marker serializer</summary>

> **Stage context**: This helper is a minimal writer in the stage-6 cast post-processing code. Among the translated siblings, `AsciinemaHandler._write_merged_recording` invokes it after processing the main recording stream, and this function only handles the marker list it is given by delegating each item to `AsciinemaHandler._write_marker`.

**What this code does**

`AsciinemaHandler._write_remaining_markers` walks the supplied `markers` list in its existing order and writes each marker to `output_file` by calling `self._write_marker(output_file, marker)`. It takes no direct input from instance attributes and returns `None`. Its observable effect is whatever output `self._write_marker` produces on `output_file` for each tuple.

**Interface · params / IO**

`(self, output_file: TextIO, markers: list[tuple[float, str]]) -> None`

- params: `self`: `AsciinemaHandler` — method receiver used only to reach `self._write_marker`; `output_file`: `TextIO` — text stream passed through to `_write_marker` for each marker; `markers`: `list[tuple[float, str]]` — caller-supplied marker tuples to emit in list order
- returns: Returns `None`; the real product is delegated marker writes to `output_file`.
- effects: Calls `self._write_marker(output_file, marker)` once per item in `markers`; May write to the external `output_file` stream via `_write_marker`; Does not catch exceptions raised by `_write_marker`

**Execution flow**

1. Iterate over `markers` with `for marker in markers`, preserving the caller-provided sequence.
2. For each `marker`, call `self._write_marker(output_file, marker)` and do no other transformation, filtering, or accumulation.

**Source**

```python
    def _write_remaining_markers(
        self, output_file: TextIO, markers: list[tuple[float, str]]
    ) -> None:
        """Write any remaining markers that come after all recorded events."""
        for marker in markers:
            self._write_marker(output_file, marker)
```

**Non-obvious design decisions**

- The helper delegates all per-marker formatting and output to `self._write_marker` instead of duplicating that logic here. This keeps this function to ordered iteration only; any exception from `_write_marker` therefore propagates unchanged.

**Relations**

- **Callers**: `AsciinemaHandler._write_merged_recording`
- **Core callees**: `AsciinemaHandler._write_marker`
- **Config / state sources**: `markers` parameter; `output_file` parameter
- **Results to**: `output_file` text stream; caller-visible completion or propagated exception from `_write_marker`
- **Related siblings**: `AsciinemaHandler._write_merged_recording` supplies the `markers` slice this helper emits; `AsciinemaHandler._process_recording_line` handles marker insertion during line-by-line processing; this helper only emits the leftover list

</details>


<details id="fn-asciinemahandler_write_marker">
<summary><b>AsciinemaHandler._write_marker</b> — asciinema_handler.py:92-96 · Emit one asciinema marker event line</summary>

> **Stage context**: This helper handles the smallest write unit in stage-6: one marker record in asciinema cast format. `AsciinemaHandler._process_recording_line` and `AsciinemaHandler._write_remaining_markers` call it while `AsciinemaHandler._write_merged_recording` rewrites the final `.cast` file. It runs only during the external post-processing merge triggered after the agent finishes.

**What this code does**

`AsciinemaHandler._write_marker` takes an `output_file` stream and one `marker` tuple of `(timestamp, label)`, converts that tuple into the asciinema marker event shape, and writes it as one JSON line. It returns `None`. Its only observable effect is appending a newline-terminated record to `output_file`.

**Interface · params / IO**

`(self, output_file: TextIO, marker: tuple[float, str]) -> None`

- params: `self`: `AsciinemaHandler` — handler instance; not consulted by this method; `output_file`: `TextIO` — destination stream that receives the marker event line; `marker`: `tuple[float, str]` — marker payload as `(timestamp, label)` supplied by merge helpers
- returns: None; the real product is one marker JSON record written to `output_file`
- effects: writes a newline-terminated JSON string to `output_file`

**Execution flow**

1. Unpack `marker` into `marker_time` and `marker_label`.
2. Build `marker_data` as `[marker_time, "m", marker_label]`, using the literal event-type code `"m"`.
3. Serialize `marker_data` with `json.dumps(...)`, append `"\n"`, and write the resulting line to `output_file`.

**Source**

```python
    def _write_marker(self, output_file: TextIO, marker: tuple[float, str]) -> None:
        """Write a single marker event to the output file."""
        marker_time, marker_label = marker
        marker_data = [marker_time, "m", marker_label]
        output_file.write(json.dumps(marker_data) + "\n")
```

**Non-obvious design decisions**

- The function emits the exact three-element array `[time, "m", label]` instead of passing through the input tuple. That hard-codes the asciinema marker protocol in one place, so sibling helpers can work with simple `(timestamp, label)` tuples and avoid repeating format knowledge.
- It writes one complete JSON line with a trailing newline in a single `output_file.write(...)` call. That matches the line-oriented cast-file format used by `_write_merged_recording` and avoids forcing callers to manage record termination separately.

**Relations**

- **Callers**: AsciinemaHandler._process_recording_line; AsciinemaHandler._write_remaining_markers
- **Core callees**: json.dumps; output_file.write
- **Config / state sources**: `marker[0]` supplies the event timestamp; `marker[1]` supplies the marker label; the literal `"m"` selects the asciinema marker event type
- **Results to**: `output_file`, which is the merged cast being produced by `AsciinemaHandler._write_merged_recording`; the final recording file later installed by `AsciinemaHandler.merge_markers`
- **Related siblings**: AsciinemaHandler._write_remaining_markers loops over marker tuples and delegates each one here.; AsciinemaHandler._process_recording_line uses this helper when a queued marker timestamp is due before the current recording event.; AsciinemaHandler._write_merged_recording provides the output stream that receives these emitted marker lines.

</details>
