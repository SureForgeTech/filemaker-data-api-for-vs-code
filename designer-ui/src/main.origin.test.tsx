import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
  const base = createBlankLayout('Origin Guard Layout');
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

function dispatchInit(layout: LayoutDefinition, origin: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      data: {
        type: 'init',
        payload: {
          layout,
          availableFields: ['Name'],
          scripts: [],
          projectName: 'FM Origin Test'
        }
      }
    })
  );
}

describe('shipped Layout Mode page (designer-ui/src/main.tsx) honours the origin guard', () => {
  it('handles an init message dispatched from its own origin', async () => {
    render(<App />);

    dispatchInit(
      buildLayout([
        rectangleObject({ id: 'rect-origin', name: 'SameOriginBox', x: 40, y: 40, width: 100, height: 40, zIndex: 0 })
      ]),
      window.location.origin
    );

    await waitFor(() => {
      expect(screen.getAllByText('SameOriginBox').length).toBeGreaterThan(0);
    });
  });

  it('ignores an init message dispatched from a foreign origin', async () => {
    render(<App />);

    await act(async () => {
      dispatchInit(
        buildLayout([
          rectangleObject({ id: 'rect-foreign', name: 'ForeignBox', x: 40, y: 40, width: 100, height: 40, zIndex: 0 })
        ]),
        'https://attacker.invalid'
      );
    });

    expect(screen.queryByText('ForeignBox')).toBeNull();
  });
});
