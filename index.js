#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = '3.0.0';

// === Load config ===
const CONFIG_PATH = join(__dirname, 'config.json');
if (!existsSync(CONFIG_PATH)) {
  console.error('Missing config.json');
  process.exit(1);
}
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

const ATS_BIN = CONFIG.ats_bin || '/usr/bin/ats';
const CLAUDE_BIN = CONFIG.claude_bin || '/usr/bin/claude';
const TELEGRAM_CHAT_ID = CONFIG.telegram_chat_id;
const TELEGRAM_TOKEN = CONFIG.telegram_token;
const LEASE_MS = CONFIG.lease_ms || 7200000;
const CLAUDE_TIMEOUT_MS = CONFIG.claude_timeout_ms || 3600000;
const PROJECTS = CONFIG.projects || {};

const ACTOR_FLAGS = ['--actor-type', 'agent', '--actor-id', 'ats-project-runner', '--actor-name', 'ATS Project Runner'];

// Mode detection keywords
const ONESHOT_KEYWORDS = ['fix typo', 'update version', 'rename', 'bump', 'typo', 'version bump'];
const ITERATIVE_KEYWORDS = ['add', 'implement', 'refactor', 'debug', 'investigate', 'build', 'create', 'feature'];

let running = true;
let currentChild = null; // active Claude child process
let processing = false; // true while a task is being processed (watch mode)
const taskQueue = []; // queued tasks for watch mode

// === Logging ===
function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// === Telegram ===
function telegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  }, (res) => {
    res.resume();
    if (res.statusCode !== 200) log('warn', 'Telegram API error', { statusCode: res.statusCode });
  });
  req.on('error', (err) => log('warn', 'Telegram send failed', { error: err.message }));
  req.write(body);
  req.end();
}

