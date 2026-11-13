import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerFmWebProjectCommands } from '../../src/commands/fmWebProject';

const processStart = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/services/fmWebPreviewProcess', () => ({
  FmWebPreviewProcess: class { start = processStart; dispose = vi.fn(async () => undefined); },
  PREVIEW_INSTALL_DESCRIPTION: 'npm install --ignore-scripts',
  PREVIEW_DEV_DESCRIPTION: 'npm run dev --ignore-scripts -- --hostname 127.0.0.1 --port 3000'
}));

/** The preview asks before running npm in a private template copy. */

function start() {
  const generator = {
    inspectPreviewFiles: vi.fn(async () => [] as string[]),
    removePreviewFiles: vi.fn(async () => undefined),
    previewTemplateFiles: vi.fn(async () => new Map()),
    generateRuntimeAppTemplate: vi.fn(async () => undefined),
    listLayoutDefinitions: vi.fn(async () => []),
    generateLayoutPage: vi.fn(async () => undefined),
    writeBridgeEnv: vi.fn(async () => undefined),
    clearBridgeEnv: vi.fn(async () => undefined),
    getGeneratedRuntimeRoot: () => '/workspace/.fmweb/generated/runtime-next'
  };
  const terminal = { show: vi.fn(), sendText: vi.fn() };
  (vscode.window as unknown as { createTerminal: unknown }).createTerminal = vi.fn(() => terminal);

  const bridge = {
    ensureStarted: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234' })),
    getSessionToken: () => 'session-token',
    stop: vi.fn(async () => undefined)
  };

  registerFmWebProjectCommands({
    context: {} as never,
    profileStore: {} as never,
    fmClient: {} as never,
    schemaService: {} as never,
    fmWebProjectService: {} as never,
    fmWebRuntimeGenerator: generator as never,
    fmBridgeServer: bridge as never,
    roleGuard: { assertFeature: vi.fn(async () => true) } as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    refreshExplorer: vi.fn()
  });

  const registered = vi.mocked(vscode.commands.registerCommand).mock.calls.filter(
    ([id]) => id === 'filemakerDataApiTools.startFmWebPreviewServer'
  );
  const handler = registered[registered.length - 1]?.[1] as () => Promise<void>;
  const regenerate = vi.mocked(vscode.commands.registerCommand).mock.calls.filter(([id]) => id === 'filemakerDataApiTools.generateFmWebNextApp').pop()?.[1] as () => Promise<void>;
  return { run: handler, regenerate, terminal, generator, bridge };
}

describe('FM Web preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  });

  it('A3 asks before starting the bridge or writing its token, and clears an existing session on cancel', async () => {
    const { run, generator, bridge } = start();
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
      expect(bridge.ensureStarted).not.toHaveBeenCalled();
      expect(generator.writeBridgeEnv).not.toHaveBeenCalled();
      return undefined;
    });
    await run();
    expect(bridge.ensureStarted).not.toHaveBeenCalled();
    expect(generator.writeBridgeEnv).not.toHaveBeenCalled();
    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(generator.clearBridgeEnv).toHaveBeenCalledOnce();
  });

  it('shows what will run and does nothing when declined', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const { run, terminal } = start();

    await run();

    const prompt = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0] as string;
    expect(prompt).toContain('npm install');
    expect(prompt).toContain('npm run dev');
    expect(prompt).toContain('/workspace/.fmweb/generated/runtime-next');
    expect(prompt).toContain('package.json');
    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it('A1 pins the preview launch to loopback after the user agrees', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run' as never);
    const { run, terminal } = start();

    await run();

    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(processStart).toHaveBeenCalledWith(expect.any(Map), expect.any(Map), 'http://127.0.0.1:1234', 'session-token');
  });

  it('passes bridge credentials only to the private process, leaving runtime env files untouched', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run' as never);
    const { run, generator } = start();

    await run();

    expect(generator.writeBridgeEnv).not.toHaveBeenCalled();
    expect(processStart).toHaveBeenCalledWith(expect.any(Map), expect.any(Map), 'http://127.0.0.1:1234', 'session-token');
  });

  it('warns when an edited generated file could not be updated, so a silent failure is not left to the user', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const { run, generator } = start();
    generator.inspectPreviewFiles.mockResolvedValue(['lib/bridge-client.ts']);

    await run();

    const messages = vi.mocked(vscode.window.showWarningMessage).mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('lib/bridge-client.ts') && message.includes('ignored'))).toBe(true);
  });

  it('shows ignored files in the run confirmation and leaves them untouched when cancelled', async () => {
    const { run, generator, bridge } = start();
    generator.inspectPreviewFiles.mockResolvedValue(['.npmrc', 'next.config.ts', 'node_modules']);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    await run();
    expect(processStart).not.toHaveBeenCalled();
    expect(bridge.ensureStarted).not.toHaveBeenCalled();
    expect(generator.removePreviewFiles).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('node_modules'), { modal: true }, 'Run');
  });

  it('runs a clean template copy despite added or edited files, without generating or deleting runtime files', async () => {
    const { run, generator } = start();
    generator.inspectPreviewFiles.mockResolvedValue(['.npmrc', '.env.local', 'app/user-page.tsx', 'next.config.ts']);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run' as never);
    await run();
    expect(generator.removePreviewFiles).not.toHaveBeenCalled();
    expect(generator.generateRuntimeAppTemplate).not.toHaveBeenCalled();
    expect(generator.writeBridgeEnv).not.toHaveBeenCalled();
    expect(generator.previewTemplateFiles).toHaveBeenCalledOnce();
    expect(processStart).toHaveBeenCalledOnce();
    const prompt = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]![0];
    expect(prompt).toContain('Your runtime files are left untouched');
    expect(prompt).toContain('app/user-page.tsx');
  });

  it('deletes listed runtime files only in the explicit generation command after named confirmation', async () => {
    const { regenerate, generator } = start();
    generator.inspectPreviewFiles.mockResolvedValue(['.npmrc']);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Regenerate from template' as never);
    await regenerate();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('.npmrc'), { modal: true }, 'Regenerate from template');
    expect(generator.removePreviewFiles).toHaveBeenCalledWith(['.npmrc']);
    expect(generator.generateRuntimeAppTemplate).toHaveBeenCalledOnce();
    expect(processStart).not.toHaveBeenCalled();
  });

  it('preserves runtime files when explicit regeneration is declined', async () => {
    const { regenerate, generator } = start();
    generator.inspectPreviewFiles.mockResolvedValue(['app/user-page.tsx']);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    await regenerate();
    expect(generator.removePreviewFiles).not.toHaveBeenCalled();
    expect(generator.generateRuntimeAppTemplate).not.toHaveBeenCalled();
  });

  it('refuses in an untrusted workspace without asking', async () => {
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    const { run, terminal } = start();

    await run();

    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toMatch(/Workspace trust is required/);
  });
});
