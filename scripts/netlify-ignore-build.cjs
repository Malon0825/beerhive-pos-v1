const { spawnSync } = require('node:child_process');

/** Netlify: exit 0 skips a build; exit 1 proceeds with the build. */
function getIgnoreExitCode(env = process.env, runGit = spawnSync) {
  const cached = env.CACHED_COMMIT_REF;
  const current = env.COMMIT_REF;
  const isCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

  // A cached build is not proof that a release was published to production.
  // Without cache, Netlify also sets CACHED_COMMIT_REF equal to COMMIT_REF.
  if (env.CONTEXT === 'production' || !isCommit(cached) || !isCommit(current) || cached === current) {
    return 1;
  }

  try {
    const diff = runGit('git', [
      'diff', '--quiet', cached, current, '--', '.',
      ':!docs/', ':!*.md', ':!summary/',
    ], { stdio: 'ignore' });
    // Unknown refs or a failed Git process must never suppress a build.
    return diff.status === 0 ? 0 : 1;
  } catch {
    return 1;
  }
}

module.exports = { getIgnoreExitCode };

if (require.main === module) process.exitCode = getIgnoreExitCode();