// === ATS helpers ===
function ats(...args) {
  const fullArgs = [...ACTOR_FLAGS, ...args];
  try {
    return execFileSync(ATS_BIN, fullArgs, {
      encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    log('debug', 'ats command failed', { args: fullArgs, stderr: err.stderr, stdout: err.stdout });
    throw err;
  }
}

function getTask(taskId) {
  const raw = ats('get', String(taskId), '-f', 'json');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function claimTask(taskId) {
  ats('claim', String(taskId), '--lease', String(LEASE_MS));
}

function completeTask(taskId, outputs) {
  ats('complete', String(taskId), '--outputs', JSON.stringify(outputs));
}

function failTask(taskId, reason) {
  ats('fail', String(taskId), '--reason', reason);
}

function postMessage(taskId, message) {
  try { ats('message', 'add', String(taskId), message); }
  catch (err) { log('warn', 'Failed to post ATS message', { taskId, error: err.message }); }
}

// === Suffixed channel task ===
function createRunTask(title, description, channel, runNumber, originalTaskId) {
  const suffixedChannel = `${channel}:run-${runNumber}`;
  const payload = JSON.stringify({ original_task_id: originalTaskId, run_number: runNumber });
  const args = ['create', `Working: ${title}`, '--channel', suffixedChannel, '--payload', payload, '-f', 'json'];
  if (description) {
    args.push('--description', description);
  }
  const raw = ats(...args);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    const idMatch = raw.match(/(?:Task|#)(\d+)/i);
    return idMatch ? idMatch[1] : null;
  }
  try {
    const obj = JSON.parse(match[0]);
    return obj.id || obj.uuid || null;
  } catch {
    const idMatch = raw.match(/(?:Task|#)(\d+)/i);
    return idMatch ? idMatch[1] : null;
  }
}

// === Mode detection ===
function detectMode(title, description, project) {
  const text = `${title} ${description}`.toLowerCase();
  const maxIter = project.max_iterations || 15;

  for (const kw of ONESHOT_KEYWORDS) {
    if (text.includes(kw)) {
      return { mode: 'oneshot', iterations: 1 };
    }
  }

  let iterations = 8;
  let isIterative = false;
  for (const kw of ITERATIVE_KEYWORDS) {
    if (text.includes(kw)) {
      isIterative = true;
      break;
    }
  }

  if (!isIterative) {
    if ((description || '').length > 300) {
      isIterative = true;
    } else {
      return { mode: 'oneshot', iterations: 1 };
    }
  }

  if ((description || '').length > 500) iterations += 3;

  try {
    const repoPath = project.repo;
    if (existsSync(join(repoPath, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        iterations += 3;
      }
    } else if (existsSync(join(repoPath, 'pytest.ini')) || existsSync(join(repoPath, 'pyproject.toml'))) {
      iterations += 3;
    }
  } catch {}

  iterations = Math.min(iterations, maxIter);
  return { mode: 'iterative', iterations };
}

// === Slugify ===
function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// === Git helpers ===
function git(repoPath, ...args) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    cwd: repoPath,
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function hasChanges(repoPath) {
  const status = git(repoPath, 'status', '--porcelain');
  return status.length > 0;
}

// === Claude Code invocation ===
function runClaude(prompt, repoPath) {
  const child = spawn(CLAUDE_BIN, ['-p', '--dangerously-skip-permissions'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoPath,
  });

  child.stdin.write(prompt);
  child.stdin.end();

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, CLAUDE_TIMEOUT_MS);

  const promise = new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {}); // drain
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM' || code === 143) {
        reject(new Error('Claude timed out or was cancelled'));
      } else if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return { promise, child };
}

// === Channel -> project lookup ===
function findProjectByChannel(channel) {
  for (const [name, proj] of Object.entries(PROJECTS)) {
    if (proj.channel === channel) return { name, project: proj };
  }
  return null;
}

// === Build previous runs context for the Claude prompt ===
function buildPreviousRunsContext(previousRuns) {
  if (!previousRuns || previousRuns.length === 0) return '';

  let context = '\n\n## Previous Attempts\n';
  for (const run of previousRuns) {
    context += `\n### Run ${run.run_number}\n`;
    context += `- Branch: ${run.branch || 'N/A'}\n`;
    if (run.pr_url) context += `- PR: ${run.pr_url}\n`;
    context += `- Status: ${run.success ? 'completed' : 'failed'}\n`;
    if (run.error) context += `- Error: ${run.error}\n`;
    if (run.summary) context += `- Summary: ${run.summary}\n`;
  }
  context += '\nUse these as reference. Build on what worked, fix what didn\'t. Take the best approach.\n';
  return context;
}

// === Main task processing pipeline ===
async function processTask(task, project, projectName, runNumber, modeOverride, previousRuns) {
  const origTaskId = task.id || task.uuid;
  const title = task.title || 'Untitled';
  const description = task.description || '';
  const repoPath = project.repo;
  const githubRepo = project.github;

  log('info', 'Processing task', { origTaskId, title, projectName, repoPath, runNumber });

  // 1. Create suffixed run task (the ONLY task we claim/complete/fail)
  let runTaskId = null;
  try {
    runTaskId = createRunTask(title, description, project.channel, runNumber, origTaskId);
    if (!runTaskId) throw new Error('No task ID returned');
    log('info', 'Created run task', { runTaskId, channel: `${project.channel}:run-${runNumber}` });
    telegram(`\u{1F680} <b>Project Runner</b> started run-${runNumber} for task #${origTaskId} on <b>${projectName}</b>\nTask: ${title}`);
  } catch (err) {
    log('error', 'Failed to create run task', { origTaskId, error: err.message });
    telegram(`\u274C <b>Failed to create run task</b> for #${origTaskId} on <b>${projectName}</b>\n${err.message}`);
    return { success: false, error: err.message, run_number: runNumber };
  }

  // 2. Claim the run task
  try {
    claimTask(runTaskId);
    postMessage(runTaskId, `Processing original task #${origTaskId}: ${title}`);
  } catch (err) {
    log('error', 'Failed to claim run task', { runTaskId, error: err.message });
    return { success: false, error: err.message, run_number: runNumber };
  }

  // 3. Lease renewal heartbeat (only on the run task)
  const renewInterval = setInterval(() => {
    try {
      claimTask(runTaskId);
      postMessage(runTaskId, 'Heartbeat \u2014 still running');
    } catch (err) {
      log('warn', 'Heartbeat failed', { runTaskId, error: err.message });
    }
  }, LEASE_MS / 4);

  try {
    // 4. Git setup: checkout main, pull, create branch
    log('info', 'Setting up git branch', { repoPath });
    postMessage(runTaskId, 'Setting up git branch');

    let defaultBranch = 'main';
    try {
      const ref = git(repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD');
      defaultBranch = ref.replace('refs/remotes/origin/', '');
    } catch {
      try { git(repoPath, 'rev-parse', '--verify', 'origin/main'); defaultBranch = 'main'; }
      catch { try { git(repoPath, 'rev-parse', '--verify', 'origin/master'); defaultBranch = 'master'; } catch {} }
    }

    git(repoPath, 'checkout', defaultBranch);
    git(repoPath, 'pull', '--ff-only');

    const branchSuffix = runNumber > 1 ? `-run${runNumber}` : '';
    const branchName = `task/${origTaskId}-${slugify(title)}${branchSuffix}`;
    git(repoPath, 'checkout', '-b', branchName);
    log('info', 'Created branch', { branchName });
    postMessage(runTaskId, `Created branch: ${branchName}`);

    // 5. Detect mode (or use override)
    let mode, iterations;
    if (modeOverride) {
      mode = modeOverride.mode;
      iterations = modeOverride.iterations || (mode === 'oneshot' ? 1 : 8);
      iterations = Math.min(iterations, project.max_iterations || 15);
    } else {
      ({ mode, iterations } = detectMode(title, description, project));
    }
    log('info', 'Mode selected', { mode, iterations, origTaskId, override: !!modeOverride });
    postMessage(runTaskId, `Mode: ${mode}, max iterations: ${iterations}`);

    // 6. Build the previous runs context
    const prevContext = buildPreviousRunsContext(previousRuns);

    // 7. Run Claude Code
    let totalIterations = 0;
    let lastOutput = '';
    let cancelledByShutdown = false;

    const onShutdown = () => {
      cancelledByShutdown = true;
      if (currentChild) {
        log('info', 'Killing Claude due to shutdown', { runTaskId });
        currentChild.kill('SIGTERM');
      }
    };
    process.on('SIGTERM', onShutdown);
    process.on('SIGINT', onShutdown);

    try {
      for (let i = 0; i < iterations; i++) {
        if (!running || cancelledByShutdown) break;

        totalIterations = i + 1;
        let prompt;

        if (i === 0) {
          prompt = `You are working on the project at ${repoPath}. Execute this task:\n\n${title}\n${description}${prevContext}\n\nMake progress on this task. Do NOT commit, push, or create PRs.`;
        } else {
          prompt = `Continue working on the task: ${title}. Review changes so far, run tests if available, fix issues. When the task is fully complete and tests pass, respond with exactly 'TASK_COMPLETE' on its own line. Do NOT commit, push, or create PRs.`;
        }

        log('info', `Claude iteration ${i + 1}/${iterations}`, { runTaskId, mode });
        postMessage(runTaskId, `Iteration ${i + 1}/${iterations}`);

        const { promise, child } = runClaude(prompt, repoPath);
        currentChild = child;

        lastOutput = await promise;

        if (mode === 'iterative' && i > 0 && lastOutput.includes('TASK_COMPLETE')) {
          log('info', 'Claude signaled TASK_COMPLETE', { runTaskId, iteration: i + 1 });
          postMessage(runTaskId, `Claude signaled TASK_COMPLETE at iteration ${i + 1}`);
          break;
        }
      }
    } finally {
      process.removeListener('SIGTERM', onShutdown);
      process.removeListener('SIGINT', onShutdown);
      currentChild = null;
    }

    if (cancelledByShutdown) {
      log('info', 'Task interrupted by shutdown', { runTaskId });
      clearInterval(renewInterval);
      return { success: false, error: 'interrupted', run_number: runNumber };
    }

    // 8. Commit & push if there are changes
    let prUrl = null;
    if (hasChanges(repoPath)) {
      postMessage(runTaskId, 'Committing changes');
      git(repoPath, 'add', '-A');

      const commitMsg = `task/${origTaskId}: ${title}`;
      git(repoPath, 'commit', '-m', commitMsg);
      log('info', 'Committed changes', { runTaskId, branchName });

      postMessage(runTaskId, 'Pushing branch');
      git(repoPath, 'push', '-u', 'origin', branchName);
      log('info', 'Pushed branch', { runTaskId, branchName });

      postMessage(runTaskId, 'Creating pull request');
      try {
        const prBody = `## ATS Task #${origTaskId}\n\n${description}\n\n---\nMode: ${mode} | Iterations: ${totalIterations} | Run: ${runNumber}\nGenerated by ATS Project Runner v${VERSION}`;
        const prOutput = execFileSync('gh', [
          'pr', 'create',
          '--repo', githubRepo,
          '--title', title,
          '--body', prBody,
          '--head', branchName,
        ], {
          encoding: 'utf-8',
          cwd: repoPath,
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        prUrl = prOutput.split('\n').pop().trim();
        log('info', 'PR created', { runTaskId, prUrl });
        postMessage(runTaskId, `PR created: ${prUrl}`);
      } catch (err) {
        log('error', 'Failed to create PR', { runTaskId, error: err.message, stderr: err.stderr });
        postMessage(runTaskId, `PR creation failed: ${err.message}`);
      }
    } else {
      log('info', 'No changes to commit', { runTaskId });
      postMessage(runTaskId, 'No changes were made');
    }

    // 9. Complete the run task only
    const outputs = {
      original_task_id: origTaskId,
      pr_url: prUrl,
      branch: branchName,
      mode,
      iterations: totalIterations,
      run_number: runNumber,
    };

    completeTask(runTaskId, outputs);
    log('info', 'Run task completed', { runTaskId, outputs });

    if (prUrl) {
      telegram(`\u2705 <b>PR opened</b> on <b>${projectName}</b> (run-${runNumber})\nTask: ${title} (#${origTaskId})\n${prUrl}`);
    } else {
      telegram(`\u2705 <b>Run done</b> on <b>${projectName}</b> (run-${runNumber}, no changes)\nTask: ${title} (#${origTaskId})`);
    }

    // Truncate lastOutput for summary (last 500 chars)
    const summary = lastOutput.length > 500 ? lastOutput.slice(-500) : lastOutput;

    return { success: true, runTaskId, prUrl, branch: branchName, outputs, run_number: runNumber, summary };

  } catch (err) {
    log('error', 'Task processing failed', { runTaskId, error: err.message });
    postMessage(runTaskId, `Failed: ${err.message}`);

    try { failTask(runTaskId, err.message); } catch {}
    telegram(`\u274C <b>Failed</b> on <b>${projectName}</b> (run-${runNumber})\nTask: ${title} (#${origTaskId})\n${err.message.slice(0, 200)}`);

    // Clean up: try to get back to default branch
    try { git(repoPath, 'checkout', '-'); } catch {}

    return { success: false, runTaskId, error: err.message, run_number: runNumber };
  } finally {
    clearInterval(renewInterval);
  }
}

// === Run all attempts for a task ===
async function runAllAttempts(task, project, projectName, attempts, modeOverride) {
  const origTaskId = task.id || task.uuid;
  const title = task.title || 'Untitled';

  log('info', 'Starting all attempts', { origTaskId, title, attempts });

  const results = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!running) break;

    log('info', `Starting attempt ${attempt}/${attempts}`, { origTaskId });
    const result = await processTask(task, project, projectName, attempt, modeOverride, results);
    results.push(result);

    if (!result.success) {
      log('warn', `Attempt ${attempt} failed`, { origTaskId, error: result.error });
    }
  }

  // Summary
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);
  log('info', 'All attempts complete', {
    origTaskId,
    total: results.length,
    successes: successes.length,
    failures: failures.length,
    prs: successes.map(r => r.prUrl).filter(Boolean),
  });

  return results;
}

// === Preflight ===
function preflight({ skipClaude = false } = {}) {
  const checks = [{ name: 'ats', bin: ATS_BIN }];
  if (!skipClaude) checks.push({ name: 'claude', bin: CLAUDE_BIN });
  for (const check of checks) {
    try {
      const version = execSync(`'${check.bin}' --version`, {
        encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      log('info', `Preflight passed: ${check.name}`, { bin: check.bin, version });
    } catch (err) {
      log('error', `Preflight failed: ${check.name}`, { bin: check.bin, error: err.message });
      process.exit(1);
    }
  }
}

// === Shutdown ===
function shutdown(signal) {
  log('info', 'Shutdown requested', { signal });
  running = false;
  if (currentChild) {
    log('info', 'Killing active Claude process');
    currentChild.kill('SIGTERM');
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// === Track seen task IDs to avoid processing duplicates ===
const seenTaskIds = new Set();

// === Watch mode: process queue ===
async function processQueue() {
  if (processing || taskQueue.length === 0) return;
  processing = true;

  while (taskQueue.length > 0 && running) {
    const { task, project, projectName, attempts, modeOverride } = taskQueue.shift();
    const origTaskId = task.id || task.uuid;

    try {
      await runAllAttempts(task, project, projectName, attempts, modeOverride);
    } catch (err) {
      log('error', 'Failed to process queued task', { origTaskId, error: err.message });
      telegram(`\u274C <b>Queue processing error</b> for task #${origTaskId}: ${err.message.slice(0, 200)}`);
    }
  }

  processing = false;
}

// === Watch mode ===
async function watchMode() {
  // Collect base channels from config
  const baseChannels = [];
  for (const [name, proj] of Object.entries(PROJECTS)) {
    baseChannels.push({ name, channel: proj.channel, project: proj });
  }

  if (baseChannels.length === 0) {
    log('error', 'No projects configured — nothing to watch');
    process.exit(1);
  }

  log('info', `ats-project-runner v${VERSION} (watch mode)`, {
    channels: baseChannels.map(c => c.channel),
    projects: baseChannels.map(c => c.name),
  });

  preflight();
  telegram(`\u{1F440} <b>Project Runner</b> watch mode started\nWatching: ${baseChannels.map(c => c.channel).join(', ')}`);

  // Spawn one ats watch process per channel
  const watchers = [];

  for (const { name, channel, project } of baseChannels) {
    const watchArgs = [...ACTOR_FLAGS, 'watch', '--channel', channel, '--events', 'task.created', '-f', 'json'];
    log('info', 'Starting watcher', { channel, args: watchArgs });

    const watcher = spawn(ATS_BIN, watchArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';

    watcher.stdout.on('data', (chunk) => {
      buffer += chunk.toString();

      // Try to extract JSON objects from the buffer
      // The ats watch output interleaves JSON objects with human-readable lines
      let startIdx;
      while ((startIdx = buffer.indexOf('{')) !== -1) {
        // Find the matching closing brace
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < buffer.length; i++) {
          if (buffer[i] === '{') depth++;
          else if (buffer[i] === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }

        if (endIdx === -1) break; // incomplete JSON, wait for more data

        const jsonStr = buffer.slice(startIdx, endIdx + 1);
        buffer = buffer.slice(endIdx + 1);

        try {
          const event = JSON.parse(jsonStr);
          handleWatchEvent(event, name, channel, project);
        } catch {
          // Not valid JSON, skip
          log('debug', 'Failed to parse watch JSON', { channel, json: jsonStr.slice(0, 200) });
        }
      }

      // If buffer gets too large without valid JSON, trim non-JSON prefix
      if (buffer.length > 10000) {
        const lastBrace = buffer.lastIndexOf('{');
        if (lastBrace > 0) {
          buffer = buffer.slice(lastBrace);
        } else {
          buffer = '';
        }
      }
    });

    watcher.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) log('debug', 'Watcher stderr', { channel, msg });
    });

    watcher.on('close', (code, signal) => {
      log('warn', 'Watcher exited', { channel, code, signal });
      if (running) {
        // Restart watcher after a brief delay
        log('info', 'Restarting watcher in 5s', { channel });
        setTimeout(() => {
          if (running) {
            log('info', 'Restarting watcher', { channel });
            startWatcher(name, channel, project);
          }
        }, 5000);
      }
    });

    watcher.on('error', (err) => {
      log('error', 'Watcher spawn error', { channel, error: err.message });
    });

    watchers.push({ channel, process: watcher });
  }

  // Helper to restart a watcher (reuses the same logic)
  function startWatcher(name, channel, project) {
    const watchArgs = [...ACTOR_FLAGS, 'watch', '--channel', channel, '--events', 'task.created', '-f', 'json'];
    const watcher = spawn(ATS_BIN, watchArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';

    watcher.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let startIdx;
      while ((startIdx = buffer.indexOf('{')) !== -1) {
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < buffer.length; i++) {
          if (buffer[i] === '{') depth++;
          else if (buffer[i] === '}') {
            depth--;
            if (depth === 0) { endIdx = i; break; }
          }
        }
        if (endIdx === -1) break;
        const jsonStr = buffer.slice(startIdx, endIdx + 1);
        buffer = buffer.slice(endIdx + 1);
        try {
          const event = JSON.parse(jsonStr);
          handleWatchEvent(event, name, channel, project);
        } catch {
          log('debug', 'Failed to parse watch JSON', { channel, json: jsonStr.slice(0, 200) });
        }
      }
      if (buffer.length > 10000) {
        const lastBrace = buffer.lastIndexOf('{');
        buffer = lastBrace > 0 ? buffer.slice(lastBrace) : '';
      }
    });

    watcher.stderr.on('data', () => {});
    watcher.on('close', (code, signal) => {
      log('warn', 'Watcher exited', { channel, code, signal });
      if (running) {
        setTimeout(() => { if (running) startWatcher(name, channel, project); }, 5000);
      }
    });
    watcher.on('error', (err) => {
      log('error', 'Watcher spawn error', { channel, error: err.message });
    });

    watchers.push({ channel, process: watcher });
  }

  // Handle shutdown: kill all watchers
  const cleanupWatchers = () => {
    for (const w of watchers) {
      try { w.process.kill('SIGTERM'); } catch {}
    }
  };
  process.on('SIGTERM', cleanupWatchers);
  process.on('SIGINT', cleanupWatchers);

  // Keep alive
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        cleanupWatchers();
        resolve();
      }
    }, 1000);
  });
}

