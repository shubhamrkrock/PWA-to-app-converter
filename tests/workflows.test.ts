// Security invariants of the build-worker workflows, checked as text (no YAML dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const wf = (n: string) => readFileSync(`.github/workflows/${n}`, 'utf8');
const job = (text: string, name: string) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} missing`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

for (const name of ['g2a-job.yml', 'g2a-ios.yml']) {
  test(`${name}: dispatch-only, ids as inputs, API origin pinned to a repository variable`, () => {
    const t = wf(name);
    assert.match(t, /^on:\n  workflow_dispatch:\n/m);
    assert.doesNotMatch(t, /pull_request|push:|schedule:/);
    assert.match(t, /API: \$\{\{ vars\.G2A_API_ORIGIN \}\}/);
    assert.match(t, /"\$API_INPUT" == "\$API"/);
    assert.doesNotMatch(t, /\$\{\{\s*secrets\./, 'workers hold no repository secrets; keys come from the API');
  });

  test(`${name}: only the signing job is in the g2a-signing environment, and it runs no repository code`, () => {
    const t = wf(name);
    assert.doesNotMatch(job(t, 'run'), /environment:/);
    const sign = job(t, 'sign');
    assert.match(sign, /environment: g2a-signing/);
    assert.match(sign, /needs: run/);
    assert.match(sign, /g2a-runner\.ts sign /);
    assert.doesNotMatch(sign, /g2a-runner\.ts (build|local|analysis)|npm run|npm install |npm ci(?! --ignore-scripts)/);
  });
}

test('every workflow checks out without persisting the GitHub token, and installs without scripts', () => {
  for (const f of readdirSync('.github/workflows')) {
    const t = wf(f);
    const checkouts = t.match(/uses: actions\/checkout@\S+/g) ?? [];
    const persisted = t.match(/persist-credentials: false/g) ?? [];
    assert.equal(persisted.length, checkouts.length, f);
    for (const m of t.match(/npm ci[^\n]*/g) ?? []) assert.match(m, /--ignore-scripts/, `${f}: ${m}`);
    assert.match(t, /^permissions:\n  contents: read\n/m, `${f}: read-only default token`);
  }
});

test('the Linux worker sets up the sandbox before running a build', () => {
  const t = job(wf('g2a-job.yml'), 'run');
  assert.ok(t.indexOf('scripts/worker/setup-linux.sh') > 0);
  assert.ok(t.indexOf('scripts/worker/setup-linux.sh') < t.indexOf('g2a-runner.ts "$JOB_KIND"'));
});
