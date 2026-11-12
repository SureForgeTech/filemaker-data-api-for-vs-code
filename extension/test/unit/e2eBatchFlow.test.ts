import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The UI harness is JavaScript; this test invokes only its prompt orchestration.
import { batchExport } from '../../e2e-ui/lib/flows.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function session(out: string, writeOutput = true) {
  const fill = vi.fn();
  return {
    closeAllEditors: vi.fn(), dismissToasts: vi.fn(), cmd: vi.fn(),
    pickerOpen: vi.fn().mockResolvedValue(false), quickInputOpen: vi.fn(),
    inputBox: vi.fn(), pick: vi.fn(), modalVisible: vi.fn().mockResolvedValue(false),
    waitToast: vi.fn(async () => { if (writeOutput) writeFileSync(out, 'complete'); }),
    helper: vi.fn().mockResolvedValue({ text: '{"status":"failed","details":"export failed"}' }),
    page: { waitForTimeout: vi.fn(), locator: () => ({ first: () => ({ fill }) }), keyboard: { press: vi.fn() } }
  };
}

function output(ext: string) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-batch-flow-'));
  roots.push(root);
  return join(root, `customers.${ext}`);
}

describe('headless batch journey prompts', () => {
  it.each(['csv', 'jsonl'])('answers the find, sort, save and %s format prompts before waiting for output', async (ext) => {
    const out = output(ext);
    const s = session(out);
    await batchExport(s, 'Customers', '[{"CustomerID":"*"}]', out);
    expect(s.dismissToasts).toHaveBeenCalledOnce();
    expect(s.inputBox).toHaveBeenNthCalledWith(1, '[{"CustomerID":"*"}]', { timeout: 15000, prompt: /Find query JSON/ });
    expect(s.inputBox).toHaveBeenNthCalledWith(2, '', { timeout: 10000, prompt: /Sort JSON/ });
    expect(s.page.locator().first().fill).toHaveBeenCalledWith(out);
    expect(s.pick.mock.calls).toEqual(ext === 'csv' ? [['Standard CSV']] : []);
    expect(s.waitToast).toHaveBeenCalledOnce();
    expect(s.helper).not.toHaveBeenCalled();
  });

  it('reports job details when a Started toast is followed by no file', async () => {
    const out = output('csv');
    const s = session(out, false);
    await expect(batchExport(s, 'Customers', '[{"CustomerID":"*"}]', out))
      .rejects.toThrow('Job details: {"status":"failed","details":"export failed"}');
    expect(s.cmd).toHaveBeenLastCalledWith('FileMaker: Show Jobs');
    expect(s.pick.mock.calls).toEqual([['Standard CSV'], ['Batch Export Customers'], ['View details']]);
  });
});
