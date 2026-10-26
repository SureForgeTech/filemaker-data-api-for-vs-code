import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createBlankLayout, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

import { App } from './main';

afterEach(() => {
  cleanup();
});

function rectangle(index: number): LayoutObject {
  return {
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    type: 'rectangle',
    name: `rect-${index}`,
    x: (index % 20) * 56,
    y: Math.floor(index / 20) * 36,
    width: 52,
    height: 30,
    zIndex: index,
    cornerRadius: 0,
    anchors: {
      top: true,
      right: false,
      bottom: false,
      left: true
    }
  };
}

function buildLargeLayout(objectCount: number): LayoutDefinition {
  const base = createBlankLayout('Stress Layout');
  return {
    ...base,
    canvas: {
      width: 1500,
      height: 1000,
      gridSize: 8
    },
    objects: Array.from({ length: objectCount }).map((_, index) => rectangle(index + 1))
  };
}

describe('designer performance stress', () => {
  it('renders 200+ objects without crashing', async () => {
    const { container } = render(<App />);

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'init',
          payload: {
            layout: buildLargeLayout(220),
            availableFields: [],
            scripts: [],
            projectName: 'FM Stress'
          }
        }
      })
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.object-hitbox').length).toBe(220);
    });
  });
});
