// Which kind each policy-relevant setting is, and a pure explanation of what is in effect and why.
// The EFFECTIVE value is always supplied by the caller from the reader that enforces the
// setting (readRestrictedSetting, readUserScopeValue, RoleGuard, SettingsService); this module
// only compares it with what each scope holds, so the explanation cannot disagree with the rule.

import { ROLE_RANK, isRoleName } from '../enterprise/roles';
import type { RestrictedReading } from '../utils/policySetting';
import { usableRelativeDir } from '../utils/relativeDir';

export type SettingKind =
  /** `"scope": "application"`: only the user's own settings count. */
  | 'user-only'
  /** An on/off switch where a workspace may only move toward `restrictedValue`. */
  | 'stricter-bool'
  /** The enterprise role: a workspace may only lower it. */
  | 'stricter-role'
  /** A list where every scope adds to the others (a workspace can add, never remove). */
  | 'stricter-union'
  /** An ordinary setting a workspace may set (VS Code ignores some of them in Restricted Mode). */
  | 'workspace';

export interface PolicySetting {
  /** The key without the `filemaker.` prefix. */
  key: string;
  kind: SettingKind;
  /** For `stricter-bool`: the value that means "more restricted". */
  restrictedValue?: boolean;
  /** The code ignores this setting's workspace value in an untrusted workspace, whatever VS Code does. */
  forcedWhenUntrusted?: boolean;
}

export const POLICY_SETTINGS: readonly PolicySetting[] = [
  { key: 'offline.mode', kind: 'stricter-bool', restrictedValue: true },
  { key: 'features.batch.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'features.recordEdit.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'features.scriptRunner.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'features.ai.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'enterprise.mode', kind: 'stricter-bool', restrictedValue: true },
  { key: 'enterprise.role', kind: 'stricter-role' },
  { key: 'ai.hiddenFields', kind: 'stricter-union' },
  { key: 'ai.enabled', kind: 'user-only' },
  { key: 'ai.allowWrites', kind: 'user-only' },
  { key: 'ai.allowScripts', kind: 'user-only' },
  { key: 'ai.scriptAllowlist', kind: 'user-only' },
  { key: 'ai.readableLayouts', kind: 'user-only' },
  { key: 'ai.connection', kind: 'user-only' },
  { key: 'ai.contextPath', kind: 'user-only' },
  { key: 'ai.externalServer.enabled', kind: 'user-only' },
  { key: 'secrets.fallback', kind: 'user-only' },
  { key: 'export.neutralizeFormulas', kind: 'user-only' },
  { key: 'snippets.includeAuthByDefault', kind: 'user-only' },
  { key: 'schema.hashAlgorithm', kind: 'user-only' },
  { key: 'fmWeb.bridge.rateLimitPerSecond', kind: 'user-only' },
  { key: 'fmWeb.bridge.rateLimitBurst', kind: 'user-only' },
  { key: 'fmWeb.bridge.requestBudget', kind: 'user-only' },
  { key: 'savedQueries.scope', kind: 'workspace' },
  { key: 'typegen.outputDir', kind: 'workspace' },
  { key: 'schema.snapshots.storage', kind: 'workspace', forcedWhenUntrusted: true },
  { key: 'batch.maxRecords', kind: 'workspace' },
  { key: 'batch.concurrency', kind: 'workspace' },
  { key: 'batch.dryRunDefault', kind: 'workspace' }
];

export const BADGE_USER_ONLY = '**User settings only.**';
export const BADGE_STRICTER = '**Workspace can only make this stricter.**';
export const BADGE_WORKSPACE = '**Per workspace.**';

export function badgeFor(kind: SettingKind | undefined): string {
  if (kind === 'user-only') {
    return BADGE_USER_ONLY;
  }
  return kind === 'stricter-bool' || kind === 'stricter-role' || kind === 'stricter-union'
    ? BADGE_STRICTER
    : BADGE_WORKSPACE;
}