// === Handle a watch event ===
function handleWatchEvent(event, projectName, channel, project) {
  const taskId = event.id || event.uuid;
  if (!taskId) return;

  // Skip if already seen
  if (seenTaskIds.has(String(taskId))) return;
  seenTaskIds.add(String(taskId));

  // Only process pending tasks
  if (event.status && event.status !== 'pending') {
    log('debug', 'Skipping non-pending task', { taskId, status: event.status });
    return;
  }

  // Skip tasks on suffixed channels (safety check — should not happen since we only watch base channels)
  if (event.channel && event.channel.includes(':run-')) {
    log('debug', 'Skipping suffixed channel task', { taskId, channel: event.channel });
    return;
  }

  const title = event.title || 'Untitled';
  log('info', 'Watch: new task detected', { taskId, title, channel, projectName });

  // Determine attempts count
  let attempts = project.default_attempts || 1;
  if (event.payload) {
    try {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      if (payload.attempts && Number.isInteger(payload.attempts) && payload.attempts > 0) {
        attempts = payload.attempts;
      }
    } catch {}
  }

  // Fetch full task details (the watch event might not have description)
  let fullTask;
  try {
    fullTask = getTask(taskId);
  } catch (err) {
    log('error', 'Failed to fetch task details', { taskId, error: err.message });
    return;
  }
  if (!fullTask) {
    log('error', 'Task not found when fetching details', { taskId });
    return;
  }

  log('info', 'Watch: queuing task', { taskId, title, attempts, projectName });

  taskQueue.push({
    task: fullTask,
    project,
    projectName,
    attempts,
    modeOverride: null,
  });

  // Trigger queue processing
  processQueue().catch(err => {
    log('error', 'Queue processing error', { error: err.message });
  });
}

