import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const ci = parse(read('workflows/ci.yml'));

// The root gate uses --if-present. Keep the accepted command shape narrow so
// an echo, ESLint information flag, or shell operator cannot silently pass it.
// Expand this guard when a workspace intentionally needs a different command.
const lintScriptProblem = (script) => {
  if (typeof script !== 'string' || script.trim() === '') return 'the lint script is empty';
  if (/[;&|\n`$<>]/.test(script)) return 'the lint script contains a shell operator';
  const tokens = script.trim().split(/\s+/).map((token) => token.replace(/^["']|["']$/g, ''));
  if (tokens[0] === 'npx') tokens.shift();
  if (tokens.shift() !== 'eslint') return 'the lint script never runs eslint';
  const targets = tokens.filter((token) => token !== '--max-warnings=0');
  if (!targets.some((token) => !token.startsWith('-'))) return 'the eslint run lints no files';
  if (!tokens.includes('--max-warnings=0')) return 'the eslint run does not pass --max-warnings=0';
  if (targets.some((token) => token.startsWith('-') || !/^[\w./*{}?,!-]+$/.test(token))) {
    return 'the eslint run has unsupported arguments';
  }
  return null;
};

// The lint gate of one workspace, checked against a manifest-like object.
const assertRealLintScript = (label, manifest) => {
  const script = manifest?.scripts?.lint;
  assert.ok(
    typeof script === 'string' && script.trim() !== '',
    `${label} needs a lint script for the root lint gate`
  );
  const problem = lintScriptProblem(script);
  assert.equal(
    problem,
    null,
    `${label} needs a lint script that runs eslint over files with --max-warnings=0: ${problem}`
  );
};

test('both CI test jobs run workspace tests after shared is built', () => {
  for (const name of ['build-test', 'cross-platform']) {
    const steps = ci.jobs[name].steps;
    const build = steps.findIndex((step) => step.name === 'Build');
    assert.ok(build >= 0);
    assert.ok(steps.findIndex((step) => step.run === 'npm test -w designer-ui -w runtime-next') > build);
  }
});

test('the root lint and coverage gates reach every workspace', () => {
  const root = JSON.parse(read('../package.json'));
  assert.equal(root.scripts.lint, 'npm run lint --workspaces --if-present');
  assert.equal(root.scripts['test:coverage'], 'npm run test:coverage --workspaces --if-present');

  // --workspaces --if-present only runs a script a workspace actually has, so a
  // workspace without these scripts is silently left out of the root gates. Every
  // workspace of the root manifest is therefore checked here, and the check reads
  // what the scripts do: a script that only pretends to lint ("echo eslint
  // skipped", "eslint --version") would pass a keyword check and leave the
  // workspace unchecked.
  assert.ok(Array.isArray(root.workspaces) && root.workspaces.length > 0, 'the root manifest must list its workspaces');
  for (const workspace of root.workspaces) {
    const manifest = JSON.parse(read(`../${workspace}/package.json`));
    const scripts = manifest.scripts ?? {};
    assert.ok(scripts.lint, `${workspace} needs a lint script for the root lint gate`);
    assertRealLintScript(workspace, manifest);
    if (scripts.test) {
      assert.ok(scripts['test:coverage'], `${workspace} needs a test:coverage script for the root coverage gate`);
      assert.match(scripts['test:coverage'], /coverage/, `${workspace} needs a test:coverage script that measures coverage, not a script that only says so`);
    } else {
      assert.ok(!scripts['test:coverage'], `${workspace} has no test script, so a test:coverage script would report coverage of nothing`);
    }
  }

  for (const job of ['build-test', 'cross-platform']) {
    const steps = ci.jobs[job].steps;
    assert.ok(steps.some((step) => step.run === 'npm run lint'), `${job} must run the root lint gate`);
    assert.ok(steps.some((step) => step.run === 'npm run test:coverage'), `${job} must run the root coverage gate`);
  }
});

test('the lint guard accepts a manifest lint script that really runs eslint over files', () => {
  for (const lint of [
    'eslint "src/**/*.ts" --max-warnings=0',
    'eslint src --max-warnings=0',
    'eslint . --max-warnings=0',
    'npx eslint "src/**/*.ts" --max-warnings=0'
  ]) {
    const manifest = { scripts: { lint } };
    assert.equal(lintScriptProblem(lint), null, `${lint} must pass the lint guard`);
    assert.doesNotThrow(() => assertRealLintScript('example', manifest));
  }
});

test('the lint guard rejects a lint script that only pretends to lint', () => {
  const cases = [
    ['echo eslint skipped', /never runs eslint/],
    ['eslint --version', /lints no files/],
    ['eslint --version src --max-warnings=0', /unsupported arguments/],
    ['eslint --print-config src --max-warnings=0', /unsupported arguments/],
    ['eslint src --max-warnings=0 || true', /shell operator/],
    ['eslint src --max-warnings=0 | tee log', /shell operator/]
  ];
  for (const [lint, reason] of cases) {
    const manifest = { scripts: { lint } };
    assert.match(lintScriptProblem(lint), reason, `${lint} must fail the lint guard`);
    assert.throws(() => assertRealLintScript('example', manifest), /lint script/);
  }
});

test('the lint guard rejects a lint run without files, without --max-warnings=0, or without a lint script', () => {
  for (const [lint, reason] of [
    ['eslint --max-warnings=0', /lints no files/],
    ['eslint "src/**/*.ts"', /does not pass --max-warnings=0/],
    ['eslint "src/**/*.ts" --max-warnings=1', /does not pass --max-warnings=0/],
    ['true', /never runs eslint/]
  ]) {
    assert.match(lintScriptProblem(lint), reason, `${lint} must fail the lint guard`);
  }

  assert.match(lintScriptProblem(undefined), /empty/);
  assert.throws(() => assertRealLintScript('example', { scripts: {} }), /needs a lint script/);
});

test('only PR runs cancel predecessors; branch pushes do not duplicate PR runs', () => {
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.deepEqual(ci.on.push.tags, ['v*']);
  assert.ok('pull_request' in ci.on);
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  assert.equal(ci.concurrency.group, '${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}');
});

test('CI checks the mock contract and enforces a 3 MiB VSIX budget', () => {
  const steps = ci.jobs['build-test'].steps;
  assert.ok(steps.some((step) => step.run === 'npm run mock:check -w extension'));
  assert.equal(steps.find((step) => step.name === 'Enforce VSIX size budget').env.VSIX_BUDGET_BYTES, '3145728');
});

test('runner routing keeps check names; cross-platform uses hosted runners because the repository is public', () => {
  assert.equal(ci.jobs['build-test']['runs-on'], '${{ fromJSON(vars.LINUX_RUNNER_LABELS) }}');
  assert.equal(ci.jobs['cross-platform'].name, 'cross-platform (${{ matrix.os }})');
  assert.equal(ci.jobs['cross-platform']['runs-on'], '${{ matrix.os }}');
  assert.deepEqual(ci.jobs['cross-platform'].strategy.matrix.os, ['windows-latest', 'ubuntu-latest']);
});

test('both workflows use the trusted composite GitHub CLI action', () => {
  const dependency = parse(read('workflows/dependency-auto-merge.yml'));
  for (const steps of [ci.jobs.release.steps, dependency.jobs['dependabot-dev-deps'].steps]) {
    const action = steps.findIndex((step) => step.uses === './.github/actions/ensure-gh');
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(action >= 0);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(steps.indexOf(checkout) < action);
  }
  const checkout = dependency.jobs['dependabot-dev-deps'].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha }}');
  const composite = parse(read('actions/ensure-gh/action.yml'));
  assert.equal(composite.runs.using, 'composite');
  const step = composite.runs.steps[0];
  assert.equal(step.shell, 'bash');
  assert.match(step.run, /GH_VERSION=2\.102\.0/);
  assert.match(step.run, /grep " \$\{ASSET\}\$" "\$\{CHECKSUMS\}" \| sha256sum -c -/);
  assert.match(step.run, /ln -sf "\$\(command -v gh\)"/);
});

test('Dependabot does not ignore uuid when neither lockfile contains it', () => {
  for (const file of ['../package-lock.json', '../tools/publish/package-lock.json']) {
    assert.doesNotMatch(read(file), /"(?:[^"\n]*\/)?uuid"\s*:/);
  }
  const dependabot = parse(read('dependabot.yml'));
  assert.ok(!dependabot.updates[0].ignore.some((entry) => entry['dependency-name'] === 'uuid'));
});

test('the secret rotation reminder tests the parser, installs nothing and files issues with narrow permissions', () => {
  const rotation = parse(read('workflows/secret-rotation-reminder.yml'));
  const job = rotation.jobs.remind;
  assert.equal(job['runs-on'], '${{ fromJSON(vars.LINUX_RUNNER_LABELS) }}');
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });

  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const setupNode = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(setupNode.with['node-version'], 22);
  const ciSteps = ci.jobs['build-test'].steps;
  assert.equal(checkout.uses, ciSteps.find((step) => step.uses?.startsWith('actions/checkout@')).uses);
  assert.equal(setupNode.uses, ciSteps.find((step) => step.uses?.startsWith('actions/setup-node@')).uses);

  assert.ok(job.steps.some((step) => step.run === 'node --test scripts/*.test.mjs'));
  const file = job.steps.find((step) => step.run === 'node scripts/secret-rotation-remind.mjs');
  assert.ok(file);
  assert.equal(file.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(file.env.GH_REPO, '${{ github.repository }}');
  for (const step of job.steps) {
    assert.doesNotMatch(step.run ?? '', /npm (ci|install|run)/, 'the job must not install or run dependencies');
  }
  assert.equal(rotation.on.workflow_dispatch.inputs['dry-run'].default, true);
});

test('CI runs the rotation calendar tests on every pull request', () => {
  const steps = ci.jobs['build-test'].steps;
  const scripts = steps.find((step) => step.run === 'node --test scripts/*.test.mjs');
  assert.ok(scripts, 'the build-test job must run the parser and runner tests');
  const setupNode = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.ok(steps.indexOf(scripts) > setupNode);
});

test('the parser tests are named one by one, because Node 22 cannot run a directory', () => {
  // Node 22 reads a directory argument as a module and fails, so the test
  // files are named by the glob the shell expands. The shell has to be bash
  // for that, so both steps say so.
  const rotation = parse(read('workflows/secret-rotation-reminder.yml'));
  for (const steps of [ci.jobs['build-test'].steps, rotation.jobs.remind.steps]) {
    const scripts = steps.find((step) => step.run === 'node --test scripts/*.test.mjs');
    assert.ok(scripts, 'the step must name the test files');
    assert.equal(scripts.shell, 'bash', 'the shell expands the glob');
    assert.doesNotMatch(scripts.run, /node --test scripts\/(\s|$)/);
  }
});

test('the secret rotation reminder stays monthly, dry by default and serialized', () => {
  const rotation = parse(read('workflows/secret-rotation-reminder.yml'));
  assert.deepEqual(rotation.on.schedule, [{ cron: '0 9 1 * *' }]);

  const file = rotation.jobs.remind.steps.find(
    (step) => step.run === 'node scripts/secret-rotation-remind.mjs'
  );
  assert.ok(file);
  assert.equal(file.env.DRY_RUN, '${{ inputs.dry-run }}');
  assert.equal(rotation.on.workflow_dispatch.inputs['dry-run'].default, true);

  // The group has to be the workflow name alone: a group that holds the run
  // id is unique per run and serializes nothing.
  assert.equal(rotation.concurrency?.group, '${{ github.workflow }}');
  assert.equal(rotation.concurrency['cancel-in-progress'], false);
});
