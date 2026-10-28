import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createBlankLayout, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

import { App } from './main';

afterEach(() => {
  cleanup();
});

function portalObject(options: {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  relatedContext?: string;
  rowCount?: number;
  columns?: Array<{ id: string; fmFieldName: string; label: string; width: number }>;
  scroll?: boolean;
  selectableRows?: boolean;
}): LayoutObject {
  return {
    id: options.id,
    type: 'portal',
    name: options.name,
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
    },
    relatedContext: options.relatedContext ?? '',
    rowCount: options.rowCount ?? 5,
    columns: options.columns ?? [],
    scroll: options.scroll ?? true,
    selectableRows: options.selectableRows ?? false
  };
}

function buildLayout(objects: LayoutObject[]): LayoutDefinition {
  const base = createBlankLayout('Portal Builder Layout');
  return {
    ...base,
    canvas: {
      width: 800,
      height: 480,
      gridSize: 8
    },
    objects
  };
}

function initializeDesigner(layout: LayoutDefinition, fields: string[] = []): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      data: {
        type: 'init',
        payload: {
          layout,
          availableFields: fields,
          scripts: [],
          projectName: 'FM Portal Builder Test'
        }
      }
    })
  );
}

describe('portal builder', () => {
  it('supports portal property editing and column editor actions', async () => {
    const { container } = render(<App />);

    const portalId = '66666666-6666-4666-8666-666666666666';
    const layout = buildLayout([
      portalObject({
        id: portalId,
        name: 'OrdersPortal',
        x: 16,
        y: 16,
        width: 500,
        height: 240,
        zIndex: 0
      })
    ]);

    initializeDesigner(layout, ['CustomerName', 'Amount']);

    const objectButton = await waitFor(() => {
      const button = container.querySelector('.object-list button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Portal object button not found');
      }
      return button;
    });

    fireEvent.click(objectButton);

    const relatedContextInput = await waitFor(() => screen.getByLabelText('Portal Related Context'));
    fireEvent.change(relatedContextInput, { target: { value: 'Invoice__Orders' } });
    fireEvent.change(screen.getByLabelText('Portal Row Count'), { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText('Portal Scroll'));
    fireEvent.click(screen.getByLabelText('Portal Selectable Rows'));

    await waitFor(() => {
      const rows = container.querySelectorAll(`[data-fm-portal-id="${portalId}"] [data-fm-portal-row]`);
      expect(rows.length).toBe(7);
      expect((screen.getByLabelText('Portal Scroll') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByLabelText('Portal Selectable Rows') as HTMLInputElement).checked).toBe(true);
    });

    const dropzone = container.querySelector('[data-portal-dropzone="true"]');
    if (!(dropzone instanceof HTMLDivElement)) {
      throw new Error('Portal dropzone not found');
    }

    fireEvent.drop(dropzone, {
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-fmweb-tool'
            ? JSON.stringify({ type: 'field', fieldName: 'CustomerName' })
            : ''
      }
    });

    await waitFor(() => {
      expect(container.querySelectorAll('.portal-column-row').length).toBe(1);
    });

    fireEvent.change(screen.getByLabelText('Portal Column Width CustomerName'), { target: { value: '220' } });

    await waitFor(() => {
      expect((screen.getByLabelText('Portal Column Width CustomerName') as HTMLInputElement).value).toBe('220');
    });

    const amountPortalChip = Array.from(container.querySelectorAll('.portal-field-chip')).find(
      (button) => button.textContent?.trim() === 'Amount'
    );
    if (!(amountPortalChip instanceof HTMLButtonElement)) {
      throw new Error('Portal Amount field chip not found');
    }

    fireEvent.click(amountPortalChip);

    await waitFor(() => {
      expect(container.querySelectorAll('.portal-column-row').length).toBe(2);
    });

    fireEvent.click(screen.getByLabelText('Move CustomerName down'));

    await waitFor(() => {
      const rows = container.querySelectorAll('.portal-column-row');
      expect(rows[0]?.textContent).toContain('Amount');
      expect(rows[1]?.textContent).toContain('CustomerName');
    });

    fireEvent.click(screen.getByLabelText('Remove Amount'));

    await waitFor(() => {
      const rows = container.querySelectorAll('.portal-column-row');
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain('CustomerName');
      expect(container.querySelector('[data-fm-portal-cell="CustomerName:0"]')?.textContent).toBe('CustomerName 1');
      expect(container.querySelector('[data-fm-portal-cell="CustomerName:1"]')?.textContent).toBe('CustomerName 2');
    });
  });

  it('supports drag-drop reordering of portal columns', async () => {
    const { container } = render(<App />);

    const portalId = '77777777-7777-4777-8777-777777777777';
    const layout = buildLayout([
      portalObject({
        id: portalId,
        name: 'ReorderPortal',
        x: 16,
        y: 16,
        width: 500,
        height: 240,
        zIndex: 0,
        columns: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            fmFieldName: 'FirstName',
            label: 'FirstName',
            width: 120
          },
          {
            id: '99999999-9999-4999-8999-999999999999',
            fmFieldName: 'LastName',
            label: 'LastName',
            width: 140
          }
        ]
      })
    ]);

    initializeDesigner(layout, ['FirstName', 'LastName']);

    const objectButton = await waitFor(() => {
      const button = container.querySelector('.object-list button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Portal object button not found');
      }
      return button;
    });

    fireEvent.click(objectButton);

    await waitFor(() => {
      expect(container.querySelectorAll('.portal-column-row').length).toBe(2);
    });

    const rowsBefore = container.querySelectorAll('.portal-column-row');
    const targetRow = rowsBefore[0];

    fireEvent.drop(targetRow, {
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-fmweb-portal-column' ? '99999999-9999-4999-8999-999999999999' : ''
      }
    });

    await waitFor(() => {
      const rows = container.querySelectorAll('.portal-column-row');
      expect(rows[0]?.textContent).toContain('LastName');
      expect(rows[1]?.textContent).toContain('FirstName');
    });
  });
});
