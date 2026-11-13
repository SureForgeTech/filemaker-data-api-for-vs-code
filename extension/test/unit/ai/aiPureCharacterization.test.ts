import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  buildCreateConfirmation,
  buildDeleteConfirmation,
  buildEditConfirmation,
  buildScriptConfirmation
} from '../../../src/ai/aiConfirmations';
import { scrub } from '../../../src/ai/aiScrub';
import { AiToolError } from '../../../src/ai/aiToolService';
import * as legacy from '../../../src/ai/aiToolService';
import type { ConnectionProfile } from '../../../src/types/fm';

// Expected outputs were captured from aiToolService.ts before extracting its pure helpers.
// Keep the seed and inputs stable: hashes keep long outputs small while checking every byte.
// The full output table was also compared directly before and after extraction.
// The four text/6 hashes include the approved security correction: U+103FF is now
// shown losslessly as \\ud800\\udfff, rather than the invalid JSON escape \\u103ff.
const expected = JSON.parse(readFileSync(new URL('./fixtures/aiPureOutputs.json', import.meta.url), 'utf8')) as Record<string, string>;
const cases: Array<{ name: string; run: () => unknown }> = [];
const add = (name: string, run: () => unknown): void => { cases.push({ name, run }); };
const profile: ConnectionProfile = {
  id: 'p1', name: ' Dev\nServer 🦊 ', database: 'Sales', authMode: 'direct',
  serverUrl: 'https://fm.example:16000', username: ' reader\t ', aiAccess: 'write'
};

let seed = 0x51c0ffee;
const random = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const alphabet = ['a', 'Z', '0', ' ', '\n', '\r', '\t', '\0', '\u001b', '\u202e', '\u200b', 'é', '中', '🦊', 'e\u0301', '\ud800', '"', "'", '\\', '<', '>', ':', '.', '@', '[', ']'];
const texts = [
  '', ' leading and trailing ', '.', '..', '\0\x01\x1f\x7f\n\r\t', '\u2028\u2029\u202e\u2066\u200b',
  '🦊中é e\u0301 \ud800\udfff', '"quoted" \\ </script> [link](https://fm.example)',
  'Bearer abc123def password=secret {"token":"private"}',
  'a'.repeat(200), 'a'.repeat(201), '🦊'.repeat(200), '🦊'.repeat(201)
];
for (let i = 0; i < 12; i += 1) {
  const length = random() % 70;
  texts.push(Array.from({ length }, () => alphabet[random() % alphabet.length]).join(''));
}

texts.forEach((text, index) => {
  const args = { profile, layout: text, description: text };
  add(`edit/text/${index}`, () => buildEditConfirmation({
    ...args, recordId: text, changes: [{ name: text, oldValue: `{"token":"private"} ${text}`, newValue: text }]
  }));
  add(`create/text/${index}`, () => buildCreateConfirmation({ ...args, values: [[text, text]] }));
  add(`delete/text/${index}`, () => buildDeleteConfirmation({
    ...args, recordId: text, snapshot: { [text]: text, secretObject: { password: 'private' }, nil: null, flag: false, count: 42 }
  }));
  add(`script/text/${index}`, () => buildScriptConfirmation({ ...args, script: text, parameter: text }));
});

