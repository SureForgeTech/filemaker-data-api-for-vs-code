// fmweb-managed: runtime template v11. The FileMaker Data API Tools extension refreshes this file when the template version changes; keep your own changes in other files.
import type { LayoutObject } from '@fmweb/shared';

import { RuntimeBridgeClient } from './bridge-client';
export { normalizeBridgeBaseUrl } from './bridge-client';

export interface RuntimeBehaviorContext {
  layoutId?: string;
  layoutName: string;
  fmLayoutName?: string;
  bridgeBaseUrl?: string;
  bridgeToken?: string;
  currentRecordId?: string;
  currentRecordIndex?: number;
  currentFoundSetRecordIds?: string[];
  navigateToLayout: (
    layoutId: string,
    state?: {
      sourceLayoutId?: string;
      sourceLayoutName?: string;
      sourceFmLayoutName?: string;
      recordId?: string;
      currentRecordIndex?: number;
      foundSetRecordIds?: string[];
    }
  ) => void;
  openUrl: (url: string) => void;
  showDialog: (dialogId: string, parameter?: string) => void;
  fetchFn?: typeof fetch;
}

export interface RuntimeBehaviorResult {
  ok: boolean;
  action: string;
  stub: boolean;
  message: string;
  detail?: unknown;
}

export async function executeRuntimeBehaviorAction(
  object: LayoutObject,
  context: RuntimeBehaviorContext
): Promise<RuntimeBehaviorResult> {
  const behavior = object.behavior;
  const action = behavior?.type;

  if (!action) {
    return {
      ok: false,
      action: 'none',
      stub: true,
      message: `${object.name} has no behavior binding.`
    };
  }

  if (action === 'runScript') {
    const scriptName = normalizeOptionalString(behavior.scriptName);
    if (!scriptName) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${object.name} is missing a script name.`
      };
    }

    const bridgeClient = new RuntimeBridgeClient(context.bridgeBaseUrl, context.fetchFn, context.bridgeToken);
    if (!bridgeClient.isConfigured()) {
      return {
        ok: true,
        action,
        stub: true,
        message: `Runtime stub: would run script "${scriptName}". Configure NEXT_PUBLIC_FMWEB_BRIDGE_URL for live execution.`
      };
    }

    const layout = normalizeOptionalString(context.fmLayoutName) ?? context.layoutName;
    const requestBody: {
      layout: string;
      scriptName: string;
      scriptParam?: string;
      recordId?: string;
    } = {
      layout,
      scriptName,
      scriptParam: behavior.parameter,
      recordId: normalizeOptionalString(context.currentRecordId)
    };

    try {
      const detail = await bridgeClient.runScript(requestBody);

      return {
        ok: true,
        action,
        stub: false,
        message: `Executed script "${scriptName}" on "${layout}".`,
        detail
      };
    } catch (error) {
      return {
        ok: false,
        action,
        stub: false,
        message: formatError(error)
      };
    }
  }

  if (action === 'goToWebLayout') {
    const targetLayoutId = normalizeOptionalString(behavior.targetLayoutId);
    if (!targetLayoutId) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${object.name} is missing a target web layout ID.`
      };
    }

    context.navigateToLayout(targetLayoutId, {
      sourceLayoutId: normalizeOptionalString(context.layoutId),
      sourceLayoutName: context.layoutName,
      sourceFmLayoutName: normalizeOptionalString(context.fmLayoutName),
      recordId: normalizeOptionalString(context.currentRecordId),
      currentRecordIndex:
        typeof context.currentRecordIndex === 'number' && Number.isFinite(context.currentRecordIndex)
          ? Math.max(0, Math.floor(context.currentRecordIndex))
          : undefined,
      foundSetRecordIds: Array.isArray(context.currentFoundSetRecordIds)
        ? context.currentFoundSetRecordIds.filter((item) => item.trim().length > 0)
        : undefined
    });
    return {
      ok: true,
      action,
      stub: false,
      message: `Navigating to web layout "${targetLayoutId}".`
    };
  }

  if (action === 'goToFmLayout') {
    const targetLayoutName = normalizeOptionalString(behavior.targetFmLayoutName);
    if (!targetLayoutName) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${object.name} is missing a target FileMaker layout name.`
      };
    }

    return {
      ok: true,
      action,
      stub: true,
      message: `Runtime stub: would open FileMaker layout "${targetLayoutName}".`
    };
  }

  if (action === 'openUrl') {
    const url = normalizeOptionalString(behavior.url);
    if (!url) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${object.name} is missing a URL.`
      };
    }

    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Unsupported URL scheme.');
    } catch {
      return { ok: false, action, stub: true, message: 'Only http: and https: URLs can be opened.' };
    }

    context.openUrl(url);
    return {
      ok: true,
      action,
      stub: false,
      message: `Opened ${url}.`
    };
  }

  const dialogId = normalizeOptionalString(behavior.dialogId) ?? 'dialog';
  context.showDialog(dialogId, normalizeOptionalString(behavior.parameter));
  return {
    ok: true,
    action,
    stub: false,
    message: `Displayed dialog "${dialogId}".`
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected runtime behavior error.';
}
