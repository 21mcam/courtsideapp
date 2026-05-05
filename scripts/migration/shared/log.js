// Tiny structured logger for migration scripts.
//
// We want timestamps + context on every line so post-mortem analysis
// can correlate exactly when each step happened relative to Stripe
// + DNS + read-only events. console.log without context is useless
// when reconstructing a 2am incident.

function ts() {
  return new Date().toISOString();
}

export function info(msg, ctx = {}) {
  process.stdout.write(JSON.stringify({ ts: ts(), level: 'info', msg, ...ctx }) + '\n');
}

export function warn(msg, ctx = {}) {
  process.stdout.write(JSON.stringify({ ts: ts(), level: 'warn', msg, ...ctx }) + '\n');
}

export function error(msg, ctx = {}) {
  process.stderr.write(JSON.stringify({ ts: ts(), level: 'error', msg, ...ctx }) + '\n');
}

// Banner for the start of each phase. Visible in the log stream
// during cutover.
export function banner(name) {
  const line = '='.repeat(60);
  process.stdout.write(`\n${line}\n${name}\n${line}\n`);
}
