// Reads probe.json (written by the e2e fixture's build, as the sandbox user) and fails unless
// the sandbox kept every secret, the runner's files and the cloud metadata service out of reach.
import { readFileSync } from 'node:fs';

const probe = JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8'));
const problems = [];
const want = process.env.G2A_SANDBOX_USER;
if (want && probe.user !== want) problems.push(`build ran as ${probe.user}, not ${want}`);
if (probe.secretLikeEnv.length) problems.push(`secret-like variables reached the build: ${probe.secretLikeEnv.join(', ')}`);
for (const k of ['readCanary', 'listRunnerHome', 'cloudMetadata']) {
  if (!String(probe[k]).startsWith('denied')) problems.push(`${k} was ${probe[k]}`);
}
console.log(JSON.stringify(probe, null, 2));
if (problems.length) {
  console.error(`Sandbox check FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Sandbox check passed');
