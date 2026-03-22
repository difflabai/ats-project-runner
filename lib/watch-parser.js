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
  let scanPos = 0;     // where to search for the next '{'
  let consumedPos = 0; // end of the last successfully parsed JSON object

  while (true) {
    const startIdx = buffer.indexOf('{', scanPos);
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
    scanPos = endIdx + 1;

    try {
      events.push(JSON.parse(jsonStr));
      consumedPos = endIdx + 1;
    } catch {
      // Not valid JSON, skip this candidate and keep scanning.
      // consumedPos is NOT advanced so the text is preserved for
      // downstream parsers (e.g. parseHumanReadable).
    }
  }

  // If no JSON events were parsed, preserve the original buffer so downstream
  // parsers (e.g. parseHumanReadable) can still process the full text.
  if (events.length === 0) {
    return { events, remaining: buffer };
  }
  return { events, remaining: buffer.slice(consumedPos) };
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
        // Only consume following lines if the Task# match wasn't on the trigger line itself.
        const matchOffset = window.indexOf(taskMatch[0]);
        const linesBeforeMatch = window.slice(0, matchOffset).split('\n').length - 1;
        for (let j = 1; j <= linesBeforeMatch; j++) {
          consumedIndices.add(i + j);
        }
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