// === Dry-run preview ===
function dryRunPreview(task, project, projectName, attempts, modeOverride) {
  const origTaskId = task.id || task.uuid;
  const title = task.title || 'Untitled';
  const description = task.description || '';

  // Detect mode
  let mode, iterations;
  if (modeOverride) {
    mode = modeOverride.mode;
    iterations = modeOverride.iterations || (mode === 'oneshot' ? 1 : 8);
    iterations = Math.min(iterations, project.max_iterations || 15);
  } else {
    ({ mode, iterations } = detectMode(title, description, project));
  }

  // Build branch name
  const branchName = `task/${origTaskId}-${slugify(title)}`;

  // Build first-iteration prompt
  const prompt = `You are working on the project at ${project.repo}. Execute this task:\n\n${title}\n${description}\n\nMake progress on this task. Do NOT commit, push, or create PRs.`;

  const separator = '─'.repeat(60);

  console.log(`\n${separator}`);
  console.log(`  DRY RUN — nothing will be executed`);
  console.log(separator);
  console.log(`  Project:      ${projectName}`);
  console.log(`  Channel:      ${project.channel}`);
  console.log(`  Repo:         ${project.repo}`);
  console.log(`  GitHub:       ${project.github}`);
  console.log(`  Task ID:      ${origTaskId}`);
  console.log(`  Title:        ${title}`);
  console.log(`  Mode:         ${mode}${modeOverride ? ' (override)' : ' (auto-detected)'}`);
  console.log(`  Iterations:   ${iterations}`);
  console.log(`  Attempts:     ${attempts}`);
  console.log(`  Branch:       ${branchName}`);
  if (attempts > 1) {
    console.log(`  Run branches: ${branchName}, ${branchName}-run2`);
    if (attempts > 2) console.log(`                ... through ${branchName}-run${attempts}`);
  }
  console.log(separator);
  console.log(`  Claude prompt preview (first 500 chars):`);
  console.log();
  console.log(`  ${prompt.slice(0, 500).split('\n').join('\n  ')}`);
  if (prompt.length > 500) console.log(`  ... (${prompt.length - 500} more chars)`);
  console.log(`\n${separator}`);
  console.log(`  Would create: ATS run task on channel "${project.channel}:run-1"`);
  console.log(`  Would run:    Claude Code (${mode}, up to ${iterations} iteration${iterations > 1 ? 's' : ''})`);
  console.log(`  Would open:   PR on ${project.github} from ${branchName}`);
  console.log(separator + '\n');
}

