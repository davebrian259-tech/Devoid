// Test double for the failure path only: an "engine" whose self-test fails.
process.stdin.resume();
process.stdin.on('end', () => { console.log(JSON.stringify({ ok: false, error: { code: 'selftest_failed', message: 'self-test failed', details: null } })); process.exit(1); });
