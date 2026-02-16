# ATS Project Runner

## What It Is

ATS Project Runner is an automated PR factory. You post a task description to an ATS channel, and it creates a branch, runs Claude Code to implement the changes, iterates until the work is done, commits, pushes, and opens a pull request. Zero human involvement from task to PR.

It supports two modes of operation:

- **CLI mode** — `node index.js run <task-id>` executes a single task immediately.
- **Watch mode** — `node index.js watch` monitors all configured ATS channels and processes tasks as they arrive, working through a FIFO queue.

A single process manages multiple projects. The original task is never modified — it stays pending until a human reviews the resulting PR.

## Why It Exists

The bottleneck in AI-assisted development isn't the AI writing code. It's the human orchestrating it.

Consider what happens when you use Claude Code manually: read the task description, copy it into a prompt, check out a branch, watch the output, iterate when something's off, commit, push, open a PR, link it back to the original task. Every task, every time. Pure mechanical overhead that doesn't scale.

ATS Project Runner eliminates that loop. You describe what you want on an ATS channel. It ships a PR. The only human step left is reviewing the result.

This matters most with a backlog of well-specified tasks. Post ten tasks to a channel and walk away. Come back to a stream of PRs ready for review instead of an inbox of things to orchestrate.

## How It Works

The runner is ~900 lines of Node.js with zero external dependencies. It orchestrates four existing tools: ATS for task management, Claude Code for implementation, git for version control, and `gh` for PR creation. It adds no intelligence of its own — all coding decisions are delegated to Claude Code.

### Task lifecycle

1. **Task arrives** — either via `node index.js run <task-id>` or detected by a channel watcher in watch mode.

2. **Task is read, not claimed** — the runner fetches the original task's title, description, and channel but never claims or modifies it.

3. **A run copy is created** — a new task is created on a suffixed channel like `my-project:run-1`. This copy is the unit of execution — it gets claimed, heartbeated, and completed or failed. The original stays untouched. (See [Design Philosophy](#the-original-task-is-sacred) for why.)

4. **Branch is created** — pull the latest default branch, create `task/<id>-<slug>` (with `-run2`, `-run3` suffixes for subsequent attempts).

5. **Claude Code runs** — the task description is piped to Claude Code as a prompt. In iterative mode, first pass implements; subsequent passes review, test, and fix. Claude signals `TASK_COMPLETE` to exit early when satisfied. Simple tasks run in one-shot mode — a single pass.

6. **Commit and push** — if Claude produced changes, stage everything, commit with a message referencing the task ID, push to remote.

7. **PR is opened** — via `gh pr create`, with the task description in the body and run metadata (mode, iteration count, run number).

8. **Run copy is completed** — marked complete with the PR URL, branch, and metadata. On failure, marked failed with the error.

The original task remains pending throughout. A human reviews the PR and decides whether to merge.

### Mode detection

The runner automatically decides how many Claude Code iterations to allocate:

- **One-shot** (1 iteration) — triggered by keywords like "fix typo", "rename", "version bump". Simple, mechanical changes.
- **Iterative** (8+ iterations) — triggered by keywords like "add", "implement", "refactor", "debug". The iteration count scales up for longer task descriptions (+3 if > 500 chars) and repos with test suites (+3), up to a per-project cap configured in `config.json`.

You can override this with `--mode oneshot` or `--mode iterative --iterations 12`.

### Multi-attempt runs

When a task specifies multiple attempts (via payload `{"attempts": 3}` or a project's `default_attempts`), the runner creates independent runs sequentially. Each gets its own branch and PR. Runs 2 and beyond receive context from previous runs — which branches were created, which PRs were opened, whether they succeeded or failed — so Claude can build on what worked and fix what didn't.

## Design Philosophy

### The original task is sacred

The runner never claims, completes, fails, or modifies the original task. It creates suffixed copies for execution. This means:

- Multiple attempts run independently without blocking each other.
- The original stays pending until a human reviews the PR.
- Each attempt has its own task with its own lifecycle — clean audit trail.
- Other ATS workers can read the original without interference.

The runner could claim the original and skip the copy step. It doesn't, because the original task represents a human intent that should only be resolved by a human decision.

### Iterative by default

One-shot works for trivial changes, but real tasks benefit from multiple passes. First pass implements. Subsequent passes review what was written, run tests, fix issues. Claude signals `TASK_COMPLETE` when it judges the work is done. This mirrors how a developer works — write, review, test, fix — without the human in the loop.

The iteration count is a budget, not a requirement. Claude can finish early or use all iterations. The runner doesn't judge quality — it gives Claude room to iterate and lets the human reviewer decide.

### Thin orchestrator

The runner contains zero project-specific logic. It doesn't know what language your repo uses, what framework it's built on, what tests look like, or what "good code" means. That's Claude Code's job.

The runner handles plumbing: task lifecycle, git operations, process management, and PR creation. Configuration per project is three fields: a channel name, a repository path, and a GitHub `org/repo`. It works with any repo, any language, any task.

This separation is deliberate. The orchestrator stays simple and stable. The intelligence lives in Claude Code, which improves with every model update — the runner gets better at its job without changing a line of its own code.

### Sequential processing

Tasks process one at a time via a FIFO queue. Parallel Claude sessions would compete for resources and could interfere in shared repos. Sequential is simpler, predictable, and debuggable. Each task completes fully — branch, iterations, commit, push, PR — before the next one starts.

## Where It Fits

ATS Project Runner is one worker in the DiffLab ATS ecosystem. ATS (Asynchronous Task System) is a channel-based task queue where independent workers subscribe to channels, pick up tasks, and report results. The ecosystem includes:

- **ada-dispatch** — routes and dispatches tasks across ATS channels.
- **song-creator** — automated song creation pipeline.
- **review-responder** — automated code review responses.
- **ATS Project Runner** — turns task descriptions into PRs via Claude Code.

Workers are independent. A task posted to a channel gets picked up by whoever watches that channel. The runner watches multiple project channels from a single process, each mapped in `config.json`.

It can also improve itself — the runner is configured as one of its own projects, watching the `ats-project-runner` channel for tasks about its own codebase.

## Getting Started

See the [README](../README.md) for configuration reference and usage examples.
