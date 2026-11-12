import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerFmWebProjectCommands } from '../../src/commands/fmWebProject';

/** The preview runs npm in a folder that can come with the repository, so it asks first. */

function start() {
  const generator = {
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
  return { run: handler, terminal, generator, bridge };
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

    expect(terminal.sendText).toHaveBeenCalledWith('npm install --no-audit --no-fund');
    expect(terminal.sendText).toHaveBeenCalledWith('npm run dev -- --hostname 127.0.0.1 --port 3000');
  });

  it('hands the preview app the bridge address and its session token', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run' as never);
    const { run, generator } = start();

    await run();

    expect(generator.writeBridgeEnv).toHaveBeenCalledWith('http://127.0.0.1:1234', 'session-token');
  });

  it('warns when an edited generated file could not be updated, so a silent failure is not left to the user', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    const { run, generator } = start();
    generator.generateRuntimeAppTemplate.mockResolvedValue({ needsManualUpdate: ['lib/bridge-client.ts'] } as never);

    await run();

    const messages = vi.mocked(vscode.window.showWarningMessage).mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('lib/bridge-client.ts') && message.includes('not updated'))).toBe(true);
  });

  it('refuses in an untrusted workspace without asking', async () => {
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    const { run, terminal } = start();

    await run();

    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toMatch(/Workspace trust is required/);
  });
});