export function policyFor(key: string): PolicySetting | undefined {
  return POLICY_SETTINGS.find((setting) => setting.key === key.replace(/^filemaker\./, ''));
}

export type SettingSource =
  | 'Default'
  | 'User'
  | 'Workspace'
  | 'Workspace Folder'
  | 'User and Workspace'
  | 'Enterprise file'
  | 'Restricted Mode';

/** What each scope holds for one setting. `workspaceFile` is read from a settings file directly. */
export interface ScopeValues {
  default?: unknown;
  user?: unknown;
  workspace?: unknown;
  workspaceFolder?: unknown;
  /** VS Code drops application-scope keys from `inspect()` for a workspace, so the file is read instead. */
  workspaceFile?: unknown;
  /** What `.vscode/filemaker.config.json` asks for (enterprise mode and role only). */
  enterpriseFile?: unknown;
}

export interface ExplainInput {
  setting: PolicySetting;
  values: ScopeValues;
  /** The value the enforcing reader returned. */
  effective: unknown;
  trusted: boolean;
  /** The setting is in `capabilities.untrustedWorkspaces.restrictedConfigurations`. */
  restrictedInUntrusted: boolean;
  /** For on/off switches: the pieces `readRestrictedSetting` itself was computed from. */
  reading?: RestrictedReading;
}

export interface Explanation {
  key: string;
  kind: SettingKind;
  effective: unknown;
  source: SettingSource;
  userValue: unknown;
  /** The workspace folder value, else the workspace value, else the one found in a settings file. */
  workspaceValue: unknown;
  /** A workspace value exists and is not what is in effect. */
  ignored: boolean;
  /** The ignored value differs from what is in effect, so telling the user is worthwhile. */
  noticeWorthy: boolean;
  /** For the escaped view: may quote (capped) values. */
  reason?: string;
  /** For a notification: a fixed sentence that never contains a value from a file. */
  noticeReason?: string;
  /** Something worth knowing even when no workspace value is present. */
  note?: string;
  /** Opening the Workspace tab for this setting can change something. */
  workspaceMeaningful: boolean;
}

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const onOff = (value: unknown): string => (value === true ? 'on' : value === false ? 'off' : String(value));

/** A value for display, capped so a hostile file cannot flood the view. */
export function fmt(value: unknown, max = 80): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unprintable]';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const RESTRICTED_MODE_REASON =
  'This workspace is in Restricted Mode, so workspace values for this setting are ignored until you trust it.';
const USER_ONLY_NOTICE = 'this setting only works in User settings';
const RESTRICTED_MODE_NOTICE =
  'this workspace is in Restricted Mode, so workspace values for this setting are ignored until you trust it';

/**
 * Sentences about a configured value that the extension does not use as written. They explain a
 * value that is present and in force, so they appear whichever scope holds it.
 */
function valueNotes(setting: PolicySetting, values: ScopeValues, restrictedMode: boolean): string[] {
  const notes: string[] = [];
  if (setting.kind === 'stricter-role') {
    // The user's own value is the baseline. Anything but viewer, developer or admin counts as developer.
    const own = values.user;
    if (own !== undefined && !isRoleName(own)) {
      notes.push(`Your User value ${fmt(own)} is not a role (viewer, developer or admin), so it is treated as developer.`);
    }
  } else if (setting.key === 'typegen.outputDir') {
    // The value that is actually in force: in Restricted Mode the workspace value is hidden, so only the
    // User value counts. Judge it with the same rule the code uses (usableRelativeDir), and only say it
    // is unusable when it really is; Restricted Mode is never the reason this note appears.
    const inForce = restrictedMode ? values.user : (values.workspaceFolder ?? values.workspace ?? values.workspaceFile ?? values.user);
    if (typeof inForce === 'string' && usableRelativeDir(inForce) === undefined) {
      notes.push(
        `The value ${fmt(inForce)} is not a folder inside the workspace (it is empty, absolute, contains "..", or has a control or invisible character), so the default ${fmt(values.default)} is used.`
      );
    }
  }
  return notes;
}

