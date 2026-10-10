const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getIgnoreExitCode } = require('./netlify-ignore-build.cjs');

const previous = 'a'.repeat(40);
const current = 'b'.repeat(40);
const preview = { CONTEXT: 'deploy-preview', CACHED_COMMIT_REF: previous, COMMIT_REF: current };
function assertBuildWithoutQuery(env) {
  let calls = 0;
  assert.equal(getIgnoreExitCode(env, () => { calls++; return { status: 0 }; }), 1);
  assert.equal(calls, 0);
}

test('production always builds even when cached content matches a preview', () => {
  let queried = false;
  const result = getIgnoreExitCode({ ...preview, CONTEXT: 'production' }, () => {
    queried = true;
    return { status: 0 };
  });
  assert.equal(result, 1);
  assert.equal(queried, false);
});

test('missing or malformed commit metadata always proceeds without a Git query', () => {
  for (const env of [
    {}, { COMMIT_REF: current }, { CACHED_COMMIT_REF: previous },
    { ...preview, CACHED_COMMIT_REF: '--invalid' },
    { ...preview, COMMIT_REF: 'unknown' },
  ]) {
    assertBuildWithoutQuery(env);
  }
});

test('fresh-cache builds with equal commit references always proceed', () => {
  assertBuildWithoutQuery({ ...preview, CACHED_COMMIT_REF: current });
});

test('previews with only documentation changes preserve the existing skip behavior', () => {
  const result = getIgnoreExitCode(preview, (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['diff', '--quiet', previous, current, '--', '.', ':!docs/', ':!*.md', ':!summary/']);
    assert.equal(options.stdio, 'ignore');
    return { status: 0 };
  });
  assert.equal(result, 0);
});

test('previews with application changes proceed with the build', () => {
  assert.equal(getIgnoreExitCode(preview, () => ({ status: 1 })), 1);
});

test('unknown Git refs and execution failures always proceed with the build', () => {
  for (const status of [2, 128, null]) {
    assert.equal(getIgnoreExitCode(preview, () => ({ status })), 1);
  }
  assert.equal(getIgnoreExitCode(preview, () => { throw new Error('Git unavailable'); }), 1);
});