for (const authMode of ['direct', 'proxy'] as const) {
  for (const username of [undefined, '', ' user ']) {
    add(`account/${authMode}/${String(username)}`, () => buildCreateConfirmation({
      profile: { ...profile, authMode, username }, layout: ' L ', values: []
    }));
  }
}
for (const count of [0, 1, 10, 11, 30]) {
  for (const value of ['x', '\0'.repeat(200)]) {
    const values: Array<[string, string]> = Array.from({ length: count }, (_, i) => [` Field ${i} `, value]);
    const suffix = `${count}/${value.length}`;
    add(`create/limit/${suffix}`, () => buildCreateConfirmation({ profile, layout: 'L', values }));
    add(`edit/limit/${suffix}`, () => buildEditConfirmation({
      profile, layout: 'L', recordId: '1', changes: values.map(([name, newValue]) => ({ name, oldValue: 'old'.repeat(100), newValue }))
    }));
    add(`delete/limit/${suffix}`, () => buildDeleteConfirmation({
      profile, layout: 'L', recordId: '1', snapshot: Object.fromEntries(values.map(([name, v]) => [name.repeat(40), v]))
    }));
  }
}
for (const parameter of [undefined, '', 'x'.repeat(199), 'x'.repeat(200), 'x'.repeat(201), '\0'.repeat(200)]) {
  add(`script/limit/${String(parameter?.length)}/${parameter?.charCodeAt(0)}`, () => buildScriptConfirmation({
    profile, layout: ' L ', script: ' S ', parameter, description: 'note'.repeat(100)
  }));
}
add('delete/values', () => buildDeleteConfirmation({
  profile, layout: ' L ', recordId: ' 1 ', snapshot: {
    missing: undefined, nil: null, number: -1.5, flag: true, array: ['x', null, 'y'],
    object: { token: 'private', nested: { password: 'secret' } },
    secret: '{"token":"private","password":"secret"}', old: 'z'.repeat(1000)
  }
}));

const urls = [
  undefined, 'https://fm', 'https://FM.example:16000/fmi/data', 'https://user:password@fm.example:8443/path?q=token#fragment',
  'not a URL [.*+?^${}()|\\]', '', 'https://bücher.example', 'https://xn--bcher-kva.example',
  'http://10.1.2.3', 'https://[2001:db8::10]:443/path', 'http://[::1]:8443', 'https://[::ffff:10.1.2.3]',
  'http://[2001:db8:::10]', 'https://[::]'
];
const ipv6Forms = [
  '2001:db8::10', '2001:DB8:0:0:0:0:0:10', '2001:0db8:0000:0000:0000:0000:0000:0010',
  '[2001:db8::10]:8443', '2001:db8::10:443', '2001:db8::10.', '2001:db8::11',
  '::1', '[::1]:8443', '::1:8443', '::ffff:10.1.2.3', '::FFFF:a01:203', '::ffff:10.1.2.4',
  '::ffff:999.1.2.3', '2001:::db8::10', '2001:db8::00000', '1:2:3:4:5:6:7:8:9',
  '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8', '1::2::3', '::', '::::', '[fe80::1%en0]', 'abc::def',
  '::ffff:10.1.2.3:443', '[::ffff:a01:203]:443', '2001:db8::10...'
];
const hostForms = [
  'https://FM.example:16000/fmi/data', 'fm.example:8443', 'user@fm.example', 'fm.example.other', 'my-fm.example',
  'confirm fm fmi fm-2', 'bücher.example XN--BCHER-KVA.example', '10.1.2.3:8080 110.1.2.34',
  'proxy.example:9000', 'not a URL [.*+?^${}()|\\]'
];
urls.forEach((url, index) => {
  const p = url === undefined ? undefined : { ...profile, serverUrl: url, proxyEndpoint: 'https://proxy.example:9000/path' };
  [...texts, ...ipv6Forms, ...hostForms].forEach((text, textIndex) => {
    add(`scrub/${index}/${textIndex}`, () => scrub(`before ${text} after`, p));
  });
  add(`scrub/long/${index}`, () => scrub(`${'中\0x'.repeat(700)} fm.example ${ipv6Forms.join(' ')}`, p));
});

function output(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message, outcome: error instanceof AiToolError ? error.outcome : null } };
  }
}

describe('pure AI helpers retain their pre-extraction outputs', () => {
  it('preserves the original function exports', () => {
    expect(legacy.buildCreateConfirmation).toBe(buildCreateConfirmation);
    expect(legacy.buildDeleteConfirmation).toBe(buildDeleteConfirmation);
    expect(legacy.buildEditConfirmation).toBe(buildEditConfirmation);
    expect(legacy.buildScriptConfirmation).toBe(buildScriptConfirmation);
    expect(legacy.scrub).toBe(scrub);
  });
  it('covers exactly the captured cases', () => {
    expect(cases.map(({ name }) => name)).toEqual(Object.keys(expected));
  });
  for (const { name, run } of cases) {
    it(name, () => { expect(createHash('sha256').update(JSON.stringify(output(run))).digest('hex')).toBe(expected[name]); });
  }
});
