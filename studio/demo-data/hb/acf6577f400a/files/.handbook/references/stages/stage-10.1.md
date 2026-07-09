# Interactive event dispatch  `stage-10.1`

Interactive event dispatch is the terminal app’s live traffic system during normal use. It takes raw activity from the keyboard, paste buffer, terminal window, server, and background tasks, then sends each event to the right place.

At the outer edge, event_stream turns low-level terminal signals into app-friendly events like key press, paste, resize, focus change, or redraw request. It also fully releases the terminal input reader when the TUI is paused, so another program can safely read from standard input.

App-level dispatch is the main switchboard. It receives these events, routes them to the correct chat thread, tracks pending server questions, and asks for screen redraws without wasting work. The bottom-pane stage handles the message composer, slash commands, popups, prompts, history search, and “@” mention search. The chat widget stage applies events to the visible conversation: sending messages, queuing drafts, showing streaming replies, running commands, and managing interrupts. Specialized handlers cover side flows such as task lists, thread navigation, backtracking, pagers, keymap editing, theme picking, pets, clipboard actions, and imports.

## Sub-stages

- [App-level event dispatch and thread routing](stage-10.1.1.md) `stage-10.1.1` — 10 files
- [Bottom-pane composer, popups, and mention input](stage-10.1.2.md) `stage-10.1.2` — 42 files
- [Chat widget interaction and command flows](stage-10.1.3.md) `stage-10.1.3` — 23 files
- [Specialized interactive flows and auxiliary TUI handlers](stage-10.1.4.md) `stage-10.1.4` — 20 files

## Files in this stage

### Interactive event dispatch
### `tui/src/tui/event_stream.rs`

`io_transport` · `main loop, especially terminal event polling and pause/resume`

A terminal UI needs two kinds of signals: input from the terminal, and internal “please redraw” nudges from the app. This file combines both into one stream of `TuiEvent` values that the rest of the TUI can read like a single queue.

The important extra job here is safe pausing. The underlying terminal library, crossterm, uses an event stream that may keep reading from standard input even when the app is not actively asking for events. If the TUI temporarily gives control to another program, such as an editor, that hidden reader could steal the other program’s keystrokes or terminal replies. So this file puts crossterm behind an `EventBroker`, which can drop the real input stream on pause and recreate it on resume. Think of it like unplugging a shared microphone before handing the stage to someone else, rather than merely promising not to listen.

`TuiEventStream` then polls two sources: the shared terminal input broker and a broadcast channel for draw requests. It alternates which source it checks first, so one side does not starve the other. Raw crossterm events are translated into the app’s simpler event types, while unused events, such as mouse input, are ignored. Focus changes update shared focus state, resize becomes a resize event, paste keeps its pasted text, and on Unix the suspend key pauses input before suspending the process.

#### Function details

##### `EventBrokerState::active_event_source_mut`  (lines 65–77)

```
fn active_event_source_mut(&mut self) -> Option<&mut S>
```

**Purpose**: This function returns the live terminal event source, creating it if the broker is ready to run but has not started yet. If the broker is paused, it deliberately returns nothing so stdin stays released.

**Data flow**: It reads the broker’s current state. `Paused` stays as no source; `Start` is changed into a newly created running source; `Running` returns the existing source. The output is either a mutable reference to the active source or `None` when input is paused.

**Call relations**: The broker’s polling path and the test event sender both rely on this as the gatekeeper for input. When `TuiEventStream::poll_crossterm_event` asks for events, this function decides whether polling is allowed, whether a new source must be made, or whether the stream should wait for resume.

*Call graph*: 3 external calls (default, Running, unreachable!).


##### `EventBroker::new`  (lines 81–87)

```
fn new() -> Self
```

**Purpose**: This creates a new shared input broker in a ready-to-start state. It also prepares a small notification channel used to wake streams when input is resumed.

**Data flow**: It takes no caller data. It creates an initial state of `Start` and a watch channel for resume notifications, then returns an `EventBroker` containing both.

**Call relations**: Normal application setup uses this when building the event stream, and tests use it in `setup`. Later, `TuiEventStream::new` subscribes to the broker’s resume notifications so a paused stream can wake up.