export function explainSetting(input: ExplainInput): Explanation {
  const { setting, values, effective, trusted } = input;
  const id = `filemaker.${setting.key}`;
  const workspaceValue = values.workspaceFolder ?? values.workspace ?? values.workspaceFile;
  const hasWorkspace = workspaceValue !== undefined;
  const reading = input.reading;
  const baseline = reading ? reading.baseline : (values.user ?? values.default);
  const fromUser = reading ? reading.baselineFrom === 'user' : values.user !== undefined;
  const baselineLabel = fromUser ? 'User' : 'default';
  const userSource: SettingSource = fromUser ? 'User' : 'Default';
  const workspaceSource: SettingSource = values.workspaceFolder !== undefined ? 'Workspace Folder' : 'Workspace';
  const restrictedMode =
    setting.kind !== 'user-only' && !trusted && (input.restrictedInUntrusted || setting.forcedWhenUntrusted === true);

  let source: SettingSource = userSource;
  let ignored = false;
  let reason: string | undefined;
  let noticeReason: string | undefined;
  let note: string | undefined;
  let workspaceMeaningful = true;
  const extraNotes = valueNotes(setting, values, restrictedMode);

  if (restrictedMode) {
    // VS Code hides restricted keys from a workspace that is not trusted, and the code does not
    // read them either, so a workspace layer never counts, whatever the kind.
    if (values.enterpriseFile !== undefined && same(values.enterpriseFile, effective) && !same(baseline, effective)) {
      source = 'Enterprise file';
    } else if (setting.forcedWhenUntrusted) {
      source = 'Restricted Mode';
    }
    if (hasWorkspace) {
      ignored = true;
      reason = RESTRICTED_MODE_REASON;
      noticeReason = RESTRICTED_MODE_NOTICE;
    } else {
      note = RESTRICTED_MODE_REASON;
    }
    return finish();
  }

  switch (setting.kind) {
    case 'user-only': {
      workspaceMeaningful = false;
      if (hasWorkspace) {
        ignored = true;
        reason = `This setting only works in User settings; the workspace value (${fmt(workspaceValue)}) is ignored.`;
        noticeReason = USER_ONLY_NOTICE;
      }
      break;
    }
    case 'stricter-bool': {
      const restricted = setting.restrictedValue;
      if (values.enterpriseFile === restricted && baseline !== restricted) {
        source = 'Enterprise file';
      } else if (hasWorkspace && (reading ? reading.workspaceCounted : workspaceValue === restricted) && baseline !== restricted) {
        source = workspaceSource;
      }
      if (hasWorkspace && workspaceValue !== effective) {
        ignored = true;
        reason =
          `This workspace sets ${setting.key} to ${fmt(workspaceValue)} but your ${baselineLabel} value is ` +
          `${fmt(baseline)}, and a workspace can only turn it ${restricted === true ? 'on' : 'off'}, ` +
          `so it stays ${onOff(effective)}.`;
        noticeReason = `a workspace can only turn it ${restricted === true ? 'on' : 'off'}, so it stays ${onOff(effective)}`;
      }
      break;
    }
    case 'stricter-role': {
      if (!same(effective, baseline) && values.enterpriseFile === effective) {
        source = 'Enterprise file';
      } else if (!same(effective, baseline) && same(effective, workspaceValue)) {
        source = workspaceSource;
      }
      if (hasWorkspace && !isRoleName(workspaceValue)) {
        ignored = true;
        reason = `This workspace sets ${setting.key} to ${fmt(workspaceValue)}, which is not a role, so it is ignored.`;
        noticeReason = 'it is not a valid role';
      } else if (hasWorkspace && isRoleName(workspaceValue) && isRoleName(effective) && ROLE_RANK[workspaceValue] > ROLE_RANK[effective]) {
        ignored = true;
        reason =
          `This workspace sets ${setting.key} to ${fmt(workspaceValue)} but your ${baselineLabel} value is ` +
          `${fmt(baseline)}, and a workspace can only lower the role, so it stays ${fmt(effective)}.`;
        noticeReason = 'a workspace can only lower the role';
      }
      break;
    }
    case 'stricter-union': {
      source = hasWorkspace ? 'User and Workspace' : userSource;
      break;
    }
    case 'workspace': {
      if (hasWorkspace) {
        source = workspaceSource;
      }
      break;
    }
  }
  return finish();

  function finish(): Explanation {
    return {
      key: id,
      kind: setting.kind,
      effective,
      source,
      userValue: values.user,
      workspaceValue,
      ignored,
      noticeWorthy: ignored && !same(workspaceValue, effective),
      ...(reason ? { reason } : {}),
      ...(noticeReason ? { noticeReason } : {}),
      ...(note || extraNotes.length > 0 ? { note: [note, ...extraNotes].filter(Boolean).join(' ') } : {}),
      workspaceMeaningful
    };
  }
}

