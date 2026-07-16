// Error-handler hardening tests.
//
// Regression for the stack-trace leak: the handler used to include
// `stack` (with absolute server paths) in every 500 response unless
// NODE_ENV was exactly 'production'. Railway ran with NODE_ENV unset,
// so production responses leaked internals. The handler now fails
// closed — stacks only appear when NODE_ENV === 'development'.
//
// These tests run with NODE_ENV unset (the node --test default),
// i.e. exactly the misconfigured state that leaked before the fix.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

const { app } = await import('../src/app.js');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('malformed JSON body → 400, no stack, no internal message', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid JSON body');
  assert.equal(body.stack, undefined, 'stack must never leak to clients');
});

test('500 responses do not include a stack when NODE_ENV is unset', async () => {
  assert.notEqual(process.env.NODE_ENV, 'development');
  // Trigger the generic error path: withTenantContext is skipped for
  // this URL shape, but a Host header with no subdomain suffix yields
  // a 404 from resolveTenant, so instead force an error by sending a
  // body to an endpoint whose zod-parse throws deeper. Simplest
  // deterministic 500: hit the error handler via malformed JSON on a
  // second content-type variant that bypasses the 400 mapping is not
  // available — so this test asserts the contract on the JSON 404 and
  // 400 paths, and unit-asserts the handler directly below.
  const res = await fetch(`${baseUrl}/api/definitely-not-a-route`, {
    headers: { Host: 'localhost' },
  });
  // /api fallthrough is a JSON 404 with no internals.
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['error']);
});

test('error handler unit: hides stack unless NODE_ENV === development', async () => {
  // Grab the mounted error handler (last layer with 4-arity handle).
  const layers = app._router.stack.filter((l) => l.handle.length === 4);
  assert.ok(layers.length >= 1, 'expected an error-handling layer');
  const handler = layers[layers.length - 1].handle;

  function runHandler() {
    return new Promise((resolve) => {
      const err = new Error('boom');
      const res = {
        statusCode: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
      };
      handler(err, {}, res, () => resolve(null));
    });
  }

  const prev = process.env.NODE_ENV;
  try {
    delete process.env.NODE_ENV;
    let out = await runHandler();
    assert.equal(out.status, 500);
    assert.equal(out.body.stack, undefined, 'unset NODE_ENV must not leak stack');
    assert.equal(out.body.error, 'internal server error');

    process.env.NODE_ENV = 'production';
    out = await runHandler();
    assert.equal(out.body.stack, undefined, 'production must not leak stack');

    process.env.NODE_ENV = 'development';
    out = await runHandler();
    assert.ok(out.body.stack, 'development keeps the debugging stack');
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});
