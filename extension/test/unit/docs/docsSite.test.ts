import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from '../../helpers/jsdomPage';

const root = path.resolve(__dirname, '../../../..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'docs-site-test-'));
const output = path.join(scratch, 'pages');
const repo = 'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code';
const marketplace = 'https://marketplace.visualstudio.com/items?itemName=SureForgeTech.filemaker-data-api-tools';
const document = (html: string) => new JSDOM!(html, { runScripts: 'outside-only', url: 'https://docs.invalid/' }).window.document;
const html = (file: string) => readFileSync(path.join(output, file), 'utf8');
function build(source = root, out = output) {
  return spawnSync(process.execPath, [path.join(root, 'tools/build-docs-site.mjs'), '--root', source, '--out', out], { encoding: 'utf8' });
}
function fixture(guide: string) {
  const source = mkdtempSync(path.join(scratch, 'fixture-'));
  for (const [file, content] of Object.entries({
    'extension/package.json': '{"version":"1.7.0"}',
    'extension/docs/USER_GUIDE.md': guide,
    'extension/docs/COMPATIBILITY.md': '# Compatibility',
    'extension/docs/FM_WEB.md': '# FM Web',
    'extension/docs/walkthroughs/start.md': '# Step 1 — Start',
    'extension/UPGRADE.md': '# Upgrade',
    'extension/CHANGELOG.md': '# Changelog\n\n## Unreleased\n\nSECRET DRAFT\n\n## 1.6.0\n\nOlder.\n\n## 1.7.0\n\nLatest **news**.\n',
    'SUPPORT.md': '# Support'
  })) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), content);
  }
  mkdirSync(path.join(source, 'extension/docs/marketplace'), { recursive: true });
  return source;
}
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('documentation website from the real repository', () => {
  beforeAll(() => {
    const result = build();
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('builds every page, guide contents, walkthrough navigation and landing links', () => {
    const pages = ['index.html', 'guide/index.html', 'upgrade/index.html', 'changelog/index.html',
      'guide/compatibility/index.html', 'guide/fm-web/index.html',
      ...readdirSync(path.join(root, 'extension/docs/walkthroughs')).filter((f) => f.endsWith('.md'))
        .map((f) => `guide/walkthroughs/${f.slice(0, -3)}/index.html`)];
    for (const page of pages) expect(existsSync(path.join(output, page)), page).toBe(true);
    const version = (JSON.parse(readFileSync(path.join(root, 'extension/package.json'), 'utf8')) as { version: string }).version;
    expect(html('index.html')).toContain(`What is new in ${version}`);
    const links = Array.from(document(html('index.html')).querySelectorAll('a'), (a) => a.getAttribute('href'));
    for (const link of ['guide/index.html', 'upgrade/index.html', 'changelog/index.html', 'api/', repo, `${repo}/releases`, marketplace]) {
      expect(links).toContain(link);
    }
    const guide = document(html('guide/index.html'));
    expect(guide.querySelectorAll('nav[aria-label="On this page"] a').length).toBeGreaterThan(30);
    expect(guide.querySelectorAll('nav[aria-label="Guide pages"] a')).toHaveLength(7);
    for (const selector of ['header', 'main#main', 'footer', 'a.skip-link[href="#main"]']) {
      expect(guide.querySelectorAll(selector)).toHaveLength(1);
    }
    expect(existsSync(path.join(output, '.nojekyll'))).toBe(true);
  });

  it('shows every released version in order, with jump links, and hides Unreleased', () => {
    const versions = [...readFileSync(path.join(root, 'extension/CHANGELOG.md'), 'utf8').matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((m) => m[1]);
    const page = document(html('changelog/index.html'));
    expect(Array.from(page.querySelectorAll('h2'), (h) => h.textContent)).toEqual(versions);
    expect(html('changelog/index.html')).not.toMatch(/Unreleased/i);
    expect(Array.from(page.querySelectorAll('nav[aria-label="Versions"] a'), (a) => a.getAttribute('href')))
      .toEqual(versions.map((v) => `#${v!.replaceAll('.', '-')}`));
  });

  // Every generated page is parsed with JSDOM and every local link and anchor is resolved
  // against the staged site. That measured 35.7 s on a loaded machine, so the budget is 60 s
  // (about twice the slowest measurement); the check itself is unchanged.
  it('resolves all local files and anchors, copies images, and has no active or unexpected external content', () => {
    const visit = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? visit(path.join(dir, entry.name)) : entry.name.endsWith('.html') ? [path.join(dir, entry.name)] : []);
    const documents = new Map<string, ReturnType<typeof document>>();
    const load = (file: string) => {
      if (!documents.has(file)) documents.set(file, document(readFileSync(file, 'utf8')));
      return documents.get(file)!;
    };
    let imageCount = 0;
    for (const file of visit(output)) {
      const page = load(file);
      expect(page.querySelectorAll('script, iframe, object, embed, link, [onclick], [onerror]')).toHaveLength(0);
      expect(page.querySelectorAll('style')).toHaveLength(1);
      for (const element of page.querySelectorAll('[href], [src]')) {
        const url = element.getAttribute('href') ?? element.getAttribute('src')!;
        if (/^https:/.test(url)) {
          expect(url === repo || url.startsWith(`${repo}/`) || url === marketplace || url.startsWith('https://sureforgetech.github.io/filemaker-data-api-for-vs-code/'), url).toBe(true);
          continue;
        }
        expect(url, file).not.toMatch(/^(?:[a-z][\w+.-]*:|\/\/)/i);
        const [pathname, fragment] = url.split('#');
        // TypeDoc is generated and staged separately by the Pages workflow.
        if (pathname?.endsWith('api/')) continue;
        const target = pathname ? path.resolve(path.dirname(file), decodeURIComponent(pathname)) : file;
        expect(existsSync(target), `${file}: ${url}`).toBe(true);
        if (fragment) expect(load(target).getElementById(decodeURIComponent(fragment)), url).not.toBeNull();
        if (element.getAttribute('src')) {
          imageCount++;
          expect(readFileSync(target)).toEqual(readFileSync(path.join(root, path.relative(path.join(output, 'assets'), target))));
        }
      }
    }
    expect(imageCount).toBeGreaterThan(5);
    for (const image of readdirSync(path.join(root, 'extension/docs/marketplace')).filter((f) => f.endsWith('.png'))) {
      expect(existsSync(path.join(output, 'assets/extension/docs/marketplace', image)), image).toBe(true);
    }
  }, 60_000);
});

it('escapes hostile markdown, gives duplicate headings unique IDs, rewrites links, and sorts versions', () => {
  const source = fixture('# Guide\n\n<script>alert("bad")</script>\n\n<img src=x onerror=alert(1)>\n\n[jump](#same-1)\n\n## Same\n\n## Same\n\n[upgrade](../UPGRADE.md) [support](../../SUPPORT.md) [bad](javascript:alert(1))\n\n![local](./tiny.png)\n\n```html\n<script>code</script>\n```');
  cpSync(path.join(root, 'extension/docs/marketplace/icon.png'), path.join(source, 'extension/docs/tiny.png'));
  const out = path.join(source, 'site');
  const result = build(source, out);
  expect(result.status, result.stderr).toBe(0);
  const guide = readFileSync(path.join(out, 'guide/index.html'), 'utf8');
  expect(guide).toContain('&lt;script&gt;');
  expect(guide).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(document(guide).querySelectorAll('script, img[onerror], [href^="javascript:"]')).toHaveLength(0);
  expect(document(guide).getElementById('same-1')).not.toBeNull();
  expect(guide).toContain('href="../upgrade/index.html"');
  expect(guide).toContain(`href="${repo}/blob/main/SUPPORT.md"`);
  expect(existsSync(path.join(out, 'assets/extension/docs/tiny.png'))).toBe(true);
  const changelog = readFileSync(path.join(out, 'changelog/index.html'), 'utf8');
  expect(Array.from(document(changelog).querySelectorAll('h2'), (h) => h.textContent)).toEqual(['1.7.0', '1.6.0']);
  expect(changelog).not.toMatch(/Unreleased|SECRET DRAFT/);
  expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('Latest <strong>news</strong>.');
});

it.each([
  ['missing page', '[broken](./absent.md)', /broken internal link.*absent\.md/i],
  ['missing anchor', '[broken](#absent)', /broken internal link.*#absent/i],
  ['external link outside the allowlist', '[outside](https://example.com/guide)', /unsupported external link.*example\.com/i],
  ['repository lookalike', '[outside](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code.evil/guide)', /unsupported external link/i],
  ['missing image', '![broken](./absent.png)', /missing image.*absent\.png/i]
])('fails clearly on a %s', (_name, markdown, error) => {
  const source = fixture(`# Guide\n\n${markdown}`);
  const result = build(source, path.join(source, 'site'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(error);
});

it('stages the website alongside TypeDoc without changing the workflow security settings', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/api-docs.yml'), 'utf8');
  expect(workflow).toContain('node tools/build-docs-site.mjs --out pages');
  expect(workflow).toContain('cp -R docs/api/. pages/api/');
  expect(workflow.match(/runs-on: \$\{\{ fromJSON\(vars.LINUX_RUNNER_LABELS\) \}\}/g)).toHaveLength(2);
  expect(workflow).toContain('persist-credentials: false');
  expect(workflow).toContain('pages: read');
  expect(workflow).toContain('id-token: write');
  expect(workflow).toContain('      - main');
});


// This test parses the whole documentation site with JSDOM and reads computed styles for every
// table cell, so it runs for seconds. The default five-second timeout is a measure of the
// runner, not of the work, and the test above it already carries a budget for the same reason.
it('keeps table cells and code readable inside horizontal scrolling regions', () => {
  const dom = new JSDOM!(html('guide/index.html'), { runScripts: 'outside-only', url: 'https://docs.invalid/' });
  const window = dom.window as typeof dom.window & {
    getComputedStyle(element: unknown): { minWidth: string; overflowX: string; whiteSpace: string; overflowWrap: string; wordBreak: string };
  };
  const page = window.document;
  const cells = page.querySelectorAll('table th, table td');
  expect(cells.length).toBeGreaterThan(20);
  expect(page.querySelectorAll('.table-scroll > table')).toHaveLength(page.querySelectorAll('table').length);
  for (const wrapper of page.querySelectorAll('.table-scroll')) expect(window.getComputedStyle(wrapper).overflowX).toBe('auto');
  for (const cell of cells) {
    const minimum = window.getComputedStyle(cell).minWidth;
    expect(minimum).toMatch(/px$/);
    expect(parseFloat(minimum)).toBeGreaterThanOrEqual(96);
  }
  const defaults = Array.from(page.querySelectorAll('td code')).filter((code) => code.textContent === 'false');
  expect(defaults.length).toBeGreaterThan(0);
  for (const code of defaults) {
    const style = window.getComputedStyle(code);
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.overflowWrap).toBe('normal');
    expect(style.wordBreak).toBe('normal');
  }
}, 30_000);

it('maps absolute repository links to generated pages from the guide, changelog and home', () => {
  const source = fixture(`# Guide\n\n[upgrade](${repo}/blob/main/extension/UPGRADE.md?from=guide#upgrade) [compatibility](${repo}/blob/main/extension/docs/COMPATIBILITY.md) [other](${repo}/blob/main/SUPPORT.md)`);
  writeFileSync(path.join(source, 'extension/CHANGELOG.md'), `# Changelog\n\n## 1.7.0\n\nRead [UPGRADE.md](${repo}/blob/main/extension/UPGRADE.md#upgrade) and [USER_GUIDE.md](${repo}/blob/main/extension/docs/USER_GUIDE.md).\n`);
  const out = path.join(source, 'site');
  const result = build(source, out);
  expect(result.status, result.stderr).toBe(0);
  const guide = readFileSync(path.join(out, 'guide/index.html'), 'utf8');
  expect(guide).toContain('href="../upgrade/index.html?from=guide#upgrade"');
  expect(guide).toContain('href="compatibility/index.html"');
  expect(guide).toContain(`href="${repo}/blob/main/SUPPORT.md"`);
  expect(readFileSync(path.join(out, 'changelog/index.html'), 'utf8')).toContain('href="../upgrade/index.html#upgrade"');
  const home = document(readFileSync(path.join(out, 'index.html'), 'utf8'));
  expect(home.querySelectorAll('main > p a')[0]?.getAttribute('href')).toBe('upgrade/index.html#upgrade');
  expect(home.querySelectorAll('main > p a:last-child')[0]?.getAttribute('href')).toBe('guide/index.html');
});

it('has one documentation list in the README and describes both Pages builds', () => {
  const readme = readFileSync(path.join(root, 'extension/README.md'), 'utf8');
  const section = readme.split('## Documentation')[1]!.split('## Need help')[0]!;
  expect(section).not.toMatch(/^- \[User Guide\]/m);
  for (const label of ['Compatibility', 'Report a bug', 'Contributing']) expect(section).toContain(label);
});

it('describes both Pages builds', () => {
  expect(readFileSync(path.join(root, 'docs/CI.md'), 'utf8')).toContain('Builds the documentation website and the TypeDoc API reference');
});