*Call graph*: called by 2 (new, setup); 2 external calls (new, channel).


##### `EventBroker::pause_events`  (lines 90–96)

```
fn pause_events(&self)
```

**Purpose**: This pauses terminal input by dropping the underlying event source. That matters because simply not polling crossterm is not always enough to stop it reading from stdin.

**Data flow**: It locks the broker state, replacing whatever was there with `Paused`. After this, polling code will not touch terminal input until resume happens.

**Call relations**: The TUI calls this when it needs to hand the terminal to something else. `TuiEventStream::map_crossterm_event` also uses it around Unix process suspension so crossterm cannot steal input while the process is suspended.


##### `EventBroker::resume_events`  (lines 99–106)

```
fn resume_events(&self)
```

**Purpose**: This marks terminal input as ready to start again and wakes any stream that was waiting while paused. It does not immediately read input; it prepares the next poll to recreate the source.

**Data flow**: It locks the broker state and changes it to `Start`. Then it sends a notification on the resume watch channel. The result is a broker that will create a fresh event source the next time it is polled.

**Call relations**: After a pause, callers use this to reopen the path to terminal input. `TuiEventStream::poll_crossterm_event` listens for this notification so it can stop waiting and continue polling.

*Call graph*: 1 external calls (send).


##### `EventBroker::resume_events_rx`  (lines 112–114)

```
fn resume_events_rx(&self) -> watch::Receiver<()>
```

**Purpose**: This gives a stream its own listener for resume notifications. Each `TuiEventStream` needs this so it can be woken if it was waiting during a pause.

**Data flow**: It reads the broker’s watch sender and creates a new receiver subscribed to the same resume signal. The returned receiver gets notified whenever `resume_events` is called.

**Call relations**: `TuiEventStream::new` calls this during construction. Later, `poll_crossterm_event` polls the resulting receiver when the input source is paused or pending.

*Call graph*: 1 external calls (subscribe).


##### `CrosstermEventSource::default`  (lines 121–123)

```
fn default() -> Self
```

**Purpose**: This creates the real terminal event source backed by crossterm. It is the production version of the generic event source interface.

**Data flow**: It takes no inputs, asks crossterm to create a new `EventStream`, wraps it in `CrosstermEventSource`, and returns it.

**Call relations**: The broker state uses this when moving from `Start` to `Running`. That is how terminal input is recreated after startup or resume.

*Call graph*: 1 external calls (new).


##### `CrosstermEventSource::poll_next`  (lines 127–129)

```
fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<EventResult>>
```

**Purpose**: This asks crossterm for the next raw terminal event. It adapts crossterm’s stream to the project’s `EventSource` trait.

**Data flow**: It receives a pinned mutable event source and an async task context. It forwards the poll to the inner crossterm stream and returns pending, an event, an error, or end-of-stream.

**Call relations**: `TuiEventStream::poll_crossterm_event` reaches this through the shared broker. The result is then translated into a `TuiEvent` or used to restart/end the stream.

*Call graph*: 1 external calls (new).


##### `TuiEventStream::new`  (lines 152–171)

```
fn new(
        broker: Arc<EventBroker<S>>,
        draw_rx: broadcast::Receiver<()>,
        terminal_focused: Arc<AtomicBool>,
        #[cfg(unix)] suspend_context: crate::tui::job_control::Suspend
```

**Purpose**: This builds one combined TUI event stream from a shared terminal input broker and a draw-request receiver. It prepares the stream to listen for redraws, terminal input, and resume wakeups.

**Data flow**: It receives the shared broker, a draw broadcast receiver, shared focus state, and on Unix the suspend-related state. It wraps the draw receiver, subscribes to resume notifications, stores the shared flags, and returns a ready `TuiEventStream`.

**Call relations**: Application code creates event streams through this, and the tests use `make_stream` to call it with fake input. Its fields are later used by `poll_next`, `poll_draw_event`, and `poll_crossterm_event`.

*Call graph*: called by 2 (event_stream, make_stream); 2 external calls (new, from_changes).


