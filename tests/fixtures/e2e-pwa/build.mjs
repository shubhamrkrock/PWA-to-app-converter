// Copies src/ to dist/ and records what the build could reach. The build runs as the sandbox
// user; the e2e workflow reads probe.json from inside the APK and fails if anything leaked.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';

const tryIt = (fn) => {
  try {
    fn();
    return 'allowed';
  } catch (e) {
    return `denied (${e.code ?? e.name})`;
  }
};
async function net(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return 'allowed';
  } catch (e) {
    return `denied (${e.cause?.code ?? e.name})`;
  }
}

const probe = {
  user: userInfo().username,
  secretLikeEnv: Object.keys(process.env).filter((k) => /TOKEN|SECRET|PASSWORD|ACTIONS_|RUNNER_|GITHUB_|INPUT_|G2A_TICKET/i.test(k)).sort(),
  readCanary: tryIt(() => readFileSync('/tmp/g2a-canary/secret.txt')),
  listRunnerHome: tryIt(() => readdirSync('/home/runner')),
  cloudMetadata: await net('http://169.254.169.254/metadata/instance?api-version=2021-02-01'),
};
mkdirSync('dist', { recursive: true });
cpSync('src', 'dist', { recursive: true });
writeFileSync('dist/probe.json', JSON.stringify(probe, null, 2));
console.log('probe', JSON.stringify(probe));
