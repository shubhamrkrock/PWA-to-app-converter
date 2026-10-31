import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, transition, isTerminal, failureFor, BUILD_STAGES } from '../packages/shared/src/build-state.ts';
import { redact, redactLine } from '../packages/shared/src/redact.ts';

test('build state: happy path walks every stage forward by one', () => {
  let s: (typeof BUILD_STAGES)[number] | string = 'CREATED';
  for (const next of BUILD_STAGES.slice(1)) s = transition(s as never, next);
  assert.equal(s, 'COMPLETED');
  assert.equal(isTerminal('COMPLETED'), true);
});

test('build state: skipping a stage or going back throws', () => {
  assert.throws(() => transition('QUEUED', 'WEB_BUILD'), /Illegal/);
  assert.throws(() => transition('SIGNING', 'WEB_BUILD'), /Illegal/);
});

test('build state: a stage fails only into its own failure', () => {
  assert.equal(canTransition('WEB_BUILD', 'FAILED_WEB_BUILD'), true);
  assert.equal(canTransition('WEB_BUILD', 'FAILED_SIGNING'), false);
  assert.equal(failureFor('SIGNING'), 'FAILED_SIGNING');
});

test('build state: cancel from any live stage; terminal states never move', () => {
  assert.equal(canTransition('PLATFORM_COMPILATION', 'CANCELLED'), true);
  assert.equal(canTransition('COMPLETED', 'CANCELLED'), false);
  assert.equal(canTransition('FAILED_WEB_BUILD', 'QUEUED'), false);
});

test('redact: known secrets and token shapes never survive', () => {
  const line = 'push with ghs_abcdefghijklmnopqrstuvwxyz0123 and pass hunter22secret';
  const out = redactLine(line, ['hunter22secret']);
  assert.doesNotMatch(out, /ghs_|hunter22secret/);
  assert.match(out, /\[REDACTED\]/);
});

test('redact: PEM private keys across lines are removed', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
  // per-line redaction cannot see a multi-line PEM; the runner redacts whole chunks too
  const chunk = redactLine(pem);
  assert.doesNotMatch(chunk, /MIIabc/);
  assert.equal(redact('ok line'), 'ok line');
});
