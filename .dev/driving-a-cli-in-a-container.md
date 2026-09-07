# Driving an interactive CLI in a container

The contributor guide for the case where Hezo runs a vendor's own interactive command inside a sandbox, reads what it printed, and types something back. The guided subscription sign-in (`services/subscription-login*.ts`) is the worked example; the traps below are the terminal's, not that feature's, and every one of them was paid for once already.

The rule that binds without reading this is in `AGENTS.md`; everything here is for the person adding or changing such a flow.

## The shape of the problem

A CLI you drive this way is not a program you pipe to. It is a program painting a **screen** through a **terminal**, and both halves have behaviour you have to supply and honour:

- The terminal has a size, and it is not the environment's business.
- The screen is a grid of cells, and its contents are the composition of every frame, not the concatenation of the bytes.
- Its input is raw, so no line discipline is translating anything for you.

Get any of these wrong and the flow does not fail. It produces a value that is the right shape and the wrong contents, which is stored and only refused much later, somewhere else.

## Give the PTY a size

`script -qec …` opens a PTY that is **never sized**: `stty size` reports `0 0`. A TUI asks the terminal through `TIOCGWINSZ`, not the environment, so `COLUMNS=1000` in front of the command changes nothing and the CLI falls back to its own default of 80 columns. Everything it prints is then laid out to 80 columns, values included.

Resize the terminal itself, inside the PTY and before the CLI starts:

```sh
script -qec 'stty cols 400 rows 100; the-cli login' /dev/null
```

Export `COLUMNS`/`LINES` to match if you like, from the same constant. What you must not do is set only those and believe the terminal is wide.

Set rows too. A zero-height terminal is not a shape a full-screen CLI is written for.

## Read the screen, not the stream

**Never recover a value by deleting escape sequences and keeping the rest.** A repaint writes only the cells that changed, so a single logical value reaches the log as fragments at coordinates, and the fragments are not adjacent to each other in the byte stream:

```
ESC[2G  sk-ant-    ESC[10G  at01-…
```

Column 9 is not rewritten, because an earlier frame already put the right character there. Delete the escapes and the two fragments splice together with that character missing — a token one character short, still matching any shape check you wrote.

Compose the cells instead and read the value off the finished screen: `renderTerminalScreen` (`services/sandbox/terminal-screen.ts`). It is the only supported way to read a CLI's output, and it is equally correct on a plain pipe, where there is nothing to compose.

Two things it deliberately does not do:

- **It does not join rows.** A value the CLI wrapped is on two rows, and a row break it chose is indistinguishable from one it meant. Size the PTY so nothing wraps; that is the fix, not a rejoining heuristic.
- **It does not carry hyperlink targets.** An OSC 8 target occupies no cell. Read a URL from the escape with `parseOsc8Links` rather than off the screen, where it is subject to layout.

## Typing back

- **Terminate with CR, never LF.** A raw-mode prompt has no line discipline turning one into the other, so an LF arrives as an ordinary character: the value lands in the box and sits there unsubmitted until the flow times out.
- **Frame a paste when the prompt asked for one.** A prompt that enabled bracketed paste (DECSET 2004) groups a burst of bytes into pasted text, and takes a trailing CR as part of the paste rather than as Return. Splitting the CR into a second write does not separate them — the reads coalesce. Wrap the value in the paste markers so the markers end the paste and the CR after them is unambiguously a keypress. Read whether the mode is on from the CLI's own output (`bracketedPasteEnabled`), never from a table: it is a property of the prompt currently on screen.
- **Hold stdin open.** A FIFO with no writer gives the CLI EOF the moment it opens the pipe, and it abandons its prompt. A `sleep` holding the write end for the flow's lifetime is what lets a code arrive minutes later.

## Launching and watching

- **Detach both background jobs' stdio** (`>/dev/null 2>&1 &` on the subshell, as well as the redirections inside it). An exec does not complete while a child still holds its pipes, so without this the call that starts the flow never returns.
- **Address every path absolutely and never `cd`.** `&` binds looser than `&&`, so a `cd` at the head of the chain backgrounds with the first subshell and the second one runs somewhere else entirely.
- **Poll a file, not a byte stream.** `SandboxFiles` behaves identically on every backend; an exec channel's stream semantics do not.

## Do not trust what you read

Scraping is a reading, and a reading can be wrong in ways no shape check catches. **Whatever you harvest, put it through the same validation as the same value arriving by any other route** before you store it — for a credential, that means asking the provider whether it works, exactly as the manual paste path does. A value Hezo scraped deserves *more* suspicion than one a human pasted, not less.

Budget for the vendor's clock too. A one-time code expires on the vendor's schedule, which is shorter than a flow timeout you picked; a sign-in that sat for several minutes between the browser and the paste can fail its exchange with nothing wrong on our side.

## Recording a fixture

Parsers here are written against **recorded** output, because a parser written against prose in a vendor doc is a guess whose failure mode is a flow that hangs with nothing to say. Record from the real CLI at the pinned version, and note the version next to the fixture.

**Never commit a capture containing a real credential.** Substitute the value, then prove the substitution: render the fixture and check what comes back is the synthetic value. A capture of a TUI holds its secret in fragments, so a search-and-replace over the whole value silently misses every one of them.