// --- one notification per ignored setting per workspace --------------------------------------

export interface NoticeState {
  /** Setting keys already announced in this workspace. */
  seen: string[];
  /** The user chose "Don't show again for this workspace". */
  muted: boolean;
}

export const EMPTY_NOTICE_STATE: NoticeState = { seen: [], muted: false };

/** Which ignored settings to announce now, and the state to store. Announcing marks them seen. */
export function pickNotices(
  explanations: readonly Explanation[],
  state: NoticeState
): { show: Explanation[]; next: NoticeState } {
  if (state.muted) {
    return { show: [], next: state };
  }
  const show = explanations.filter((entry) => entry.noticeWorthy && !state.seen.includes(entry.key));
  return show.length === 0
    ? { show, next: state }
    : { show, next: { ...state, seen: [...state.seen, ...show.map((entry) => entry.key)] } };
}

/**
 * The text of the one notification. Built only from registry keys and fixed sentences: notification
 * text renders Markdown links that can run commands, so nothing from a settings file goes in.
 */
export function noticeMessage(show: readonly Explanation[]): string {
  const [first] = show;
  if (first && show.length === 1) {
    return `This workspace sets ${first.key} but it is ignored: ${first.noticeReason ?? 'it has no effect here'}.`;
  }
  return `This workspace sets ${show.length} settings that are ignored: ${show.map((entry) => entry.key).join(', ')}.`;
}

// --- reading `.vscode/settings.json` -----------------------------------------------------------

/** The largest settings file the extension will read (VS Code's own are a few KB). */
export const MAX_SETTINGS_FILE_BYTES = 256 * 1024;

/** Removes comments, a leading BOM and trailing commas from JSONC in one linear pass, leaving strings alone. */
export function stripJsonc(text: string): string {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (inString) {
      out.push(ch);
      if (ch === '\\') {
        out.push(next ?? '');
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out.push(ch);
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      out.push('\n');
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
    } else if (ch === '}' || ch === ']') {
      // Drop a comma that only whitespace separates from this closer.
      let back = out.length - 1;
      while (back >= 0 && /\s/.test(out[back] as string)) {
        back -= 1;
      }
      if (back >= 0 && out[back] === ',') {
        out.splice(back, 1);
      }
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

export type ParsedSettings = { ok: true; values: Record<string, unknown> } | { ok: false };

/** The `filemaker.*` entries of a settings file, keyed without the prefix. Oversized or invalid text is `{ ok: false }`. */
export function parseFilemakerSettings(text: string, section?: string): ParsedSettings {
  if (text.length > MAX_SETTINGS_FILE_BYTES) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(stripJsonc(text)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    const holder = section ? (parsed as Record<string, unknown>)[section] : parsed;
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) {
      return section ? { ok: true, values: {} } : { ok: false };
    }
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(holder)) {
      if (key.startsWith('filemaker.')) {
        values[key.slice('filemaker.'.length)] = value;
      }
    }
    return { ok: true, values };
  } catch {
    return { ok: false };
  }
}
