import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createBlankLayout, type FieldLayoutObject, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

import { App } from './main';

afterEach(() => {
  cleanup();
});

function fieldObject(options: {
  id: string;
  name: string;
  fmFieldName: string;
  displayType: FieldLayoutObject['displayType'];
  format: FieldLayoutObject['format'];
  labelPosition: FieldLayoutObject['labelPosition'];
  required: boolean;
  label?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex: number;
}): LayoutObject {
  return {
    id: options.id,
    type: 'field',
    name: options.name,
    fmFieldName: options.fmFieldName,
    displayType: options.displayType,
    format: options.format,
    labelPosition: options.labelPosition,
    required: options.required,
    label: options.label,
    x: options.x,
    y: options.y,
    width: options.width ?? 220,
    height: options.height ?? 44,
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
  const base = createBlankLayout('Field Fidelity Layout');
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
          projectName: 'FM Field Fidelity Test'
        }
      }
    })
  );
}

describe('field fidelity', () => {
  it('renders realistic field display variants in designer preview', async () => {
    const { container } = render(<App />);

    const layout = buildLayout([
      fieldObject({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'amount-field',
        fmFieldName: 'Amount',
        displayType: 'editBox',
        format: 'number',
        labelPosition: 'top',
        required: true,
        label: 'Amount',
        x: 16,
        y: 16,
        zIndex: 0
      }),
      fieldObject({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'status-field',
        fmFieldName: 'Status',
        displayType: 'dropdown',
        format: 'text',
        labelPosition: 'left',
        required: false,
        label: 'Status',
        x: 16,
        y: 88,
        zIndex: 1
      }),
      fieldObject({
        id: '33333333-3333-4333-8333-333333333333',
        name: 'approved-field',
        fmFieldName: 'Approved',
        displayType: 'checkbox',
        format: 'text',
        labelPosition: 'right',
        required: false,
        label: 'Approved',
        x: 16,
        y: 160,
        zIndex: 2
      }),
      fieldObject({
        id: '44444444-4444-4444-8444-444444444444',
        name: 'priority-field',
        fmFieldName: 'Priority',
        displayType: 'radio',
        format: 'text',
        labelPosition: 'top',
        required: false,
        label: 'Priority',
        x: 16,
        y: 232,
        zIndex: 3
      })
    ]);

    initializeDesigner(layout, ['Amount', 'Status', 'Approved', 'Priority']);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-fm-field-control]').length).toBe(4);
    });

    const editInput = container.querySelector('[data-fm-field-control="editBox"] input') as HTMLInputElement | null;
    expect(editInput).not.toBeNull();
    expect(editInput?.value).toBe('12,450.25');

    expect(container.querySelector('[data-fm-field-control="dropdown"] select')).not.toBeNull();
    expect(container.querySelector('[data-fm-field-control="checkbox"] input[type="checkbox"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-fm-field-control="radio"] input[type="radio"]').length).toBe(2);

    expect(container.querySelector('[data-required-indicator="true"]')).not.toBeNull();
  });

  it('updates field renderer when inspector properties change', async () => {
    const { container } = render(<App />);

    const fieldId = '55555555-5555-4555-8555-555555555555';
    const layout = buildLayout([
      fieldObject({
        id: fieldId,
        name: 'customer-field',
        fmFieldName: 'CustomerName',
        displayType: 'editBox',
        format: 'text',
        labelPosition: 'top',
        required: false,
        x: 24,
        y: 24,
        zIndex: 0
      })
    ]);

    initializeDesigner(layout, ['CustomerName', 'CustomerID']);

    const objectListButton = await waitFor(() => {
      const button = container.querySelector('.object-list button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Object list button not found');
      }
      return button;
    });

    fireEvent.click(objectListButton);

    const displayTypeSelect = await waitFor(() => screen.getByLabelText('Display Type'));
    fireEvent.change(displayTypeSelect, { target: { value: 'dropdown' } });

    await waitFor(() => {
      expect(container.querySelector(`[data-fm-field-id="${fieldId}"][data-fm-field-control="dropdown"] select`)).not.toBeNull();
    });

    fireEvent.change(displayTypeSelect, { target: { value: 'editBox' } });
    fireEvent.change(screen.getByLabelText('Field Format'), { target: { value: 'date' } });

    await waitFor(() => {
      const dateInput = container.querySelector(
        `[data-fm-field-id="${fieldId}"][data-fm-field-control="editBox"] input`
      ) as HTMLInputElement | null;
      expect(dateInput?.type).toBe('text');
      expect(dateInput?.value).toBe('2026-03-03');
    });

    fireEvent.change(screen.getByLabelText('Label Position'), { target: { value: 'none' } });
    fireEvent.click(screen.getByLabelText('Required Indicator'));

    await waitFor(() => {
      expect(container.querySelector(`[data-fm-field-id="${fieldId}"] [data-required-indicator="true"]`)).toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Label Position'), { target: { value: 'top' } });

    await waitFor(() => {
      expect(container.querySelector(`[data-fm-field-id="${fieldId}"] [data-required-indicator="true"]`)).not.toBeNull();
    });
  });
});
