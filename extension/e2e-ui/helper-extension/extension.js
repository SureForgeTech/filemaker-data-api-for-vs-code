// Test-only helper loaded with --extensionDevelopmentPath. The harness cannot call the VS Code API from
// outside the window, so it drops JSON requests into $FM_E2E_HELPER_DIR/requests and reads
// $FM_E2E_HELPER_DIR/responses/<id>.json. It never ships (extension/.vscodeignore excludes e2e-ui).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const dir = process.env.FM_E2E_HELPER_DIR;

async function handle(req) {
  switch (req.action) {
    case 'ping':
      return {
        ok: true,
        trusted: vscode.workspace.isTrusted,
        folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
      };
    case 'listTools':
      return vscode.lm.tools.map((t) => ({
        name: t.name,
        description: t.description,
        tags: t.tags
      }));
    case 'invokeTool': {
      const result = await vscode.lm.invokeTool(req.name, {
        input: req.input ?? {},
        toolInvocationToken: undefined
      });
      return {
        parts: result.content.map((p) =>
          p instanceof vscode.LanguageModelTextPart
            ? { type: 'text', value: p.value }
            : { type: 'other' }
        )
      };
    }
    case 'getConfig':
      return {
        value: vscode.workspace.getConfiguration().get(req.key),
        inspect: vscode.workspace.getConfiguration().inspect(req.key)
      };
    case 'readFile':
      return {
        text: fs.existsSync(path.join(dir, req.name))
          ? fs.readFileSync(path.join(dir, req.name), 'utf8')
          : ''
      };
    case 'extensions':
      return vscode.extensions.all
        .filter((e) => !e.packageJSON.isBuiltin)
        .map((e) => ({ id: e.id, version: e.packageJSON.version, active: e.isActive }));
    case 'executeCommand':
      return {
        result: JSON.parse(
          JSON.stringify(
            (await vscode.commands.executeCommand(req.command, ...(req.args ?? []))) ?? null
          )
        )
      };
    case 'commands': {
      const all = await vscode.commands.getCommands(true);
      return all.filter((c) => c.toLowerCase().includes((req.filter ?? '').toLowerCase()));
    }
    case 'activeDocumentText':
      // The whole text of the active editor. The page only renders the visible lines of a long document.
      return { text: vscode.window.activeTextEditor?.document.getText() ?? '' };
    case 'textDocuments':
      return vscode.workspace.textDocuments.map((d) => ({
        uri: d.uri.toString(),
        languageId: d.languageId,
        length: d.getText().length
      }));
    default:
      throw new Error(`unknown action ${req.action}`);
  }
}

// A fake language model (stable API since VS Code 1.104; skipped on an older editor) so the @filemaker
// participant can be driven without Copilot. It is deterministic: it turns "inject" requests into a hostile
// reply (a markdown link and a call to a WRITE tool) and every other request into a find on the first field.
function registerFakeModel(context) {
  if (typeof vscode.lm?.registerLanguageModelChatProvider !== 'function' || !dir) return;
  const info = {
    id: 'fm-e2e-model',
    name: 'FM E2E fake model',
    family: 'fm-e2e',
    version: '1',
    maxInputTokens: 32000,
    maxOutputTokens: 2000,
    capabilities: { toolCalling: true }
  };
  const text = (m) =>
    m.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : '')).join('');
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('fme2e', {
      provideLanguageModelChatInformation: async () => [info],
      provideTokenCount: async (_model, t) =>
        Math.ceil((typeof t === 'string' ? t : text(t)).length / 4),
      provideLanguageModelChatResponse: async (_model, messages, options, progress) => {
        const last = [...messages]
          .reverse()
          .find((m) => m.role === vscode.LanguageModelChatMessageRole.User);
        const body = last ? text(last) : '';
        fs.appendFileSync(
          path.join(dir, 'model-log.jsonl'),
          JSON.stringify({
            body,
            tools: (options.tools ?? []).map((t) => t.name),
            toolMode: options.toolMode
          }) + '\n'
        );
        let data = {};
        try {
          data = JSON.parse(body.slice(body.lastIndexOf('\n{')));
        } catch {}
        const fields = Array.isArray(data.fields) ? data.fields : [];
        if (/inject/i.test(data.request ?? '')) {
          progress.report(
            new vscode.LanguageModelTextPart('[click me](command:workbench.action.reloadWindow)')
          );
          progress.report(
            new vscode.LanguageModelToolCallPart('e1', 'fm_edit_record', {
              layout: data.layout,
              recordId: '1',
              fields: { [fields[0] ?? 'x']: 'pwned' }
            })
          );
          return;
        }
        progress.report(
          new vscode.LanguageModelToolCallPart('f1', 'fm_find_records', {
            layout: data.layout,
            requests: [{ fields: { [fields[0] ?? 'x']: '*' } }],
            limit: 3
          })
        );
      }
    })
  );
}

function activate(context) {
  if (!dir) return;
  registerFakeModel(context);
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'responses'), { recursive: true });
  const seen = new Set();
  const timer = setInterval(async () => {
    for (const name of fs.readdirSync(path.join(dir, 'requests'))) {
      if (seen.has(name) || !name.endsWith('.json') || fs.existsSync(path.join(dir, 'responses', name))) continue;
      seen.add(name);
      let id = name.replace(/\.json$/, '');
      let out;
      try {
        const req = JSON.parse(fs.readFileSync(path.join(dir, 'requests', name), 'utf8'));
        // Windows share this directory. A new host must not replay another workspace's tool calls.
        if (req.workspacePath !== vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) continue;
        out = { ok: true, data: await handle(req) };
      } catch (e) {
        out = { ok: false, error: String(e && e.message ? e.message : e) };
      }
      fs.writeFileSync(path.join(dir, 'responses', `${id}.json.tmp`), JSON.stringify(out));
      fs.renameSync(
        path.join(dir, 'responses', `${id}.json.tmp`),
        path.join(dir, 'responses', `${id}.json`)
      );
    }
  }, 150);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
module.exports = { activate };
