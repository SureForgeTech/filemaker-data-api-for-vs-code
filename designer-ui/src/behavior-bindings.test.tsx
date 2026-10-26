import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBlankLayout, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

interface MockVsCodeApi {
  postMessage: (message: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
}

function buttonObject(options: {
  id: string;
  name: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}): LayoutObject {
  return {
    id: options.id,
    type: 'button',
    name: options.name,
    label: options.label,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    zIndex: options.zIndex,
    anchors: {
      top: true,
      right: false,
      bottom: false,
      left: true
    }
  };
}

function buildLayout(objects: LayoutObject[]): LayoutDefinition {
  const base = createBlankLayout('Behavior Binding Layout', 'Contacts');
  return {
    ...base,
    canvas: {
      width: 760,
      height: 420,
      gridSize: 8
    },
    objects
  };
}

function initializeDesigner(layout: LayoutDefinition, scripts: string[] = []): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      data: {
        type: 'init',
        payload: {
          layout,
          availableFields: ['Name'],
          scripts,
          projectName: 'FM Behavior Test'
        }
      }
    })
  );
}

describe('behavior bindings', () => {
  const postedMessages: unknown[] = [];

  beforeEach(() => {
    postedMessages.length = 0;
    vi.resetModules();

    const mockAcquire = (): MockVsCodeApi => ({
      postMessage: (message: unknown) => {
        postedMessages.push(message);
      },
      setState: () => undefined,
      getState: () => undefined
    });

    (globalThis as unknown as { acquireVsCodeApi?: () => MockVsCodeApi }).acquireVsCodeApi = mockAcquire;
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(globalThis as object, 'acquireVsCodeApi');
  });

  it('binds run script actions and sends executeBehavior messages', async () => {
    const module = await import('./main');
    const { container } = render(<module.App />);

    const layout = buildLayout([
      buttonObject({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'SaveButton',
        label: 'Save',
        x: 24,
        y: 24,
        width: 140,
        height: 36,
        zIndex: 0
      })
    ]);

    initializeDesigner(layout, ['Script_One', 'Script_Two']);

    const objectButton = await waitFor(() => {
      const button = container.querySelector('.object-list button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Object button not found');
      }

      return button;
    });
    fireEvent.click(objectButton);

    const behaviorTypeSelect = await waitFor(() => screen.getByLabelText('Behavior Type'));
    fireEvent.change(behaviorTypeSelect, { target: { value: 'runScript' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Behavior Script Name')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('Behavior Script Name'), {
      target: { value: 'Script_Two' }
    });
    fireEvent.change(screen.getByLabelText('Behavior Script Parameter'), {
      target: { value: 'record=42' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Behavior' }));

    await waitFor(() => {
      const executeMessage = postedMessages
        .slice()
        .reverse()
        .find(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            (entry as { type?: string }).type === 'executeBehavior'
        ) as
        | {
            payload?: {
              objectId?: string;
              objectName?: string;
              behavior?: { type?: string; scriptName?: string; parameter?: string };
            };
          }
        | undefined;

      expect(executeMessage).toBeDefined();
      expect(executeMessage?.payload?.objectId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(executeMessage?.payload?.objectName).toBe('SaveButton');
      expect(executeMessage?.payload?.behavior?.type).toBe('runScript');
      expect(executeMessage?.payload?.behavior?.scriptName).toBe('Script_Two');
      expect(executeMessage?.payload?.behavior?.parameter).toBe('record=42');
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'behaviorResult',
          payload: {
            ok: true,
            action: 'runScript',
            stub: true,
            message: 'Preview stub: would run script "Script_Two".'
          }
        }
      })
    );

    await waitFor(() => {
      expect(
        screen.getByText((content) => content.includes('OK [stub]: Preview stub: would run script "Script_Two".'))
      ).toBeDefined();
    });
  });
});
