import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('release artifact dependency installation', () => {
  it('disables dependency install scripts in the package job on the configured self-hosted runner', () => {
    const workflow = parse(readFileSync(resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.package;
    const installs = job.steps.filter((step: { run?: string }) => step.run?.startsWith('npm ci'));
    expect(installs).toHaveLength(1);
    expect(installs[0].run).toBe('npm ci --ignore-scripts');
    expect(job['runs-on']).toBe('${{ fromJSON(vars.LINUX_RUNNER_LABELS) }}');
  });
});