##### `TuiEventStream::poll_crossterm_event`  (lines 178–222)

```
fn poll_crossterm_event(&mut self, cx: &mut Context<'_>) -> Poll<Option<TuiEvent>>
```

**Purpose**: This checks the shared terminal input source for the next useful app event. It skips raw terminal events the app does not care about and waits safely when input is paused.

**Data flow**: It locks the broker state, gets or creates the active event source, and polls it. Raw terminal events are passed to `map_crossterm_event`; ignored events make it keep looking. If the broker is paused or stdin is pending, it also polls the resume listener so a later resume can wake this task. It outputs a `TuiEvent`, end-of-stream, or pending.

**Call relations**: `TuiEventStream::poll_next` calls this as one of its two possible event sources. It hands raw terminal events to `map_crossterm_event` and depends on the broker’s pause/resume state to avoid reading stdin at unsafe times.

*Call graph*: called by 1 (poll_next); 2 external calls (new, Ready).


##### `TuiEventStream::poll_draw_event`  (lines 225–234)

```
fn poll_draw_event(&mut self, cx: &mut Context<'_>) -> Poll<Option<TuiEvent>>
```

**Purpose**: This checks whether the app has requested a redraw of the TUI. A redraw request becomes a simple `TuiEvent::Draw`.

**Data flow**: It polls the draw broadcast stream. A normal draw message becomes `Draw`; if the receiver fell behind, that also becomes `Draw` because at least one redraw is still needed. Closed streams end the event stream, and no available message returns pending.

**Call relations**: `TuiEventStream::poll_next` calls this alongside terminal input polling. This lets internal repaint requests and user input share the same event stream.

*Call graph*: called by 1 (poll_next); 2 external calls (new, Ready).


##### `TuiEventStream::map_crossterm_event`  (lines 237–269)

```
fn map_crossterm_event(&mut self, event: Event) -> Option<TuiEvent>
```

**Purpose**: This translates raw crossterm terminal events into the app’s simpler `TuiEvent` values. It also updates focus state and performs special Unix suspend behavior.

**Data flow**: It receives one raw terminal event. Key, resize, and paste events become matching `TuiEvent` values. Focus gained stores that the terminal is focused, requeries terminal colors, and asks for a draw. Focus lost stores that the terminal is unfocused and emits no event. Mouse and other unused events are ignored. On Unix, the suspend key pauses input, suspends the process, resumes input, logs failure if needed, and returns a draw event.

**Call relations**: `poll_crossterm_event` calls this after receiving raw terminal input. The mapped event is then returned through `poll_next` to whichever part of the TUI is driving the UI loop.

*Call graph*: calls 1 internal fn (suspend); 4 external calls (requery_default_colors, warn!, Key, Paste).


##### `TuiEventStream::poll_next`  (lines 277–299)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: This is the main stream polling function that produces the next `TuiEvent`. It fairly checks both terminal input and redraw requests.

**Data flow**: It receives the async polling context and flips an internal `poll_draw_first` flag. Depending on that flag, it checks draw first then input, or input first then draw. The first ready event is returned; if neither source has anything ready, it returns pending.

**Call relations**: Async code using `TuiEventStream` calls this through the standard stream interface. It delegates the real work to `poll_crossterm_event` and `poll_draw_event`, alternating the order so one source cannot continually block the other.

*Call graph*: calls 2 internal fn (poll_crossterm_event, poll_draw_event); 1 external calls (Ready).


##### `tests::FakeEventSource::new`  (lines 329–332)

```
fn new() -> Self
```

**Purpose**: This creates a fake terminal event source for tests. It lets tests inject terminal events without using a real terminal.

**Data flow**: It creates an unbounded in-memory channel. The receiver is stored for polling, and the sender is stored so the test handle can push events into the fake source.

**Call relations**: The test setup code uses this to seed the broker with controllable input. `tests::FakeEventSource::default` also calls it when the broker needs to create a fresh fake source.

*Call graph*: 1 external calls (unbounded_channel).


##### `tests::FakeEventSource::default`  (lines 336–338)

```
fn default() -> Self
```

