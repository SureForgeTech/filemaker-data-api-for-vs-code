// fmweb-managed: runtime template v11. Field presentation uses the shared designer rules.
import { serverOrigin, standardFieldsCss } from '@fmweb/shared';
import { notFound } from 'next/navigation';
import type { JSX } from 'react';

import { loadLayoutDefinition } from '../../../lib/layout-loader';
import { RuntimeLayoutClient } from './runtime-layout-client';

interface LayoutPageProps {
  params: Promise<{
    id: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LayoutPage({ params, searchParams }: LayoutPageProps): Promise<JSX.Element> {
  const { id } = await params;
  const query = await searchParams;
  const layout = await loadLayoutDefinition(id);

  if (!layout) {
    notFound();
  }

  const initialRecordId = readSingleSearchParam(query?.recordId);
  const initialRecordIndex = readNumberSearchParam(query?.foundIndex);

  return (
    <main className="runtime-layout-page" data-fm-field-layout="standard">
      <style>{standardFieldsCss()}</style>
      <RuntimeLayoutClient
        layout={layout}
        serverOrigin={serverOrigin(process.env.FMWEB_SERVER_ORIGIN)}
        debug={readSingleSearchParam(query?.debug) === '1'}
        initialRecordId={initialRecordId}
        initialRecordIndex={initialRecordIndex}
      />
    </main>
  );
}

function readSingleSearchParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === 'string') {
      const trimmed = first.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }

  return undefined;
}

function readNumberSearchParam(value: string | string[] | undefined): number | undefined {
  const resolved = readSingleSearchParam(value);
  if (!resolved) {
    return undefined;
  }

  const parsed = Number(resolved);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(0, Math.floor(parsed));
}