// === Status command ===
function statusCommand() {
  const projects = Object.entries(PROJECTS);

  if (projects.length === 0) {
    console.log('No projects configured.');
    return;
  }

  // Table header
  const col = { name: 20, channel: 22, repo: 45, github: 35, pending: 9 };
  const pad = (s, w) => String(s).padEnd(w).slice(0, w);
  const separator = '─'.repeat(col.name + col.channel + col.repo + col.github + col.pending + 8);

  console.log(`\nats-project-runner v${VERSION} — Project Status\n`);
  console.log(
    `  ${pad('Project', col.name)}  ${pad('Channel', col.channel)}  ${pad('Repo Path', col.repo)}  ${pad('GitHub', col.github)}  ${pad('Pending', col.pending)}`
  );
  console.log(`  ${separator}`);

  let hasErrors = false;
  for (const [name, proj] of projects) {
    let pendingCount = '?';
    try {
      const raw = ats('list', '--channel', proj.channel, '--status', 'pending', '-f', 'json');
      // Try to parse as JSON array or count objects
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        const tasks = JSON.parse(match[0]);
        pendingCount = String(tasks.length);
      } else {
        // Count individual task JSON objects
        const taskMatches = raw.match(/\{[\s\S]*?\}/g);
        pendingCount = taskMatches ? String(taskMatches.length) : '0';
      }
    } catch (err) {
      log('warn', 'Failed to query pending tasks', { project: name, channel: proj.channel, error: err.message });
      pendingCount = 'ERR';
      hasErrors = true;
    }

    console.log(
      `  ${pad(name, col.name)}  ${pad(proj.channel, col.channel)}  ${pad(proj.repo, col.repo)}  ${pad(proj.github, col.github)}  ${pad(pendingCount, col.pending)}`
    );
  }
  console.log();
  if (hasErrors) {
    console.error('Warning: one or more channels could not be queried (see ERR above).');
    process.exit(1);
  }
}

