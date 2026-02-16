# Why This Exists

There's a particular kind of loneliness to maintaining software. Not the work itself — the work can be absorbing. The loneliness is in the surrounding quiet: the 2 AM test failures nobody sees, the dependency bumps that matter but don't merit a conversation, the steady accumulation of small tasks that never rise to the level of interesting but still need a human to sit down, read the context, create a branch, write the change, run the tests, fix what broke, push, open a PR, and describe what happened. Every single time.

AI can write code. That stopped being impressive a while ago. What AI mostly can't do is *ship* code — navigate the real topography of a project, respect its conventions, operate inside its workflow, and produce something a teammate would actually merge. The gap between a code suggestion and a pull request is enormous, and it's almost entirely plumbing. But plumbing is what makes a building habitable.

ATS Project Runner closes that gap.

## What It Does

One file. Under a thousand lines of Node.js. Zero dependencies. It reads a task from an [ATS](https://github.com/difflabai) queue, matches it to a configured project, creates a branch, and hands the real repository to Claude Code. When the work is done: commit, push, pull request.

It has two modes. **CLI mode** for running a specific task by ID. **Watch mode** for subscribing to task channels via WebSocket and processing whatever arrives — you start it once and a backlog becomes a queue of pull requests.

The system never touches the original task. It creates a copy on a suffixed channel, and all the claiming, heartbeating, completing, and failing happens on that copy. The original stays untouched as a record of what was asked.

## How It Thinks

Not every task deserves the same effort. The runner reads the title and description and decides. A task that says "fix typo" gets a single pass — one invocation of Claude, done. A task that says "implement" or "refactor" gets up to 8 iterative passes, where Claude reviews its own previous work, runs the test suite, and refines. A long description — evidence that someone took the time to explain — earns more passes. A project with a test suite earns more still. Even a task with no keywords but a substantial description gets promoted to iterative, because length is its own kind of signal. The maximum is capped per project, and the whole heuristic can be overridden from the command line or the task payload.

This is the difference between generating code and doing work. Work involves looking at what you produced, deciding it's not good enough, and trying again. The iteration loop is a `for` statement — nothing exotic. But the behavior it produces is closer to how a careful person operates than any single-prompt tool manages.

## Multi-Attempt Memory

When configured for multiple attempts, each run is independent: separate branch, separate PR. But run 2 receives context about run 1 — which branch was created, which PR was opened, whether it succeeded or failed. Run 3 sees runs 1 and 2. Claude doesn't repeat the same approach; it genuinely diverges, building on what worked and abandoning what didn't.

This is useful for hard problems where you'd rather review three different solutions than stake everything on one. It's also useful for the specific humility of admitting that sometimes the best strategy is to try again differently.

## The Part That's Hard to Talk About

The runner is in its own config. Fourth entry, right there alongside the projects it serves:

```json
"ats-project-runner": {
    "channel": "ats-project-runner",
    "repo": "/path/to/ats-project-runner",
    ...
}
```

It can receive tasks to modify itself, execute them, and open PRs against its own repository. The tool that ships code can ship improvements to itself. This is written here not as a boast but as a statement of fact that still feels slightly uncanny. A thing that fixes itself is a different kind of thing.

## Under the Hood

The architecture is deliberately boring. A single Node.js file that shells out to four CLIs: `git` for version control, `gh` for pull requests, `claude` for the AI, and `ats` for the task queue. Telegram notifications so you know what happened while you slept. Structured JSON logging. Lease renewal heartbeats so tasks don't expire mid-run. Graceful shutdown handlers so a SIGTERM doesn't leave orphaned branches. If a watcher dies, it restarts itself after five seconds — not because the code is clever, but because the alternative is silence, and silence is the enemy of trust.

There are no abstractions beyond what the problem demands. No plugin system, no middleware, no configuration DSL. The value isn't in any one piece — it's in the quiet discipline of wiring them together simply enough that you can read the whole thing in one sitting and know exactly what it will do.

---

This is a tool for people who have more to build than they have hands for. It won't replace the thinking, the architecture, the hard decisions about what to build and why. But the mechanical work of turning a described task into a reviewed pull request — the part that's important but not interesting, necessary but not creative — that, it can do. Reliably, at 3 AM, while you sleep, without complaint.

You wake up to pull requests. They're not perfect — some need a second look, a nudge, a rethink. But they exist. The branch is there, the tests ran, the diff is waiting. And the quiet hours between midnight and morning, the ones that used to belong to no one, produced something. That's not automation. That's relief.
