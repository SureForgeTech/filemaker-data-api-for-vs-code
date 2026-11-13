import { assert, markAsserted } from '../lib/session.mjs';
// Journey 14: responsive layout of every webview panel and of the tree views at editor widths of about 360, 480, 640, 770
// and 1100 px, with the sidebar open, in a split editor, at zoom levels -2/0/+2 and in light, dark and high-contrast themes.
// Each state is audited in the page (horizontal scroll, off-screen controls, truncated labels, overlaps, tables without
// scroll) and screenshotted. FAIL = at least one finding; the detail lists them.
import { AUDIT_SCRIPT } from '../lib/layoutAudit.mjs';
import {
  answerPickers,
  connect,
  createProfile,
  ensureProfileCommands,
  openQueryBuilder
} from '../lib/flows.mjs';

const J = 'J14 responsive';
const WIDTHS = [360, 480, 640, 770, 1100];
const OVERHEAD = 52; // activity bar and borders with the sidebar closed

async function setWindow(s, width, height = 900) {
  await s.app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(300, 300);
      win.setBounds({ x: 20, y: 20, width: w, height: h });
    },
    [width, height]
  );
  await s.page.waitForTimeout(900);
}

export async function run(ctx) {
  const { s, mock } = ctx;
  s.observeOnly(['Explorer and Layout Inspector tree views at a narrow window']); // these steps only record behaviour
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  // The widths below assume only the editor area is open. An earlier journey (the Chat view of J10c) can leave a
  // secondary side bar or the bottom panel open, which takes about 160 px from every width.
  for (const command of ['workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel'])
    await s.helper('executeCommand', { command }).catch(() => {});
  await ensureProfileCommands(s);
  if (!/Mock Quality/.test((await s.statusItem(/FileMaker:/)) ?? ''))
    await connect(s, 'Mock Quality');
  const man = await mock.manifest();
  // E2E_J14_SHORT_LAYOUTS=1 drops the 140-character layout name from the mock, to separate its effect (it widens every layout <select>) from other defects.
  if (process.env.E2E_J14_SHORT_LAYOUTS) {
    await mock.admin('/__admin/schema', {
      db: 'Quality',
      table: 'Customers',
      removeLayoutsLongerThan: 60
    });
    await s.cmd('FileMaker: Refresh Schema Cache').catch(() => {});
    await s.reloadWindow();
  }
  const pid = man.databases.Quality.tables.Products.conditions.clean[2];
  const bigCustomer = man.databases.Quality.tables.Customers.conditions['portal-many'][0];

  const panels = [
    {
      name: 'Connection wizard',
      selector: '#wizardForm',
      open: async () => {
        await s.closeAllEditors();
        await s.cmd('FileMaker: Add Connection Profile');
        const wv = await s.webview('#wizardForm');
        await wv
          .locator('#certificateOptions summary')
          .click()
          .catch(() => {});
        await wv
          .locator('.advanced-toggle summary')
          .first()
          .click()
          .catch(() => {});
      }
    },
    {
      name: 'Query Builder (results table)',
      selector: '#runButton',
      open: async () => {
        const wv = await openQueryBuilder(s, 'Customers');
        await wv.locator('#jsonTab').click();
        await wv.locator('#findJson').fill('[{"CustomerID":"*"}]');
        await wv.locator('#limitInput').fill('30');
        await wv.locator('#runButton').click();
        await wv.locator('.results-table').first().waitFor({ timeout: 20000 });
        await wv.locator('#exportMenu summary').click();
      }
    },
    {
      name: 'Record Editor (edit)',
      selector: '#recordIdInput',
      open: async () => {
        await s.closeAllEditors();
        await s.cmd('FileMaker: Open Record Editor');
        await answerPickers(s, ['Mock Quality', 'Products']);
        if (await s.pickerOpen()) await s.inputBox(String(pid));
        const wv = await s.webview('#recordIdInput');
        if (
          !(await wv
            .locator('#fieldEditor textarea')
            .first()
            .waitFor({ timeout: 8000 })
            .then(
              () => true,
              () => false
            ))
        ) {
          await wv.locator('#loadButton').click();
        }
        await wv.locator('#fieldEditor textarea').first().waitFor({ timeout: 20000 });
        await wv
          .locator('#previewButton')
          .click()
          .catch(() => {});
      }
    },
    {
      name: 'Record Editor (create)',
      selector: '#fieldEditor',
      open: async () => {
        await s.closeAllEditors();
        await s.cmd('FileMaker: Create Record');
        await answerPickers(s, ['Mock Quality', 'Products']);
        await (
          await s.webview('#fieldEditor')
        )
          .locator('#fieldEditor textarea')
          .first()
          .waitFor({ timeout: 20000 });
      }
    },
    {
      name: 'Record Viewer (portal)',
      selector: '#relatedDataContainer',
      visible: false,
      open: async () => {
        await s.closeAllEditors();
        await s.cmd('FileMaker: Open Record Viewer');
        await answerPickers(s, ['Mock Quality', 'Customers']);
        if (await s.pickerOpen()) await s.inputBox(String(bigCustomer));
        const rv = await s.webview('#relatedDataContainer', { visible: false });
        await rv.locator('#loadButton').click();
        await s.page.waitForTimeout(3000);
      }
    },
    {
      name: 'Script Runner',
      selector: '#scriptNameInput',
      open: async () => {
        await s.closeAllEditors();
        await s.cmd('FileMaker: Open Script Runner');
        await answerPickers(s, ['Mock Quality', 'Customers']);
        if (await s.pickerOpen()) await s.inputBox('');
        const wv = await s.webview('#scriptNameInput');
        await wv.locator('#scriptNameInput').fill('Echo');
        await wv.locator('#runButton').click();
        await s.page.waitForTimeout(2500);
      }
    },
    {
      name: 'Schema diff',
      selector: 'body',
      visible: false,
      open: async () => {
        await s.closeAllEditors();
        for (let i = 0; i < 2; i += 1) {
          await s.cmd('FileMaker: Capture Schema Snapshot');
          await answerPickers(s, ['Mock Quality', 'Products']);
          await s.waitToast(/Captured schema snapshot/i, { timeout: 20000 }).catch(() => {});
        }
        await s.cmd('FileMaker: Diff Schema Snapshots');
        await answerPickers(s, ['Mock Quality', 'Products'], { max: 6 });
        for (let i = 0; i < 2; i += 1)
          if (await s.pickerOpen()) {
            const items = await s.pickerItems();
            await s.pick(items[0].split(' ')[0]);
            await s.page.waitForTimeout(500);
          }
        await s.page.waitForTimeout(2500);
      }
    },
    {
      name: 'Layout Mode (FM Web designer)',
      selector: 'body',
      visible: false,
      open: async () => {
        await s.closeAllEditors();
        await s.cmd('FileMaker: Initialize FM Web Project').catch(() => {});
        await s.page.waitForTimeout(1500);
        if ((await s.waitCmdListed('FileMaker: Open FM Web Layout Mode', 5000)) < 0)
          await s.reloadWindow();
        await s.cmd('FileMaker: Open FM Web Layout Mode');
        await answerPickers(s, ['Mock Quality', 'Customers'], { max: 3 });
        await s.page.waitForTimeout(5000);
      }
    },
    {
      name: 'Diagnostics dashboard',
      selector: 'body',
      visible: false,
      open: async () => {
        await s.setSetting('filemaker.advanced.powerUserMode', true);
        await s.page.waitForTimeout(1500);
        await s.closeAllEditors();
        await s.cmd('FileMaker: Open Diagnostics Dashboard');
        await s.page.waitForTimeout(3000);
      }
    }
  ];

  const seenCauses = new Set();
  const audit = async (panel) => {
    const frames = s.page
      .frames()
      .filter((f) => /vscode-webview:\/\/[^/]+\/fake\.html/.test(f.url()));
    let best;
    for (const f of frames) {
      try {
        const vis = await f.evaluate(
          () =>
            document.body &&
            document.body.getBoundingClientRect().width > 0 &&
            document.visibilityState !== 'hidden'
        );
        if (!vis) continue;
        const has =
          panel.selector === 'body' ? true : (await f.locator(panel.selector).count()) > 0;
        if (has) best = f;
      } catch {
        /* detached */
      }
    }
    if (!best)
      return { vw: 0, vh: 0, count: 0, issues: [{ type: 'panel-not-found', where: panel.name }] };
    return best.evaluate(AUDIT_SCRIPT);
  };
  const state = async (panel, label, { sidebar = false, theme, zoom = 0, split = false } = {}) => {
    await s.step(
      J,
      `${panel.name} @ ${label}`,
      'no clipped, overlapping, off-screen or unreachable controls',
      async () => {
        await s.page.waitForTimeout(500);
        const r = await audit(panel);
        // Each root cause is reported once per panel (the first state it is seen in), not at every width.
        const fresh = (r.rootCauses ?? []).filter(
          (c) => !seenCauses.has(`${panel.name}|${c.type}`)
        );
        for (const c of fresh) seenCauses.add(`${panel.name}|${c.type}`);
        if (fresh.length)
          throw new Error(
            `root cause (reported once per panel; the other states are audited with it constrained): ${fresh.map((c) => `[${c.type}] ${c.where}`).join(' ; ')}`
          );
        if (r.issues.length)
          throw new Error(
            `${r.issues.length} finding(s) in a ${r.vw}px-wide panel (${r.count} controls): ${r.issues.map((i) => `[${i.type}] ${i.where}`).join(' ; ')}`
          );
        markAsserted(); // zero findings is the assertion
        return `${r.vw}px viewport, ${r.count} controls, no findings`;
      }
    );
  };

  const only = (process.env.E2E_J14_ONLY ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const panel of panels) {
    if (only.length && !only.some((o) => panel.name.startsWith(o))) continue;
    try {
      await panel.open();
    } catch (e) {
      await s.shot(`could-not-open-${panel.name}`);
      s.note(J, `${panel.name}: could not open`, String(e.message).slice(0, 300), 'FAIL');
      continue;
    }
    await s.cmd('View: Close Primary Side Bar').catch(() => {});
    for (const w of WIDTHS) {
      await setWindow(s, w + OVERHEAD);
      await state(panel, `editor ~${w}px`);
    }
    await s.cmd('View: Show Explorer').catch(() => {});
    await s.openFileMakerSidebar();
    for (const w of [770, 1100]) {
      await setWindow(s, w + 350);
      await state(panel, `sidebar open, editor ~${w}px`);
    }
    await s.cmd('View: Close Primary Side Bar').catch(() => {});
    await setWindow(s, 1100 + OVERHEAD);
    await s.cmd('View: Split Editor Right').catch(() => {});
    await s.page.waitForTimeout(800);
    await state(panel, 'split editor (each half ~550px)');
    await s.cmd('View: Close Editor Group').catch(() => {});
    for (const z of [-2, 2]) {
      await s.setSetting('window.zoomLevel', z);
      for (const w of [480, 770]) {
        await setWindow(s, w + OVERHEAD);
        await state(panel, `zoom ${z > 0 ? '+' : ''}${z}, window ~${w}px`);
      }
    }
    await s.setSetting('window.zoomLevel', undefined);
    for (const [theme, label] of [
      ['Default Light Modern', 'light'],
      ['Default High Contrast', 'high contrast'],
      ['Default High Contrast Light', 'high contrast light']
    ]) {
      await s.setSetting('workbench.colorTheme', theme);
      for (const w of [360, 770]) {
        await setWindow(s, w + OVERHEAD);
        await state(panel, `${label} theme, editor ~${w}px`);
      }
    }
    await s.setSetting('workbench.colorTheme', undefined);
  }

  // Modal dialogs taller than the window, and the tree views in a narrow sidebar.
  await s.step(
    J,
    'Modal dialog at a short, narrow window (AI server start dialog has a long detail text)',
    'the dialog fits the window and its buttons are reachable',
    async () => {
      await s.closeAllEditors();
      await setWindow(s, 480, 520);
      await s.setSetting('filemaker.ai.enabled', true);
      await s.cmd('FileMaker: Start/Stop AI Server for External Tools');
      // The command is a toggle: when an earlier journey (J10b) left the server running, the first run only stops it
      // (a toast, no dialog). Run it again to get the start dialog this step is about.
      if (!(await s.waitModal(4000).then(() => true, () => false))) {
        await s.dismissToasts();
        await s.cmd('FileMaker: Start/Stop AI Server for External Tools');
      }
      await s.waitModal(15000);
      const box = await s.page.locator('.monaco-dialog-box').boundingBox();
      const vp = s.page.viewportSize() ?? { width: 480, height: 520 };
      const btns = await s.page
        .locator('.monaco-dialog-box .dialog-buttons .monaco-button')
        .evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return {
              t: e.textContent.trim(),
              bottom: Math.round(r.bottom),
              right: Math.round(r.right)
            };
          })
        );
      const win = await s.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      const scrollable = await s.page
        .locator('.monaco-dialog-box .dialog-message-container, .monaco-dialog-box .dialog-message')
        .first()
        .evaluate((el) => el.scrollHeight > el.clientHeight)
        .catch(() => false);
      await s.modal('Cancel');
      const problems = [];
      if (box && (box.y + box.height > win.h + 1 || box.y < -1))
        problems.push(
          `dialog spans ${Math.round(box.y)}..${Math.round(box.y + box.height)} in a ${win.h}px window`
        );
      for (const b of btns)
        if (b.bottom > win.h || b.right > win.w)
          problems.push(
            `button "${b.t}" is outside the window (bottom ${b.bottom}/${win.h}, right ${b.right}/${win.w})`
          );
      assert(problems.length === 0, problems.join('; '));
      return `dialog ${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)} in ${win.w}x${win.h}; message scrollable: ${scrollable}`;
    }
  );
  await s.step(
    J,
    'Explorer and Layout Inspector tree views at a narrow window',
    'row labels are readable (ellipsis with tooltip) and inline actions are reachable',
    async () => {
      await setWindow(s, 420, 800);
      await s.cmd('View: Show Explorer').catch(() => {});
      await s.openFileMakerSidebar();
      await s.page.waitForTimeout(1000);
      return 'see screenshot';
    }
  );
  await setWindow(s, 1500, 950);
}