**Purpose**: This gives the fake event source the same default-construction behavior as the real crossterm source. That lets the generic broker work the same way in tests as in production.

**Data flow**: It takes no inputs and returns a new fake event source with its own channel.

**Call relations**: The broker calls the default constructor when it changes from `Start` to `Running`. In tests, this means resume behavior can be tested without touching real terminal input.

*Call graph*: 1 external calls (new).


##### `tests::FakeEventSourceHandle::new`  (lines 342–344)

```
fn new(broker: Arc<EventBroker<FakeEventSource>>) -> Self
```

**Purpose**: This creates a small test helper that can send events into the fake source through the shared broker. It is the test-side remote control for terminal input.

**Data flow**: It receives the shared fake broker and stores it in a handle. The returned handle can later look up the active fake source and send events into it.

**Call relations**: `tests::setup` creates this handle and passes it to individual tests. Those tests call `send` to simulate keys, resize events, errors, and other terminal activity.


##### `tests::FakeEventSourceHandle::send`  (lines 346–356)

```
fn send(&self, event: EventResult)
```

**Purpose**: This injects one fake terminal event into the currently active fake event source. If input is paused, it does nothing, matching the idea that paused input should not receive events.

**Data flow**: It receives an event result, locks the broker state, and asks for the active source. If there is one, it sends the event through the fake source’s channel; if not, the event is dropped.

**Call relations**: The tests use this to drive `TuiEventStream` without a real terminal. It relies on `EventBrokerState::active_event_source_mut`, so it also exercises broker start, running, and paused behavior.


##### `tests::FakeEventSource::poll_next`  (lines 360–362)

```
fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<EventResult>>
```

**Purpose**: This makes the fake source behave like an async stream of terminal events. It returns whatever the test has sent through the channel.

**Data flow**: It receives the fake source and polling context, then polls the channel receiver. The output is pending, the next injected event result, or end-of-stream if the channel closes.

**Call relations**: `TuiEventStream::poll_crossterm_event` calls this through the same `EventSource` interface used by the real crossterm source. That lets the production polling logic be tested unchanged.

*Call graph*: 1 external calls (new).


##### `tests::make_stream`  (lines 365–379)

```
fn make_stream(
        broker: Arc<EventBroker<FakeEventSource>>,
        draw_rx: broadcast::Receiver<()>,
        terminal_focused: Arc<AtomicBool>,
    ) -> TuiEventStream<FakeEventSource>
```

**Purpose**: This test helper builds a `TuiEventStream` wired to the fake broker and draw channel. It hides the extra setup needed for Unix suspend fields.

**Data flow**: It receives the fake broker, draw receiver, and shared focus flag. It creates any required suspend or alternate-screen test state and returns a ready fake-backed `TuiEventStream`.

**Call relations**: Most tests call this after `setup`. It routes them through `TuiEventStream::new`, so the tests exercise the same construction path as real code.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (new, new).


##### `tests::setup`  (lines 389–398)

```
fn setup() -> SetupState
```

**Purpose**: This prepares the common test environment for event stream tests. It creates fake input, a broker, a draw channel, and shared focus state.

**Data flow**: It creates a fake event source and broker, places the source into the broker as running, builds a handle for injecting events, creates a broadcast channel for draw requests, and returns all of these pieces with an initial focused flag.

**Call relations**: Each test calls this to start from a clean, controllable event system. The returned pieces are then passed into `make_stream` and used to simulate input or draw requests.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, channel, Running, new, new).


##### `tests::key_event_skips_unmapped`  (lines 401–418)

```
async fn key_event_skips_unmapped()
```

**Purpose**: This test checks that ignored raw events do not stop the stream from delivering the next useful key event. In particular, focus loss should update state but not be emitted as a user-facing event.

**Data flow**: It builds a fake stream, sends a focus-lost event followed by an `a` key event, then waits for the next stream item. The expected output is the key event, not the focus-lost event.

**Call relations**: The test drives the stream through the fake handle and observes `TuiEventStream::poll_next`. It verifies the filtering behavior inside `map_crossterm_event` as used by `poll_crossterm_event`.

*Call graph*: 7 external calls (Char, new, assert_eq!, panic!, Key, make_stream, setup).


