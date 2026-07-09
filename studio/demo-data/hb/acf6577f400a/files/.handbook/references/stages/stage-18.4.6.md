# Shared extension backends and rollout trace models  `stage-18.4.6`

This stage provides shared behind-the-scenes data models rather than main work-loop behavior. It defines the common “forms” that other parts of the system fill in when they record or read rollout traces. A rollout trace is a saved history of what an agent did, useful for debugging, review, or replay.

The session model describes the overall run. It records whether a rollout is still active or finished, which agent threads joined in, and the start and end times of pieces of runtime work. This is like the cover sheet and timeline for a job.

The runtime model describes the events inside that job: code cells, tool calls, terminal commands, checkpoints where context was compacted, and links between trace objects. It gives the trace system a shared vocabulary for the moving parts of execution.

The payload model keeps the trace lightweight. Instead of putting large raw logs or request and response bodies directly into the main records, it stores small references that point to those larger payloads elsewhere in the rollout bundle.

## Files in this stage

### Trace session structure
These models establish the top-level rollout trace lifecycle and then define the runtime execution objects that live within that session and thread structure.

### `rollout-trace/src/model/session.rs`

`data_model` · `cross-cutting trace data representation`

This file is a set of model definitions. In plain terms, it describes the “who, when, and status” of a traced Codex rollout. A rollout can involve one main interactive session plus spawned child agents, and each of those agents has its own thread, identity, display name, origin, lifecycle, and transcript order.

The central idea is that a trace should not only say what messages appeared, but also which running agent they belonged to and whether that agent was still active, completed, failed, or stopped early. `AgentThread` is the record for one such participant. It stores a stable `agent_path` for routing and search, while `nickname` is only a display hint and is not safe as an identity because names can repeat.

`AgentOrigin` explains where a thread came from: either the root session or a spawned child created by another thread. `ExecutionWindow` records a runtime interval, like a stopwatch with a start time, optional end time, and status. It also stores event sequence numbers, which are more reliable than wall-clock time when ordering events that happen very close together.

`CodexTurn` represents one activation of the Codex runtime for a thread. Importantly, it is not the same as a conversation message pair; it is a unit of runtime work that may have been triggered by known conversation items.


### `rollout-trace/src/model/runtime.rs`

`data_model` · `cross-cutting runtime trace recording and inspection`

This file is mostly a set of data definitions. It does not perform actions itself; instead, it describes the pieces of runtime history that other code can fill in, serialize, and inspect later. Think of it like the printed forms used in a control room: one form for a code cell, one for a tool call, one for a terminal command, and so on. Without these shared forms, different parts of the trace system would not agree on what information exists or how to connect it.

The central idea is that a conversation transcript alone is not enough to explain what happened. A model may ask to run JavaScript, that JavaScript may call tools, those tools may start terminal processes, and some work may continue in the background. These structs capture those runtime boundaries and relationships explicitly.

`CodeCell` records one model-authored JavaScript execution and its lifecycle. `ToolCall` records a runtime operation, whether requested directly by the model or indirectly by code. Terminal-related types separate a reusable terminal session from each command or stdin write performed against it. Compaction types record when old conversation history was replaced by a shorter summary. `InteractionEdge` and `TraceAnchor` describe directed links between trace objects, such as one agent spawning or messaging another.

Most types derive serialization support through Serde, a Rust library for turning data into formats like JSON and back. That matters because these records are meant to be stored, transported, and inspected outside the running program.


### Payload references
This module provides the lightweight identifiers used by the reduced trace models to point at external raw payload artifacts.

### `rollout-trace/src/payload.rs`

`data_model` · `trace writing and trace reading`

A rollout trace is meant to show a useful timeline of what happened, but some parts of that history can be very large: full model requests, full model responses, terminal output, tool runtime events, and similar raw records. If all of that were copied directly into the main trace graph, the trace would become slow and heavy to load, especially in a browser.

This file solves that by defining a reference system. Instead of storing the whole payload inline, the trace stores a `RawPayloadRef`: a small record that says, in effect, “the full data is in this bundle file, under this stable ID, and it is this kind of payload.” It is like putting a label and shelf location in a catalog instead of placing the entire book inside the catalog entry.

`RawPayloadId` is just a stable text identifier for one raw payload. `RawPayloadRef` combines that ID with a relative file path and a `RawPayloadKind`. The kind tells the user interface what sort of content it is before opening the file, so it can choose useful labels or syntax highlighting.

The enum `RawPayloadKind` lists the broad categories of raw payloads the trace system knows about, such as inference requests, tool results, terminal events, protocol events, session metadata, and child-agent results. The types can be serialized and deserialized, meaning they can be written to and read from trace bundle files.
