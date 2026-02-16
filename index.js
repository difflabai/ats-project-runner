#!/usr/bin/env node

import { execFileSync, execFile, spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import https from 'node:https';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Watch reconnection
const WATCH_RECONNECT_BASE_MS = 2000;
const WATCH_RECONNECT_MAX_MS = 60000;

// Mode detection keywords
const ONESHOT_KEYWORDS = ['fix typo', 'update version', 'rename', 'bump', 'typo', 'version bump'];
const ITERATIVE_KEYWORDS = ['add', 'implement', 'refactor', 'debug', 'investigate', 'build', 'create', 'feature'];

let running = true;
let currentTask = null;  // { taskId, child, project }
const taskQueue = [];     // queued tasks waiting to run

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

function atsJSON(...args) {
  const raw = ats(...args, '-f', 'json');
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch { return []; }
  }
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { return null; }
  }
  return [];
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

function listPending(channel) {
  const tasks = atsJSON('list', '--channel', channel, '--status', 'pending');
  return Array.isArray(tasks) ? tasks : [];
}

// === Suffixed channel task ===
function createRunTask(title, channel, runNumber) {
  const suffixedChannel = `${channel}:run-${runNumber}`;
  const raw = ats('create', `Working: ${title}`, '--channel', suffixedChannel, '-f', 'json');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // Fallback: parse task ID from text output
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

  // Check for one-shot keywords
  for (const kw of ONESHOT_KEYWORDS) {
    if (text.includes(kw)) {
      return { mode: 'oneshot', iterations: 1 };
    }
  }

  // Check for iterative keywords
  let iterations = 8;
  let isIterative = false;
  for (const kw of ITERATIVE_KEYWORDS) {
    if (text.includes(kw)) {
      isIterative = true;
      break;
    }
  }

  if (!isIterative) {
    // Default: one-shot for short tasks, iterative for longer ones
    if ((description || '').length > 300) {
      isIterative = true;
    } else {
      return { mode: 'oneshot', iterations: 1 };
    }
  }

  // Adjust iterations
  if ((description || '').length > 500) iterations += 3;

  // Check if repo has test suite
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

// === Main task processing pipeline ===
async function processTask(task, project, projectName) {
  const taskId = task.id || task.uuid;
  const title = task.title || 'Untitled';
  const description = task.description || '';
  const repoPath = project.repo;
  const githubRepo = project.github;

  log('info', 'Processing task', { taskId, title, projectName, repoPath });

  // 1. Claim the original task
  try {
    claimTask(taskId);
    postMessage(taskId, 'ATS Project Runner picked up this task');
    telegram(`🚀 <b>Project Runner</b> picked up task on <b>${projectName}</b>\nTask: ${title} (#${taskId})`);
  } catch (err) {
    log('error', 'Failed to claim task', { taskId, error: err.message });
    return;
  }

  // 2. Create suffixed run task
  let runTaskId = null;
  let runNumber = 1;
  try {
    runTaskId = createRunTask(title, project.channel, runNumber);
    if (runTaskId) {
      log('info', 'Created run task', { runTaskId, channel: `${project.channel}:run-${runNumber}` });
      postMessage(taskId, `Execution tracking on task #${runTaskId}`);
    }
  } catch (err) {
    log('warn', 'Failed to create run task', { error: err.message });
  }

  const postRun = (msg) => {
    if (runTaskId) {
      try { postMessage(runTaskId, msg); } catch {}
    }
  };

  // 3. Lease renewal heartbeat
  const renewInterval = setInterval(() => {
    try {
      claimTask(taskId); // re-claim to renew lease
      postMessage(taskId, 'Agent still processing (heartbeat)');
      postRun('Heartbeat — still running');
    } catch (err) {
      log('warn', 'Heartbeat failed', { taskId, error: err.message });
    }
  }, LEASE_MS / 4);

  try {
    // 4. Git setup: checkout main, pull, create branch
    log('info', 'Setting up git branch', { repoPath });
    postRun('Setting up git branch');

    // Determine default branch
    let defaultBranch = 'main';
    try {
      const ref = git(repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD');
      defaultBranch = ref.replace('refs/remotes/origin/', '');
    } catch {
      // Try common names
      try { git(repoPath, 'rev-parse', '--verify', 'origin/main'); defaultBranch = 'main'; }
      catch { try { git(repoPath, 'rev-parse', '--verify', 'origin/master'); defaultBranch = 'master'; } catch {} }
    }

    git(repoPath, 'checkout', defaultBranch);
    git(repoPath, 'pull', '--ff-only');

    const branchName = `task/${taskId}-${slugify(title)}`;
    git(repoPath, 'checkout', '-b', branchName);
    log('info', 'Created branch', { branchName });
    postRun(`Created branch: ${branchName}`);

    // 5. Detect mode
    const { mode, iterations } = detectMode(title, description, project);
    log('info', 'Mode detected', { mode, iterations, taskId });
    postRun(`Mode: ${mode}, max iterations: ${iterations}`);
    postMessage(taskId, `Running in ${mode} mode (up to ${iterations} iterations)`);

    // 6. Run Claude Code
    let totalIterations = 0;
    let lastOutput = '';
    let cancelledByShutdown = false;

    const onShutdown = () => {
      cancelledByShutdown = true;
      if (currentTask?.child) {
        log('info', 'Killing Claude due to shutdown', { taskId });
        currentTask.child.kill('SIGTERM');
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
          prompt = `You are working on the project at ${repoPath}. Execute this task:\n\n${title}\n${description}\n\nMake progress on this task. Do NOT commit, push, or create PRs.`;
        } else {
          prompt = `Continue working on the task: ${title}. Review changes so far, run tests if available, fix issues. When the task is fully complete and tests pass, respond with exactly 'TASK_COMPLETE' on its own line. Do NOT commit, push, or create PRs.`;
        }

        log('info', `Claude iteration ${i + 1}/${iterations}`, { taskId, mode });
        postRun(`Iteration ${i + 1}/${iterations}`);

        const { promise, child } = runClaude(prompt, repoPath);
        currentTask = { taskId, child, project: projectName };

        lastOutput = await promise;

        // Check for TASK_COMPLETE signal (iterative mode)
        if (mode === 'iterative' && i > 0 && lastOutput.includes('TASK_COMPLETE')) {
          log('info', 'Claude signaled TASK_COMPLETE', { taskId, iteration: i + 1 });
          postRun(`Claude signaled TASK_COMPLETE at iteration ${i + 1}`);
          break;
        }
      }
    } finally {
      process.removeListener('SIGTERM', onShutdown);
      process.removeListener('SIGINT', onShutdown);
      currentTask = null;
    }

    if (cancelledByShutdown) {
      log('info', 'Task interrupted by shutdown', { taskId });
      clearInterval(renewInterval);
      return; // Don't fail — let the task be retried on restart
    }

    // 7. Commit & push if there are changes
    let prUrl = null;
    if (hasChanges(repoPath)) {
      postRun('Committing changes');
      git(repoPath, 'add', '-A');

      const commitMsg = `task/${taskId}: ${title}`;
      git(repoPath, 'commit', '-m', commitMsg);
      log('info', 'Committed changes', { taskId, branchName });

      postRun('Pushing branch');
      git(repoPath, 'push', '-u', 'origin', branchName);
      log('info', 'Pushed branch', { taskId, branchName });

      // Create PR
      postRun('Creating pull request');
      try {
        const prBody = `## ATS Task #${taskId}\n\n${description}\n\n---\nMode: ${mode} | Iterations: ${totalIterations}\nGenerated by ATS Project Runner`;
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

        // gh pr create outputs the PR URL
        prUrl = prOutput.split('\n').pop().trim();
        log('info', 'PR created', { taskId, prUrl });
        postRun(`PR created: ${prUrl}`);
      } catch (err) {
        log('error', 'Failed to create PR', { taskId, error: err.message, stderr: err.stderr });
        postRun(`PR creation failed: ${err.message}`);
      }
    } else {
      log('info', 'No changes to commit', { taskId });
      postRun('No changes were made');
    }

    // 8. Complete tasks
    const outputs = {
      pr_url: prUrl,
      branch: branchName,
      mode,
      iterations: totalIterations,
    };

    if (runTaskId) {
      try { completeTask(runTaskId, outputs); } catch {}
    }

    completeTask(taskId, outputs);
    log('info', 'Task completed', { taskId, outputs });

    if (prUrl) {
      telegram(`✅ <b>PR opened</b> on <b>${projectName}</b>\nTask: ${title} (#${taskId})\n${prUrl}`);
    } else {
      telegram(`✅ <b>Task done</b> on <b>${projectName}</b> (no changes)\nTask: ${title} (#${taskId})`);
    }

  } catch (err) {
    log('error', 'Task processing failed', { taskId, error: err.message });
    postRun(`Failed: ${err.message}`);

    if (runTaskId) {
      try { failTask(runTaskId, err.message); } catch {}
    }

    try { failTask(taskId, err.message); } catch {}
    telegram(`❌ <b>Failed</b> on <b>${projectName}</b>\nTask: ${title} (#${taskId})\n${err.message.slice(0, 200)}`);

    // Clean up: try to get back to default branch
    try { git(repoPath, 'checkout', '-'); } catch {}
  } finally {
    clearInterval(renewInterval);
  }

  // Process next queued task
  processQueue();
}

// === Task queue (concurrency = 1) ===
function enqueue(task, project, projectName) {
  const taskId = task.id || task.uuid;

  // Don't queue if already queued or running
  if (currentTask?.taskId === taskId) return;
  if (taskQueue.some(q => (q.task.id || q.task.uuid) === taskId)) return;

  if (currentTask) {
    log('info', 'Task queued (runner busy)', { taskId, title: task.title, projectName });
    taskQueue.push({ task, project, projectName });
    return;
  }

  // Run immediately
  processTask(task, project, projectName);
}

function processQueue() {
  if (!running || currentTask || taskQueue.length === 0) return;
  const next = taskQueue.shift();
  processTask(next.task, next.project, next.projectName);
}

// === Channel → project lookup ===
function findProjectByChannel(channel) {
  for (const [name, proj] of Object.entries(PROJECTS)) {
    if (proj.channel === channel) return { name, project: proj };
  }
  return null;
}

// === Event handler ===
function handleEvent(event) {
  if (event.type !== 'task.created') return;

  const taskId = event.task_id || event.data?.id || event.data?.task_id;
  const channel = event.channel || event.data?.channel;

  if (!taskId) {
    log('warn', 'task.created event missing task_id', { event });
    return;
  }

  log('info', 'Received task.created event', { taskId, channel });

  let task;
  try {
    task = getTask(taskId);
  } catch (err) {
    log('error', 'Failed to fetch task', { taskId, error: err.message });
    return;
  }
  if (!task) {
    log('warn', 'Task not found', { taskId });
    return;
  }

  if (task.status !== 'pending') {
    log('debug', 'Task not pending, skipping', { taskId, status: task.status });
    return;
  }

  // Determine which project this task belongs to
  const taskChannel = task.channel || channel;
  const match = findProjectByChannel(taskChannel);
  if (!match) {
    log('debug', 'Task channel not in config, ignoring', { taskId, channel: taskChannel });
    return;
  }

  enqueue(task, match.project, match.name);
}

// === WebSocket watchers ===
function startWatch() {
  const channels = Object.values(PROJECTS).map(p => p.channel);
  if (channels.length === 0) {
    log('warn', 'No project channels configured');
    return;
  }

  // Start one watch process per channel (ats watch only supports one --channel at a time)
  for (const channel of channels) {
    startChannelWatch(channel);
  }
}

function startChannelWatch(channel) {
  let reconnectDelay = WATCH_RECONNECT_BASE_MS;

  function launchWatch() {
    if (!running) return;

    const args = [...ACTOR_FLAGS, 'watch', '--channel', channel, '--events', 'task.created'];
    log('info', 'Starting ATS watch', { channel, args: [ATS_BIN, ...args].join(' ') });

    const child = spawn(ATS_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Connecting') || trimmed.startsWith('✓') || trimmed.startsWith('Watching')) return;

      try {
        const event = JSON.parse(trimmed);
        // Inject channel for routing
        if (!event.channel) event.channel = channel;
        reconnectDelay = WATCH_RECONNECT_BASE_MS;
        try { handleEvent(event); } catch (err) { log('error', 'Event handler error', { error: err.message, channel }); }
        return;
      } catch {}

      // Fallback: parse "Task #123:" format
      const clean = trimmed.replace(/\x1b\[[0-9;]*m/g, '');
      const taskMatch = clean.match(/^Task #(\d+):/);
      if (taskMatch) {
        const taskId = taskMatch[1];
        reconnectDelay = WATCH_RECONNECT_BASE_MS;
        log('info', 'Watch detected task', { taskId, channel, line: clean });
        try { handleEvent({ type: 'task.created', task_id: taskId, channel }); } catch (err) { log('error', 'Event handler error', { error: err.message }); }
        return;
      }

      log('debug', 'Watch line', { channel, line: clean });
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log('debug', 'Watch stderr', { channel, text });
    });

    child.on('close', (code) => {
      if (!running) return;
      log('warn', 'Watch process exited', { channel, code, reconnectMs: reconnectDelay });
      setTimeout(launchWatch, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, WATCH_RECONNECT_MAX_MS);
    });

    child.on('error', (err) => {
      log('error', 'Watch process error', { channel, error: err.message });
    });

    const killWatch = () => child.kill('SIGTERM');
    process.on('SIGTERM', killWatch);
    process.on('SIGINT', killWatch);
  }

  launchWatch();
}

// === Preflight ===
function preflight() {
  for (const check of [{ name: 'ats', bin: ATS_BIN }, { name: 'claude', bin: CLAUDE_BIN }]) {
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
  if (currentTask?.child) {
    log('info', 'Killing active Claude process', { taskId: currentTask.taskId });
    currentTask.child.kill('SIGTERM');
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// === Main ===
function main() {
  const channelList = Object.values(PROJECTS).map(p => p.channel);

  log('info', 'ats-project-runner v1.0.0 starting', {
    projects: Object.keys(PROJECTS),
    channels: channelList,
    leaseMs: LEASE_MS,
    claudeTimeoutMs: CLAUDE_TIMEOUT_MS,
    atsBin: ATS_BIN,
    claudeBin: CLAUDE_BIN,
  });

  preflight();

  // Drain pending tasks across all channels
  log('info', 'Draining pending tasks across all channels');
  for (const [name, project] of Object.entries(PROJECTS)) {
    try {
      const pending = listPending(project.channel);
      if (pending.length > 0) {
        log('info', 'Found pending tasks to drain', { channel: project.channel, count: pending.length });
        for (const task of pending) {
          if (!running) break;
          enqueue(task, project, name);
        }
      }
    } catch (err) {
      log('warn', 'Error draining channel', { channel: project.channel, error: err.message });
    }
  }

  startWatch();
  log('info', 'All watchers started, listening for tasks');
}

try {
  main();
} catch (err) {
  log('error', 'Fatal error', { error: err.message });
  process.exit(1);
}