// === CLI ===
function usage() {
  console.error(`Usage:
  node index.js run <task-id>                      Run a specific task
  node index.js run <task-id> --attempts 3         Run with multiple attempts (sequential)
  node index.js run <task-id> --mode oneshot       Force one-shot mode
  node index.js run <task-id> --mode iterative     Force iterative mode
  node index.js run <task-id> --iterations 12      Set max iterations (implies iterative)
  node index.js run <task-id> --dry-run            Preview what would happen without executing
  node index.js watch                              Watch all configured channels for new tasks
  node index.js status                             Show all projects and pending task counts
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];

  if (command === 'watch') {
    await watchMode();
    return;
  }

  if (command === 'status') {
    statusCommand();
    return;
  }

  if (command !== 'run') usage();

  const taskIdArg = args[1];
  if (!taskIdArg || !/^\d+$/.test(taskIdArg)) {
    console.error('Error: task ID must be a positive integer');
    usage();
  }
  const taskId = taskIdArg;

  // Parse flags after the task ID
  const flagArgs = args.slice(2);
  let attempts = 1;
  let modeOverride = null;

  const { values } = parseArgs({
    args: flagArgs,
    options: {
      attempts: { type: 'string', short: 'a' },
      mode: { type: 'string', short: 'm' },
      iterations: { type: 'string', short: 'i' },
      'dry-run': { type: 'boolean' },
    },
    strict: false,
  });

  const dryRun = values['dry-run'] || false;

  if (values.attempts) {
    attempts = parseInt(values.attempts, 10);
    if (isNaN(attempts) || attempts < 1) {
      console.error('Error: --attempts must be a positive integer');
      process.exit(1);
    }
  }

  if (values.mode || values.iterations) {
    const mode = values.mode || 'iterative';
    if (mode !== 'oneshot' && mode !== 'iterative') {
      console.error('Error: --mode must be "oneshot" or "iterative"');
      process.exit(1);
    }
    const iterations = values.iterations ? parseInt(values.iterations, 10) : undefined;
    if (values.iterations && (isNaN(iterations) || iterations < 1)) {
      console.error('Error: --iterations must be a positive integer');
      process.exit(1);
    }
    modeOverride = { mode, iterations };
  }

  log('info', `ats-project-runner v${VERSION} (CLI mode)`, {
    taskId,
    attempts,
    modeOverride,
    projects: Object.keys(PROJECTS),
  });

  // Dry-run mode: only validate ATS connectivity, fetch task, and preview
  if (dryRun) {
    preflight({ skipClaude: true });

    let task;
    try {
      task = getTask(taskId);
    } catch (err) {
      log('error', 'Failed to fetch task', { taskId, error: err.message });
      process.exit(1);
    }
    if (!task) {
      log('error', 'Task not found', { taskId });
      process.exit(1);
    }

    log('info', 'Fetched original task', { taskId, title: task.title, channel: task.channel, status: task.status });

    const match = findProjectByChannel(task.channel);
    if (!match) {
      log('error', 'Task channel not found in config', { taskId, channel: task.channel, configured: Object.values(PROJECTS).map(p => p.channel) });
      process.exit(1);
    }

    const { name: projectName, project } = match;
    log('info', 'Matched project', { projectName, repo: project.repo, github: project.github });

    dryRunPreview(task, project, projectName, attempts, modeOverride);
    return;
  }

  // Full preflight (includes Claude binary validation)
  preflight();

  // Fetch the original task (read-only)
  let task;
  try {
    task = getTask(taskId);
  } catch (err) {
    log('error', 'Failed to fetch task', { taskId, error: err.message });
    process.exit(1);
  }
  if (!task) {
    log('error', 'Task not found', { taskId });
    process.exit(1);
  }

  log('info', 'Fetched original task', { taskId, title: task.title, channel: task.channel, status: task.status });

  // Find which project this task belongs to
  const match = findProjectByChannel(task.channel);
  if (!match) {
    log('error', 'Task channel not found in config', { taskId, channel: task.channel, configured: Object.values(PROJECTS).map(p => p.channel) });
    process.exit(1);
  }

  const { name: projectName, project } = match;
  log('info', 'Matched project', { projectName, repo: project.repo, github: project.github });

  // Run all attempts
  const results = await runAllAttempts(task, project, projectName, attempts, modeOverride);

  const failures = results.filter(r => !r.success);
  if (failures.length === results.length) {
    process.exit(1);
  }
}

main().catch(err => {
  log('error', 'Fatal error', { error: err.message });
  process.exit(1);
});
