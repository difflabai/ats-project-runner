# ATS Project Runner

Config-driven multi-project task runner. Watches ATS channels, picks up tasks, runs Claude Code against the target repo, and opens PRs.

## How It Works

1. Watches multiple ATS channels (one per project) via `ats watch`
2. When a task arrives, claims it and creates a suffixed run-task for execution logs
3. Checks out a fresh branch (`task/<id>-<slug>`) from the default branch
4. Detects task complexity → runs Claude Code in **one-shot** or **iterative** mode
5. Commits changes, pushes branch, opens a PR via `gh pr create`
6. Completes the original ATS task with the PR URL

## Mode Detection

- **One-shot**: keywords like "fix typo", "rename", "bump", "update version"
- **Iterative** (8+ iterations): "add", "implement", "refactor", "debug", "build"
- Description > 500 chars → +3 iterations
- Repo has test suite → +3 iterations
- Max cap per project in `config.json`

## Config

Edit `config.json` to add/remove projects:

```json
{
  "projects": {
    "my-project": {
      "channel": "my-project-tasks",
      "repo": "/path/to/repo",
      "github": "org/repo",
      "default_mode": "auto",
      "max_iterations": 15
    }
  },
  "claude_bin": "/usr/bin/claude",
  "ats_bin": "/usr/bin/ats",
  "lease_ms": 7200000,
  "claude_timeout_ms": 3600000
}
```

## Running

```bash
node index.js          # foreground
systemctl --user enable --now ats-project-runner  # systemd
```

## Concurrency

One task at a time across all projects. Additional tasks are queued and processed in order.

## Suffixed Channels

Task #500 on `my-project` → execution tracked on `my-project:run-1`. Original task gets completed with the PR URL.
