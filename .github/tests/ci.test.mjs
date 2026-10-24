import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const ci = parse(read('workflows/ci.yml'));

test('both CI test jobs run workspace tests after shared is built', () => {
  for (const name of ['build-test', 'cross-platform']) {
    const steps = ci.jobs[name].steps;
    const build = steps.findIndex((step) => step.name === 'Build');
    assert.ok(build >= 0);
    assert.ok(steps.findIndex((step) => step.run === 'npm test -w designer-ui -w runtime-next') > build);
  }
});

test('the root lint and coverage gates reach the designer and runtime workspaces', () => {
  const root = JSON.parse(read('../package.json'));
  assert.equal(root.scripts.lint, 'npm run lint --workspaces --if-present');
  assert.equal(root.scripts['test:coverage'], 'npm run test:coverage --workspaces --if-present');

  // --workspaces --if-present only runs a script a workspace actually has, so a
  // workspace without these scripts is silently left out of the root gates.
  for (const workspace of ['designer-ui', 'runtime-next']) {
    const manifest = JSON.parse(read(`../${workspace}/package.json`));
    assert.ok(manifest.scripts.lint, `${workspace} needs a lint script for the root lint gate`);
    assert.ok(manifest.scripts['test:coverage'], `${workspace} needs a test:coverage script for the root coverage gate`);
  }

  for (const job of ['build-test', 'cross-platform']) {
    const steps = ci.jobs[job].steps;
    assert.ok(steps.some((step) => step.run === 'npm run lint'), `${job} must run the root lint gate`);
    assert.ok(steps.some((step) => step.run === 'npm run test:coverage'), `${job} must run the root coverage gate`);
  }
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
