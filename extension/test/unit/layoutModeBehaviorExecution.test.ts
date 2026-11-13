import { describe, expect, it, vi } from 'vitest';

import type { ConnectionProfile } from '../../src/types/fm';
import { executeBehaviorBinding } from '../../src/webviews/layoutMode/behaviorExecution';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Local',
  serverUrl: 'https://example.com',
  database: 'AppDB',
  authMode: 'direct',
  username: 'dev'
};

describe('layout mode behavior execution', () => {
  it.each(['javascript:alert(1)', 'data:text/html,evil', 'file:///etc/passwd', 'command:evil', '//evil.example'])('A4 refuses unsafe URL %s in Layout Mode too', async (url) => {
    const result = await executeBehaviorBinding({
      behavior: { type: 'openUrl', url }, objectName: 'B', layoutName: 'L', runScript: vi.fn()
    });
    expect(result).toMatchObject({ ok: false, action: 'openUrl', stub: true });
    expect(result.message).toContain('Only http: and https:');
  });

  it('returns stub result when runScript has no active profile', async () => {
    const runScript = vi.fn();

    const result = await executeBehaviorBinding({
      behavior: {
        type: 'runScript',
        scriptName: 'Save_Record',
        parameter: 'id=42'
      },
      objectName: 'SaveButton',
      layoutName: 'Contacts',
      runScript
    });

    expect(result.ok).toBe(true);
    expect(result.stub).toBe(true);
    expect(result.action).toBe('runScript');
    expect(result.message).toContain('Preview stub');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('executes runScript against FileMaker when profile is available', async () => {
    const runScript = vi.fn(async () => ({
      response: { scriptResult: 'OK' },
      messages: [{ code: '0', message: 'OK' }]
    }));

    const result = await executeBehaviorBinding({
      behavior: {
        type: 'runScript',
        scriptName: 'Save_Record',
        parameter: 'id=42'
      },
      objectName: 'SaveButton',
      layoutName: 'Contacts',
      profile,
      runScript
    });

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledWith(profile, {
      layout: 'Contacts',
      scriptName: 'Save_Record',
      scriptParam: 'id=42'
    });
    expect(result.ok).toBe(true);
    expect(result.stub).toBe(false);
    expect(result.action).toBe('runScript');
    expect(result.message).toContain('Executed script "Save_Record"');
  });

  it('validates required targets for navigation behaviors', async () => {
    const runScript = vi.fn();

    const missingTarget = await executeBehaviorBinding({
      behavior: {
        type: 'goToFmLayout'
      },
      objectName: 'NavButton',
      layoutName: 'Contacts',
      runScript
    });

    expect(missingTarget.ok).toBe(false);
    expect(missingTarget.stub).toBe(true);
    expect(missingTarget.message).toContain('missing a target FileMaker layout name');

    const withTarget = await executeBehaviorBinding({
      behavior: {
        type: 'goToFmLayout',
        targetFmLayoutName: 'Invoices'
      },
      objectName: 'NavButton',
      layoutName: 'Contacts',
      runScript
    });

    expect(withTarget.ok).toBe(true);
    expect(withTarget.stub).toBe(true);
    expect(withTarget.message).toContain('would open FileMaker layout "Invoices"');
  });

  it('reports a script that ran but returned a script error as a failure, with the code and its meaning', async () => {
    const runScript = vi.fn(async () => ({
      response: { scriptError: '3' },
      messages: [{ code: '0', message: 'OK' }]
    }));
    const result = await executeBehaviorBinding({
      behavior: { type: 'runScript', scriptName: 'Save_Record' },
      objectName: 'SaveButton',
      layoutName: 'Contacts',
      fmLayoutName: 'Contacts',
      profile,
      runScript
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Ran script "Save_Record" on "Contacts", but the script reported error 3/);
  });

  it('a script error of 0 is still a success', async () => {
    const result = await executeBehaviorBinding({
      behavior: { type: 'runScript', scriptName: 'Save_Record' },
      objectName: 'SaveButton',
      layoutName: 'Contacts',
      fmLayoutName: 'Contacts',
      profile,
      runScript: vi.fn(async () => ({ response: { scriptError: '0' }, messages: [] }))
    });
    expect(result.ok).toBe(true);
  });
});