##### `tests::draw_and_key_events_yield_both`  (lines 421–448)

```
async fn draw_and_key_events_yield_both()
```

**Purpose**: This test checks that redraw requests and key input can both be delivered when they arrive close together. Neither source should hide the other.

**Data flow**: It sends one draw request and one fake key event, then reads two events from the stream. It records whether it saw a draw and the expected key, and asserts that both appeared.

**Call relations**: This test exercises the combined behavior of `poll_draw_event`, `poll_crossterm_event`, and `poll_next`’s alternating poll order.

*Call graph*: 8 external calls (Char, new, assert!, assert_eq!, panic!, Key, make_stream, setup).


##### `tests::lagged_draw_maps_to_draw`  (lines 451–461)

```
async fn lagged_draw_maps_to_draw()
```

**Purpose**: This test checks that falling behind on redraw notifications still causes a redraw. Missing some draw messages is acceptable because one redraw can catch the screen up.

**Data flow**: It sends enough draw messages to overflow the tiny broadcast buffer for the receiver. When the stream is polled, the lag error is expected to become `TuiEvent::Draw`.

**Call relations**: The test targets `poll_draw_event` through the public stream behavior. It confirms that lag in the draw broadcast channel is treated as useful repaint work, not as a fatal error.

*Call graph*: 3 external calls (assert!, make_stream, setup).


##### `tests::resize_event_maps_to_resize`  (lines 464–472)

```
async fn resize_event_maps_to_resize()
```

**Purpose**: This test checks that a terminal resize event becomes the app’s resize event. That lets the TUI know it should lay itself out again.

**Data flow**: It sends a fake resize event with a width and height, then reads from the stream. The expected output is `TuiEvent::Resize`.

**Call relations**: The test sends raw input through the fake source and observes the mapped result from `map_crossterm_event` as returned by `poll_next`.

*Call graph*: 4 external calls (assert!, Resize, make_stream, setup).


##### `tests::error_or_eof_ends_stream`  (lines 475–483)

```
async fn error_or_eof_ends_stream()
```

**Purpose**: This test checks what happens when the underlying input source reports an error. The event stream should end instead of producing a misleading normal event.

**Data flow**: It sends an I/O error through the fake source, then awaits the next stream item. The expected result is no event, meaning the stream ended.

**Call relations**: The test exercises the error branch in `poll_crossterm_event`. It confirms that source failures reset broker state and surface as stream termination.

*Call graph*: 4 external calls (assert!, other, make_stream, setup).


##### `tests::resume_wakes_paused_stream`  (lines 486–507)

```
async fn resume_wakes_paused_stream()
```

**Purpose**: This test checks that a stream waiting during a pause wakes up after resume and can receive input. It protects the pause/resume behavior that prevents stdin stealing.

**Data flow**: It pauses the broker, starts waiting for the next stream event in a task, resumes the broker, sends a fake `r` key, and waits with a timeout. The expected output is that key event.

**Call relations**: The test proves that `resume_events` notifies the `resume_stream` used by `poll_crossterm_event`. Without that wakeup, the spawned stream task could stay asleep even after input was resumed.

*Call graph*: 11 external calls (from_millis, Char, new, assert_eq!, panic!, Key, spawn, yield_now, timeout, make_stream (+1 more)).


##### `tests::resume_wakes_pending_stream`  (lines 510–530)

```
async fn resume_wakes_pending_stream()
```

**Purpose**: This test checks that resume also wakes a stream that was already pending on input, not only one paused before polling. This covers a race-prone case where the input source changes while a task is waiting.

**Data flow**: It starts waiting for the next event, lets the task reach a pending state, pauses and resumes the broker, sends a fake `p` key, and expects that key before the timeout.

**Call relations**: The test exercises the pending-input branch in `poll_crossterm_event`, where the resume watcher is also polled. It confirms that pause/resume can break a pending wait and reconnect the stream to fresh input.

*Call graph*: 11 external calls (from_millis, Char, new, assert_eq!, panic!, Key, spawn, yield_now, timeout, make_stream (+1 more)).
