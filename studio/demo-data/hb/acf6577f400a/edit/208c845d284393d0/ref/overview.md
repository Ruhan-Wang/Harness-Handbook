# System Handbook

## 🗺️ System Overview

This system is one program that can wear several hats. You might use it as a full-screen text app, a one-shot command-line tool, or a background server that other tools talk to. A good mental picture is a workshop with one shared engine in the middle and several different front doors.

When the program starts, it first checks how it was launched and chooses the right mode. Then it does early safety setup: tightening a few security rules, picking the crypto code used for secure network traffic, and preparing the async runtime that lets it juggle many tasks at once. Next it figures out its surroundings: where its home folder is, how it was installed, what shell and machine it is running on, and which helper tools are available.

With that context, it builds its startup playbook. It merges settings from files, the project, the user, the cloud, and the command line. It decides which features are enabled, what files or network access are allowed, and which built-in tools, plugins, and model providers exist. It also checks who the user is, loads or refreshes sign-in details, opens its local databases, and fetches fresh catalogs from remote services, such as available AI models and plugins.

Then it opens communication channels and starts a session. In interactive mode, it brings up the text interface and restores or creates a conversation thread. In exec mode, it builds a one-off job and runs it.

From there, the system lives in a loop. It listens for user input, server messages, and background updates. For each turn, it gathers the right context, sends work to the model, streams back results, and, if needed, runs real actions like commands, file edits, web calls, or helper tools under approval and sandbox rules. It can even spin up helper agent threads for side work.

Finally, it saves what happened, updates the visible state, and shuts down cleanly when asked. Behind all of this are shared foundations: common message formats, networking code, storage layers, logging and diagnostics, utility libraries, and a large test harness that keeps the whole machine trustworthy.

---

## See also

- [State-flow registers](register.md) — global state that flows across stages
- [Stage Index](index.md) — every stage and what it does
