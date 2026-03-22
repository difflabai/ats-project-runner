import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonObjects, parseHumanReadable, trimBuffer } from '../lib/watch-parser.js';

// ─── parseJsonObjects ────────────────────────────────────────────────

describe('parseJsonObjects', () => {

  it('parses a single complete JSON object', () => {
    const buffer = '{"task_id":42,"event":"task.created","title":"Fix bug"}';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 42);
    assert.equal(events[0].event, 'task.created');
    assert.equal(events[0].title, 'Fix bug');
    assert.equal(remaining, '');
  });

  it('parses multiple JSON objects in a single buffer', () => {
    const obj1 = '{"task_id":1,"event":"task.created"}';
    const obj2 = '{"task_id":2,"event":"task.created"}';
    const buffer = obj1 + '\n' + obj2;
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 2);
    assert.equal(events[0].task_id, 1);
    assert.equal(events[1].task_id, 2);
    assert.equal(remaining, '');
  });

  it('returns incomplete JSON as remaining', () => {
    const buffer = '{"task_id":42,"event":"task.cre';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 0);
    assert.equal(remaining, buffer);
  });

  it('handles complete object followed by incomplete object', () => {
    const complete = '{"task_id":1}';
    const incomplete = '{"task_id":2,"tit';
    const buffer = complete + incomplete;
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 1);
    assert.equal(remaining, incomplete);
  });

  it('handles leading non-JSON text before a valid object', () => {
    const buffer = 'Connected to server\n{"task_id":99,"event":"task.created"}';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 99);
    assert.equal(remaining, '');
  });

  it('handles nested JSON objects', () => {
    const buffer = '{"task_id":5,"payload":{"attempts":3,"meta":{"priority":"high"}}}';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 5);
    assert.deepEqual(events[0].payload, { attempts: 3, meta: { priority: 'high' } });
    assert.equal(remaining, '');
  });

  it('skips invalid JSON that has matching braces', () => {
    // Braces match but content is not valid JSON
    const buffer = '{not json at all}{"task_id":10}';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 10);
    assert.equal(remaining, '');
  });

  it('returns empty events for empty buffer', () => {
    const { events, remaining } = parseJsonObjects('');
    assert.equal(events.length, 0);
    assert.equal(remaining, '');
  });

  it('returns empty events for buffer with no braces', () => {
    const buffer = 'just some plain text with no json';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 0);
    // No braces found, so the full buffer is returned as remaining
    // (the caller — index.js — falls through to the human-readable parser)
    assert.equal(remaining, buffer);
  });

  it('handles JSON with strings containing braces', () => {
    const buffer = '{"title":"fix {issue} with curly braces","task_id":7}';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 7);
    assert.equal(events[0].title, 'fix {issue} with curly braces');
  });

  it('handles whitespace-separated JSON objects', () => {
    const buffer = '  {"task_id":1}  \n  {"task_id":2}  \n';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 2);
    assert.equal(events[0].task_id, 1);
    assert.equal(events[1].task_id, 2);
  });

  it('handles JSON with array values', () => {
    const buffer = '{"task_id":3,"tags":["urgent","fix"]}';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].tags, ['urgent', 'fix']);
  });

  it('handles JSON where closing brace is the last character', () => {
    const buffer = '{"a":1}';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 1);
    assert.equal(remaining, '');
  });

  it('handles buffer that is just an opening brace', () => {
    const buffer = '{';
    const { events, remaining } = parseJsonObjects(buffer);
    assert.equal(events.length, 0);
    assert.equal(remaining, '{');
  });
});

// ─── parseHumanReadable ──────────────────────────────────────────────

