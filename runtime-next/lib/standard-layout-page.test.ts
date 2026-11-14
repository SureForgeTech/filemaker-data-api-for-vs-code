import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankLayout, FIELD_LAYOUT, standardFieldSize, type LayoutDefinition } from '@fmweb/shared';
import { loadLayoutDefinition } from './layout-loader';
import LayoutPage from '../app/layouts/[id]/page';

let viewport: { width: number; height: number } | undefined;
beforeEach(() => { viewport = undefined; });
afterEach(() => { vi.unstubAllEnvs(); });

vi.mock('./layout-loader', () => ({ loadLayoutDefinition: vi.fn() }));
vi.mock('../app/layouts/[id]/runtime-layout-client', async () => {
  const { LayoutContainer } = await import('@fmweb/shared');
  return { RuntimeLayoutClient: ({ layout }: { layout: LayoutDefinition }) => React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: { viewport } }) };
});

function fixture(): LayoutDefinition {
  const layout = createBlankLayout(' Exact layout ', ' Source ');
  layout.objects = ['text', 'number', 'date', 'time', 'timestamp', 'long text', 'container'].map((type, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, type: 'field', name: type,
    fmFieldName: ` ${type} `, displayType: 'editBox', format: 'text', required: false,
    labelPosition: FIELD_LAYOUT.labelPosition, ...standardFieldSize({ type }),
    x: 24, y: 24 + i * 220, zIndex: i, anchors: { top: true, left: true, right: false, bottom: false }
  }));
  return layout;
}

describe('web layout view page', () => {
  it('awaits Next route promises before reading identifiers and query values', async () => {
    vi.mocked(loadLayoutDefinition).mockResolvedValue(fixture());
    const route = await LayoutPage({
      params: Promise.resolve({ id: ' Exact id ' }),
      searchParams: Promise.resolve({ recordId: '19', foundIndex: '2', debug: '1' })
    });
    expect(loadLayoutDefinition).toHaveBeenCalledWith(' Exact id ');
    const client = React.Children.toArray(route.props.children).find((child) =>
      React.isValidElement(child) && child.type !== 'style') as React.ReactElement<Record<string, unknown>>;
    expect(client.props).toMatchObject({ initialRecordId: '19', initialRecordIndex: 2, debug: true });
  });

  it.each([['https://user:private@example.test:8443/path?session=private', 'https://example.test:8443'], ['invalid', undefined]])('passes only the server origin to the browser (%s)', async (url, expected) => {
    vi.stubEnv('FMWEB_SERVER_ORIGIN', url);
    vi.mocked(loadLayoutDefinition).mockResolvedValue(fixture());
    const route = await LayoutPage({ params: Promise.resolve({ id: 'layout' }) });
    const client = React.Children.toArray(route.props.children).find((child) =>
      React.isValidElement(child) && child.type !== 'style') as React.ReactElement<Record<string, unknown>>;
    expect(client.props.serverOrigin).toBe(expected);
    expect(JSON.stringify(client.props)).not.toContain('private');
  });

  it('renders the shared standard widths, full control heights and top labels', async () => {
    vi.mocked(loadLayoutDefinition).mockResolvedValue(fixture());
    const markup = renderToStaticMarkup(await LayoutPage({ params: Promise.resolve({ id: 'layout' }) }));
    expect(markup).toContain('data-fm-field-layout="standard"');
    for (const [width, height] of [[240, 34], [120, 34], [160, 34], [240, 96], [240, 160]]) {
      expect(markup).toContain(`data-fm-width="${width}" data-fm-height="${height}"`);
      expect(markup).toContain(`width:${width}px;height:${height + 24}px`);
    }
    expect(markup.match(/data-fm-label-position="top"/g)).toHaveLength(7);
    expect(markup).toContain(' text ');
    expect(markup).toContain('gap: 16px 24px');
    expect(markup).toMatch(/@media \(max-width: 640px\)[\s\S]*flex-direction: column/);
  });
  it('the runtime page stacks fields by visual position rather than z-order at narrow widths', async () => {
    const layout = fixture();
    layout.objects = [
      { ...layout.objects[0], id: 'bottom', y: 400, zIndex: 0 },
      { ...layout.objects[0], id: 'right', x: 300, y: 24, zIndex: 1 },
      { ...layout.objects[0], id: 'left', x: 24, y: 24, zIndex: 2 }
    ];
    viewport = { width: 400, height: 200 };
    vi.mocked(loadLayoutDefinition).mockResolvedValue(layout);
    const markup = renderToStaticMarkup(await LayoutPage({ params: Promise.resolve({ id: 'layout' }) }));
    for (const [id, y] of [['left', 24], ['right', 98], ['bottom', 172]]) {
      expect(markup).toMatch(new RegExp(`<div style="[^"]*left:24px;top:${y}px;[^"]*"[^>]*data-fm-field-id="${id}"`));
    }
  });

});
