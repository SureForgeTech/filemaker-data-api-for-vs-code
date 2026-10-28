import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createBlankLayout, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

import { App } from './main';

afterEach(() => {
  cleanup();
});

function rectangleObject(options: {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}): LayoutObject {
  return {
    id: options.id,
    type: 'rectangle',
    name: options.name,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    zIndex: options.zIndex,
    cornerRadius: 0,
    anchors: {
      top: true,
      right: false,
      bottom: false,
      left: true
    }
  };
}

function buildLayout(objects: LayoutObject[]): LayoutDefinition {
  const base = createBlankLayout('Interaction Test Layout');
  return {
    ...base,
    canvas: {
      width: 500,
      height: 320,
      gridSize: 8
    },
    objects
  };
}

function initializeDesigner(layout: LayoutDefinition): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      data: {
        type: 'init',
        payload: {
          layout,
          availableFields: ['Name'],
          scripts: [],
          projectName: 'FM Test Project'
        }
      }
    })
  );
}

function findHitboxByObjectName(name: string): HTMLDivElement {
  const labels = screen.getAllByText(name);
  const overlayLabel = labels.find((element) => element.classList.contains('object-name'));
  if (!overlayLabel) {
    throw new Error(`Overlay label not found for ${name}`);
  }

  const hitbox = overlayLabel.closest('.object-hitbox');
  if (!(hitbox instanceof HTMLDivElement)) {
    throw new Error(`Hitbox not found for ${name}`);
  }

  return hitbox;
}

describe('designer canvas interactions', () => {
  it('supports drag with undo/redo via toolbar buttons', async () => {
    render(<App />);

    const layout = buildLayout([
      rectangleObject({
        id: 'rect-1',
        name: 'DragBox',
        x: 40,
        y: 40,
        width: 100,
        height: 40,
        zIndex: 0
      })
    ]);

    initializeDesigner(layout);

    const hitbox = await waitFor(() => findHitboxByObjectName('DragBox'));

    fireEvent.mouseDown(hitbox, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseMove(window, { clientX: 80, clientY: 72 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(hitbox.style.left).toBe('80px');
      expect(hitbox.style.top).toBe('72px');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(hitbox.style.left).toBe('40px');
      expect(hitbox.style.top).toBe('40px');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() => {
      expect(hitbox.style.left).toBe('80px');
      expect(hitbox.style.top).toBe('72px');
    });
  });

  it('supports resize handles on selected objects', async () => {
    const { container } = render(<App />);

    const layout = buildLayout([
      rectangleObject({
        id: 'rect-2',
        name: 'ResizeBox',
        x: 30,
        y: 30,
        width: 80,
        height: 40,
        zIndex: 0
      })
    ]);

    initializeDesigner(layout);

    const objectListButton = await waitFor(() => {
      const button = container.querySelector('.object-list button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Object list button not found');
      }

      return button;
    });

    fireEvent.click(objectListButton);

    const handle = await waitFor(() => {
      const element = container.querySelector('.resize-handle.handle-se');
      if (!(element instanceof HTMLButtonElement)) {
        throw new Error('Resize handle not found');
      }
      return element;
    });

    fireEvent.mouseDown(handle, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 18, clientY: 10 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(screen.getByText('W: 96')).toBeDefined();
      expect(screen.getByText('H: 48')).toBeDefined();
    });
  });

  it('supports shift-marquee append to multi-select objects', async () => {
    const { container } = render(<App />);

    const layout = buildLayout([
      rectangleObject({
        id: 'rect-a',
        name: 'A',
        x: 10,
        y: 10,
        width: 40,
        height: 20,
        zIndex: 0
      }),
      rectangleObject({
        id: 'rect-b',
        name: 'B',
        x: 150,
        y: 10,
        width: 40,
        height: 20,
        zIndex: 1
      })
    ]);

    initializeDesigner(layout);

    const objectButtons = await waitFor(() => {
      const buttons = container.querySelectorAll('.object-list button');
      if (buttons.length < 2) {
        throw new Error('Object list buttons not found');
      }
      return buttons;
    });

    fireEvent.click(objectButtons[0]);

    const canvas = container.querySelector('.canvas-scroll');
    if (!(canvas instanceof HTMLDivElement)) {
      throw new Error('Canvas scroll container not found');
    }

    fireEvent.mouseDown(canvas, { button: 0, clientX: 140, clientY: 0, shiftKey: true });
    fireEvent.mouseMove(window, { clientX: 240, clientY: 80 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(screen.getByText('2 objects selected.')).toBeDefined();
    });
  });

  it('supports keyboard nudge and delete for selected objects', async () => {
    const { container } = render(<App />);

    const layout = buildLayout([
      rectangleObject({
        id: 'rect-key',
        name: 'KeyBox',
        x: 40,
        y: 40,
        width: 80,
        height: 40,
        zIndex: 0
      })
    ]);

    initializeDesigner(layout);

    const objectButton = await waitFor(() => {
      const button = container.querySelector('.object-list button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Object list button not found');
      }
      return button;
    });

    fireEvent.click(objectButton);

    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText('X: 48')).toBeDefined();
    });

    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => {
      expect(container.querySelectorAll('.object-hitbox').length).toBe(0);
      expect(container.querySelectorAll('.object-list button').length).toBe(0);
      expect(screen.getByText('Select an object to inspect.')).toBeDefined();
    });
  });
});