describe('parseHumanReadable', () => {

  it('parses a standard human-readable task.created event', () => {
    const buffer = [
      '[10:55:42 AM] task.created',
      '  Task #492: Fix login page bug',
      '',
    ].join('\n');
    const { events, remaining } = parseHumanReadable(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 492);
    assert.equal(events[0].title, 'Fix login page bug');
    assert.equal(events[0].event, 'task.created');
  });

  it('parses multiple human-readable events', () => {
    const buffer = [
      '[10:55:42 AM] task.created',
      '  Task #100: First task',
      '',
      '[10:56:00 AM] task.created',
      '  Task #101: Second task',
      '',
    ].join('\n');
    const { events, remaining } = parseHumanReadable(buffer);
    assert.equal(events.length, 2);
    assert.equal(events[0].task_id, 100);
    assert.equal(events[0].title, 'First task');
    assert.equal(events[1].task_id, 101);
    assert.equal(events[1].title, 'Second task');
  });

  it('returns empty events when no task.created lines present', () => {
    const buffer = 'Watching channel: my-channel\nConnected.\n';
    const { events, remaining } = parseHumanReadable(buffer);
    assert.equal(events.length, 0);
    assert.equal(remaining, buffer);
  });

  it('handles task.created line without matching Task # line', () => {
    const buffer = [
      '[10:55:42 AM] task.created',
      '  Some other format without task id',
      '',
    ].join('\n');
    const { events, remaining } = parseHumanReadable(buffer);
    assert.equal(events.length, 0);
    assert.equal(remaining, buffer);
  });

  it('handles Task # on the same line as task.created', () => {
    const buffer = 'task.created Task #200: Inline task title\nother line\n';
    const { events, remaining } = parseHumanReadable(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 200);
    assert.equal(events[0].title, 'Inline task title');
  });

  it('handles Task # on the line after task.created', () => {
    const buffer = [
      'Event: task.created',
      'Task #333: Next line title',
      'extra info',
    ].join('\n');
    const { events, remaining } = parseHumanReadable(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 333);
    assert.equal(events[0].title, 'Next line title');
  });

  it('preserves remaining buffer after consumed lines', () => {
    const buffer = [
      '[10:55:42 AM] task.created',
      '  Task #50: My task',
      '',
      'some trailing text',
    ].join('\n');
    const { events, remaining } = parseHumanReadable(buffer);
    assert.equal(events.length, 1);
    assert.equal(remaining, 'some trailing text');
  });

  it('handles empty buffer', () => {
    const { events, remaining } = parseHumanReadable('');
    assert.equal(events.length, 0);
    assert.equal(remaining, '');
  });

  it('task_id is parsed as integer', () => {
    const buffer = 'task.created\n  Task #007: Leading zeros\n\n';
    const { events } = parseHumanReadable(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 7);
    assert.equal(typeof events[0].task_id, 'number');
  });

  it('trims whitespace from title', () => {
    const buffer = 'task.created\n  Task #10:    lots of spaces   \n\n';
    const { events } = parseHumanReadable(buffer);
    assert.equal(events[0].title, 'lots of spaces');
  });
});

// ─── trimBuffer ──────────────────────────────────────────────────────

describe('trimBuffer', () => {

  it('returns buffer unchanged when under max length', () => {
    const buffer = '{"task_id":1}';
    assert.equal(trimBuffer(buffer, 10000), buffer);
  });

  it('returns buffer unchanged when exactly at max length', () => {
    const buffer = 'x'.repeat(10000);
    assert.equal(trimBuffer(buffer, 10000), buffer);
  });

  it('trims to last opening brace when over max length', () => {
    const prefix = 'x'.repeat(9990);
    const jsonPart = '{"task_id":1}';
    const buffer = prefix + jsonPart;
    const result = trimBuffer(buffer, 10000);
    assert.equal(result, jsonPart);
  });

  it('clears buffer entirely when no brace found and over limit', () => {
    const buffer = 'x'.repeat(10001);
    assert.equal(trimBuffer(buffer, 10000), '');
  });

  it('handles buffer with brace only at position 0 over limit', () => {
    // lastIndexOf('{') returns 0, which is not > 0, so buffer clears
    const buffer = '{' + 'x'.repeat(10000);
    assert.equal(trimBuffer(buffer, 10000), '');
  });

  it('uses default max length of 10000', () => {
    const buffer = 'x'.repeat(9999);
    assert.equal(trimBuffer(buffer), buffer);
  });
});

// ─── Integration: JSON then fallback ─────────────────────────────────

