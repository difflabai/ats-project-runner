# ATS Project Runner

Multi-project task runner with CLI and watch modes. Reads ATS tasks, creates suffixed copies for execution, runs Claude Code against target repos, and opens PRs. The original task is never modified.

## Modes

### CLI Mode

Point the CLI at a task ID — it reads the task, matches it to a project, and runs Claude Code.

```bash
# Run a specific task by ID
node index.js run <task-id>

# Run with multiple attempts (sequential, each gets its own branch + PR)
node index.js run <task-id> --attempts 3

# Force one-shot mode
node index.js run <task-id> --mode oneshot

# Force iterative mode with custom iteration count
node index.js run <task-id> --mode iterative --iterations 12
```

### Watch Mode

Watches all channels defined in `config.json` via WebSocket. When a new task appears:

1. Reads the original task (does NOT claim or modify it)
2. Determines the number of attempts from the task payload (`"attempts": N`) or project `default_attempts`
3. Creates N suffixed run tasks on channels like `{channel}:run-1`, `{channel}:run-2`, etc.
4. Processes runs sequentially — each gets its own branch and PR
5. Runs 2+ receive context from previous runs (branch, PR URL, status) so Claude can build on or diverge from earlier attempts
6. Completes/fails only the suffixed run tasks — the original stays untouched

```bash
node index.js watch
```

The watcher only watches base channels from config — never suffixed `:run-N` channels.

#### Triggering Multiple Attempts

Set `"attempts"` in the task payload when creating the task:

```bash
ats create "Fix auth flow" --channel nanobazaar-seller --payload '{"attempts": 3}'
```

Or set `default_attempts` per project in `config.json` (defaults to 1).

#### How Previous Runs Are Referenced

When `attempts > 1`, runs 2+ get extra context injected into the Claude Code prompt:

```
## Previous Attempts

### Run 1
- Branch: task/500-fix-auth
- PR: https://github.com/org/repo/pull/42
- Status: completed

### Run 2
- Branch: task/500-fix-auth-run2
- PR: https://github.com/org/repo/pull/43
- Status: completed

Use these as reference. Build on what worked, fix what didn't. Take the best approach.
```

## How It Works

1. Reads the original task (title, description, channel) — **does not claim or modify it**
2. Matches the task's channel to a project in `config.json`
3. Creates a COPY task on a suffixed channel (e.g. `nanobazaar-seller:run-1`)
4. Claims the copy, checks out a fresh branch (`task/<id>-<slug>`), runs Claude Code
5. Commits changes, pushes branch, opens a PR via `gh pr create`
6. Completes/fails the copy task with results — original stays untouched

## Mode Detection

Automatic unless overridden with `--mode` / `--iterations`:

- **One-shot**: keywords like "fix typo", "rename", "bump", "update version"
- **Iterative** (8+ iterations): "add", "implement", "refactor", "debug", "build"
- Description > 500 chars adds +3 iterations
- Repo has test suite adds +3 iterations
- Max cap per project in `config.json`

Mode detection is independent of attempts. You can have 3 attempts each in iterative mode (3 independent multi-pass PRs).

## Config

```json
{
  "projects": {
    "my-project": {
      "channel": "my-project-tasks",
      "repo": "/path/to/repo",
      "github": "org/repo",
      "default_mode": "auto",
      "max_iterations": 15,
      "default_attempts": 1
    }
  },
  "claude_bin": "/usr/bin/claude",
  "ats_bin": "/usr/bin/ats",
  "telegram_chat_id": "123456",
  "telegram_token": "bot-token",
  "lease_ms": 7200000,
  "claude_timeout_ms": 3600000
}
```

### Project Fields

| Field | Description |
|-------|-------------|
| `channel` | ATS channel to watch / match tasks against |
| `repo` | Local path to the git repository |
| `github` | GitHub `org/repo` for PR creation |
| `default_mode` | `auto`, `oneshot`, or `iterative` |
| `max_iterations` | Cap on Claude Code iterations per run |
| `default_attempts` | Default number of independent attempts (default: 1) |

## Suffixed Channels

- `node index.js run 500` → reads task #500, creates execution task on `my-project:run-1`
- `node index.js run 500 --attempts 3` → creates `my-project:run-1`, `:run-2`, `:run-3` sequentially
- Watch mode does the same automatically based on task payload or `default_attempts`

## Telegram Notifications

Sends notifications for:
- Watch mode started (with channel list)
- Task picked up (each run)
- PR opened (each run)
- Failures (each run)

## Original Task Policy

The runner **never** claims, completes, fails, or modifies the original task. It is treated as a read-only trigger/reference. All state management happens on the suffixed copy tasks.
