import type { BehaviorBinding } from '../../fmweb/layoutSchema';
import { describeScriptErrors, extractScriptErrors } from '../../services/responseGuard';
import type { ConnectionProfile, RunScriptRequest } from '../../types/fm';

export interface ExecuteBehaviorBindingArgs {
  behavior: BehaviorBinding;
  objectName: string;
  layoutName: string;
  fmLayoutName?: string;
  profile?: ConnectionProfile;
  runScript: (profile: ConnectionProfile, request: RunScriptRequest) => Promise<unknown>;
}

export interface BehaviorExecutionResult {
  ok: boolean;
  action: string;
  stub: boolean;
  message: string;
  detail?: unknown;
}

export async function executeBehaviorBinding(
  args: ExecuteBehaviorBindingArgs
): Promise<BehaviorExecutionResult> {
  const action = args.behavior.type;
  const objectLabel = args.objectName.trim().length > 0 ? args.objectName : 'Object';

  if (!action) {
    return {
      ok: false,
      action: 'none',
      stub: true,
      message: `${objectLabel} has no behavior binding.`
    };
  }

  if (action === 'runScript') {
    const scriptName = normalizeOptionalString(args.behavior.scriptName);
    if (!scriptName) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${objectLabel} is missing a script name.`
      };
    }

    if (!args.profile) {
      return {
        ok: true,
        action,
        stub: true,
        message: `Preview stub: would run script "${scriptName}". Select an active profile to execute live.`
      };
    }

    const layout = normalizeOptionalString(args.fmLayoutName) ?? normalizeOptionalString(args.layoutName);
    if (!layout) {
      return {
        ok: false,
        action,
        stub: true,
        message: `Cannot run "${scriptName}" because no FileMaker layout is mapped.`
      };
    }

    const request: RunScriptRequest = {
      layout,
      scriptName,
      scriptParam: normalizeOptionalString(args.behavior.parameter)
    };

    try {
      const result = await args.runScript(args.profile, request);
      const scriptErrors = extractScriptErrors((result as { response?: unknown } | undefined)?.response);
      if (scriptErrors.length > 0) {
        return {
          ok: false,
          action,
          stub: false,
          message: `Ran script "${scriptName}" on "${layout}", but ${describeScriptErrors(scriptErrors)}.`,
          detail: result
        };
      }
      return {
        ok: true,
        action,
        stub: false,
        message: `Executed script "${scriptName}" on "${layout}" using profile "${args.profile.name}".`,
        detail: result
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
    const targetLayoutId = normalizeOptionalString(args.behavior.targetLayoutId);
    if (!targetLayoutId) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${objectLabel} is missing a target web layout ID.`
      };
    }

    return {
      ok: true,
      action,
      stub: true,
      message: `Preview stub: would navigate to web layout "${targetLayoutId}".`
    };
  }

  if (action === 'goToFmLayout') {
    const targetLayoutName = normalizeOptionalString(args.behavior.targetFmLayoutName);
    if (!targetLayoutName) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${objectLabel} is missing a target FileMaker layout name.`
      };
    }

    return {
      ok: true,
      action,
      stub: true,
      message: `Preview stub: would open FileMaker layout "${targetLayoutName}".`
    };
  }

  if (action === 'openUrl') {
    const url = normalizeOptionalString(args.behavior.url);
    if (!url) {
      return {
        ok: false,
        action,
        stub: true,
        message: `${objectLabel} is missing a URL.`
      };
    }

    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Unsupported URL scheme.');
    } catch {
      return { ok: false, action, stub: true, message: 'Only http: and https: URLs can be opened.' };
    }

    return {
      ok: true,
      action,
      stub: true,
      message: `Preview stub: would open ${url}.`
    };
  }

  const dialogId = normalizeOptionalString(args.behavior.dialogId) ?? 'dialog';
  return {
    ok: true,
    action,
    stub: true,
    message: `Preview stub: would show dialog "${dialogId}".`
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  // Names and parameters are used exactly as given; only an empty or all-blank value counts as missing.
  return value.trim().length > 0 ? value : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected behavior execution error.';
}