describe('integration: JSON-first with human-readable fallback', () => {

  it('JSON parser handles JSON output, no need for fallback', () => {
    const buffer = '{"task_id":42,"event":"task.created","title":"Fix it"}';
    const json = parseJsonObjects(buffer);
    assert.equal(json.events.length, 1);
    // No need to call parseHumanReadable
  });

  it('JSON parser returns nothing for text, fallback picks it up', () => {
    const buffer = '[10:55:42 AM] task.created\n  Task #42: Fix it\n';
    const json = parseJsonObjects(buffer);
    assert.equal(json.events.length, 0);
    // Fallback
    const text = parseHumanReadable(buffer);
    assert.equal(text.events.length, 1);
    assert.equal(text.events[0].task_id, 42);
  });

  it('mixed buffer: JSON object followed by human-readable text', () => {
    const buffer = '{"task_id":1,"event":"task.created"}\n[11:00:00 AM] task.created\n  Task #2: Second\n';
    const json = parseJsonObjects(buffer);
    assert.equal(json.events.length, 1);
    assert.equal(json.events[0].task_id, 1);
    // Since JSON was found, fallback should not be needed, but remaining has the text
    // In the real code, fallback only runs if foundJson is false
  });

  it('simulates the full buffer processing pipeline', () => {
    // Simulate what index.js does: try JSON first, fallback if no JSON found
    function processBuffer(buffer) {
      const jsonResult = parseJsonObjects(buffer);
      if (jsonResult.events.length > 0) {
        return { events: jsonResult.events, remaining: jsonResult.remaining, source: 'json' };
      }
      // No JSON found, try human-readable fallback
      const textResult = parseHumanReadable(buffer);
      if (textResult.events.length > 0) {
        return { events: textResult.events, remaining: textResult.remaining, source: 'text' };
      }
      return { events: [], remaining: buffer, source: 'none' };
    }

    // JSON input
    const r1 = processBuffer('{"task_id":10,"event":"task.created"}');
    assert.equal(r1.source, 'json');
    assert.equal(r1.events[0].task_id, 10);

    // Human-readable input
    const r2 = processBuffer('[12:00:00 PM] task.created\n  Task #20: Do stuff\n');
    assert.equal(r2.source, 'text');
    assert.equal(r2.events[0].task_id, 20);

    // Garbage input
    const r3 = processBuffer('Connected to ATS server...\nWaiting for events.\n');
    assert.equal(r3.source, 'none');
    assert.equal(r3.events.length, 0);
  });
});

// ─── Streaming simulation ────────────────────────────────────────────

describe('streaming: incremental buffer accumulation', () => {

  it('handles JSON split across multiple chunks', () => {
    const chunks = ['{"task_id":', '42,"event":', '"task.created"}'];
    let buffer = '';
    let allEvents = [];

    for (const chunk of chunks) {
      buffer += chunk;
      const { events, remaining } = parseJsonObjects(buffer);
      allEvents.push(...events);
      buffer = remaining;
    }

    assert.equal(allEvents.length, 1);
    assert.equal(allEvents[0].task_id, 42);
    assert.equal(buffer, '');
  });

  it('handles multiple JSON objects arriving in small chunks', () => {
    const full = '{"id":1}{"id":2}{"id":3}';
    const chunkSize = 5;
    let buffer = '';
    let allEvents = [];

    for (let i = 0; i < full.length; i += chunkSize) {
      buffer += full.slice(i, i + chunkSize);
      const { events, remaining } = parseJsonObjects(buffer);
      allEvents.push(...events);
      buffer = remaining;
    }

    assert.equal(allEvents.length, 3);
    assert.equal(allEvents[0].id, 1);
    assert.equal(allEvents[1].id, 2);
    assert.equal(allEvents[2].id, 3);
    assert.equal(buffer, '');
  });

  it('handles human-readable event split across chunks', () => {
    const chunk1 = '[10:55:42 AM] task.created\n';
    const chunk2 = '  Task #500: Test json watch\n';
    let buffer = '';
    let allEvents = [];

    buffer += chunk1;
    let result = parseHumanReadable(buffer);
    allEvents.push(...result.events);
    // First chunk alone won't have the Task # line yet, but the regex looks
    // at a 3-line window — it might not match yet. Depends on buffer state.
    // In any case, accumulate.
    if (result.events.length === 0) {
      // Keep full buffer
    } else {
      buffer = result.remaining;
    }

    buffer += chunk2;
    result = parseHumanReadable(buffer);
    allEvents.push(...result.events);
    buffer = result.remaining;

    assert.equal(allEvents.length, 1);
    assert.equal(allEvents[0].task_id, 500);
    assert.equal(allEvents[0].title, 'Test json watch');
  });
});
