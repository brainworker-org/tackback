// node:test — the tiny event emitter (unsubscribe + handler isolation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/core/events.js';

test('on returns an unsubscribe function', () => {
  const e = new Emitter();
  const seen = [];
  const off = e.on('x', (v) => seen.push(v));
  e.emit('x', 1);
  off();
  e.emit('x', 2);
  assert.deepEqual(seen, [1]);
});

test('a throwing handler does not break delivery to others', () => {
  const e = new Emitter();
  const seen = [];
  e.on('x', () => { throw new Error('boom'); });
  e.on('x', (v) => seen.push(v));
  // suppress the expected console.error noise
  const orig = console.error; console.error = () => {};
  e.emit('x', 42);
  console.error = orig;
  assert.deepEqual(seen, [42]);
});

test('clear drops all subscribers', () => {
  const e = new Emitter();
  let n = 0;
  e.on('x', () => n++);
  e.clear();
  e.emit('x');
  assert.equal(n, 0);
});
