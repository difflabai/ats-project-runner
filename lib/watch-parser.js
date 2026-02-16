/**
 * Watch mode parsers — extracted for testability.
 *
 * parseJsonObjects(buffer) - Extract JSON objects from a raw stdout buffer.
 * parseHumanReadable(buffer) - Fallback: extract task.created events from
 *   human-readable ATS watch output.
 */

/**
 * Attempt to extract one or more complete JSON objects from `buffer`.
 *
 * Returns { events: [ parsed objects ], remaining: unprocessed buffer tail }.
 */
export function parseJsonObjects(buffer) {
  const events = [];
  let pos = 0;

  while (true) {
    const startIdx = buffer.indexOf('{', pos);
    if (startIdx === -1) break;

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

    if (endIdx === -1) {
      // Incomplete JSON — return everything from startIdx onward as remaining
      return { events, remaining: buffer.slice(startIdx) };
    }

    const jsonStr = buffer.slice(startIdx, endIdx + 1);
    pos = endIdx + 1;

    try {
      events.push(JSON.parse(jsonStr));
    } catch {
      // Not valid JSON, skip this candidate and keep scanning
    }
  }

  // Everything was consumed (or no braces found at all)
  return { events, remaining: buffer.slice(pos) };
}

/**
 * Parse human-readable ATS watch output.
 *
 * Looks for lines containing "task.created" followed by a line matching
 * "Task #<id>: <title>".
 *
 * Returns { events: [ { task_id, title, event } ], remaining: unprocessed tail }.
 */
export function parseHumanReadable(buffer) {
  const events = [];
  const lines = buffer.split('\n');
  const consumedIndices = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (consumedIndices.has(i)) continue;
    if (/task\.created/.test(lines[i])) {
      const window = lines.slice(i, i + 3).join('\n');
      const taskMatch = window.match(/Task #(\d+):\s*(.+)/);
      if (taskMatch) {
        events.push({
          task_id: parseInt(taskMatch[1], 10),
          title: taskMatch[2].trim(),
          event: 'task.created',
        });
        consumedIndices.add(i);
        consumedIndices.add(i + 1);
        consumedIndices.add(i + 2);
      }
    }
  }

  if (consumedIndices.size === 0) {
    return { events, remaining: buffer };
  }

  const lastConsumed = Math.max(...consumedIndices);
  const remaining = lines.slice(lastConsumed + 1).join('\n');
  return { events, remaining };
}

/**
 * Trim an oversized buffer to avoid unbounded memory growth.
 * Keeps content from the last '{' onward, or clears the buffer entirely.
 */
export function trimBuffer(buffer, maxLength = 10000) {
  if (buffer.length <= maxLength) return buffer;
  const lastBrace = buffer.lastIndexOf('{');
  return lastBrace > 0 ? buffer.slice(lastBrace) : '';
}
