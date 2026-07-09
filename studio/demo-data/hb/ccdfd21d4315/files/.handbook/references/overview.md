## 🗺️ System Overview

#### 1. System Overview Paragraph

Terminus 2 is a program that lets an LLM operate a terminal to complete tasks. You can think of it as an AI using a command-line window the way a person would: it looks at what is on screen, thinks about the next move, types a command, waits, then reads the result. The point is to let an LLM actually carry out multi-step terminal work instead of only describing what someone else should do. A terminal here is a command-line window, and Terminus 2 drives one through tmux, which is a terminal you can control remotely. Most of the system is just that loop repeated until the task appears complete, the run hits a limit, or the terminal dies. Around that core loop, Terminus 2 has a simple harness: set settings, start the terminal, begin a run, repeat the think-and-type loop, finish cleanly, and optionally clean up the screen recording afterward. Later chapters zoom into the loop, summarization, logging, token and cost tracking, output trimming, and the terminal and parsing subsystems.

#### 2. Two Small ASCII Diagrams

```text
Diagram A · Lifecycle

set settings
    ↓
start terminal
    ↓
begin run
    ↓
REPEAT LOOP   ← centerpiece
    ↓
finish run
    ↓
fix recording (optional)
```

```text
Diagram B · One Iteration

1. Read the terminal screen
2. Gather the task and recent history
3. Ask the LLM what to do next
4. Interpret its reply into an action
5. Does the task look complete?
   ├─ yes → confirm stop and end the run
   └─ no  → continue
6. Run the command in the terminal
7. Wait for output from the command
8. Record what happened for the next turn
```

#### 3. Top-Level Stages

- Set settings: turns user options into one ready-to-run configuration before anything starts.
- Start terminal: creates and starts the remote terminal for this run before the main loop.
- Begin run: clears old run state and captures the initial screen right before looping.
- Repeat loop: the core cycle that reads the terminal, asks the LLM, acts, and checks for completion.
- Finish run: always cleans up and saves the final run record after the loop stops.
- Fix recording: optionally post-processes the terminal recording after the run is fully finished.

---
