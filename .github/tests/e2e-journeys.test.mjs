// Exercise journey sequencing with fake sessions; importing a journey launches no UI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run as firstRun } from '../../extension/e2e-ui/journeys/j01b-first-run-happy-path.mjs';
import { run as batch } from '../../extension/e2e-ui/journeys/j06-batch.mjs';

test('the first-run journey removes its profile before later journeys use the same session', async () => {
  const profiles = ['First Run Mock', 'Mock Quality'];
  const commands = [];
  let selected;
  const s = {
    step: async (_journey, name, _expect, fn) => {
      if (name === 'remove the smoke profile before the other journeys') await fn();
    },
    closeAllEditors: async () => {},
    cmd: async (title) => { commands.push(title); },
    pick: async (name) => { selected = name; },
    modal: async (button) => {
      assert.equal(button, 'Remove');
      assert.equal(selected, 'First Run Mock');
      profiles.splice(profiles.indexOf(selected), 1);
    },
    waitToast: async (pattern) => {
      const toast = commands.at(-1) === 'FileMaker: Disconnect'
        ? 'Disconnected from "First Run Mock".' : 'Removed profile "First Run Mock".';
      assert.match(toast, pattern);
      return toast;
    },
    openFileMakerSidebar: async () => {},
    treeRows: async () => profiles
  };
  await firstRun({ s, mock: {} });
  assert.deepEqual(commands, ['FileMaker: Disconnect', 'FileMaker: Remove Connection Profile']);
  assert.deepEqual(profiles, ['Mock Quality']);
});

test('the CSV journey answers the format picker before expecting a started job', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'fm-journey-headless-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  let stage = 'idle';
  let output;
  const choices = [];
  const s = {
    ws,
    waitCmdListed: async () => 0,
    statusItem: async () => 'FileMaker: Mock Quality',
    step: async (_journey, name, _expect, fn) => {
      if (name === 'Batch Export (Find) all Customers to CSV') await fn();
    },
    closeAllEditors: async () => {},
    dismissToasts: async () => {},
    cmd: async (title) => {
      assert.equal(title, 'FileMaker: Batch Export (Find)');
      stage = 'layout';
    },
    page: {
      waitForTimeout: async () => {},
      locator: () => ({ first: () => ({ fill: async (value) => { output = value; } }) }),
      keyboard: { press: async () => { stage = 'CSV format'; } }
    },
    pickerOpen: async () => stage === 'layout',
    pickerItems: async () => ['Customers'],
    quickInputOpen: async () => {},
    inputBox: async () => {},
    modalVisible: async () => false,
    pick: async (choice) => {
      choices.push(choice);
      if (stage === 'layout') {
        assert.equal(choice, 'Customers');
        stage = 'find';
      } else {
        assert.equal(stage, 'CSV format');
        assert.equal(choice, 'Standard CSV');
        stage = 'started';
      }
    },
    waitToast: async (pattern) => {
      assert.equal(stage, 'started', 'the format prompt is still waiting for an answer');
      assert.match('Started job 12345678 for batch export.', pattern);
      writeFileSync(output, 'CustomerID,Notes\nC1,Example\n');
    }
  };
  const ctx = { s, profileMain: true, mock: {
    data: () => ({}),
    manifest: async () => ({ databases: { Quality: { tables: { Products: { conditions: { clean: [] } } } } } })
  } };
  await batch(ctx);
  assert.deepEqual(choices, ['Customers', 'Standard CSV']);
  assert.equal(ctx.csvRows.body.length, 1);
});
