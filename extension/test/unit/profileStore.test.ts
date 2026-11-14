import { describe, expect, it } from 'vitest';

import { ProfileStore } from '../../src/services/profileStore';
import type { ConnectionProfile, SavedQuery } from '../../src/types/fm';
import { InMemoryMemento } from './mocks';

function createProfile(id: string): ConnectionProfile {
  return {
    id,
    name: `Profile ${id}`,
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

describe('ProfileStore', () => {
  it('performs CRUD for profiles and active profile', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    const profileA = createProfile('a');
    const profileB = createProfile('b');

    await store.upsertProfile(profileA);
    await store.upsertProfile(profileB);

    const profiles = await store.listProfiles();
    expect(profiles).toHaveLength(2);

    await store.setActiveProfileId('a');
    expect(store.getActiveProfileId()).toBe('a');

    await store.removeProfile('a');

    const remaining = await store.listProfiles();
    expect(remaining.map((item) => item.id)).toEqual(['b']);
    expect(store.getActiveProfileId()).toBeUndefined();
  });

  it('stores saved queries and removes those linked to deleted profile', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    await store.upsertProfile(createProfile('a'));
    await store.upsertProfile(createProfile('b'));

    const queryA: SavedQuery = {
      id: 'q-a',
      name: 'Query A',
      profileId: 'a',
      layout: 'Contacts',
      findJson: [{}],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const queryB: SavedQuery = {
      id: 'q-b',
      name: 'Query B',
      profileId: 'b',
      layout: 'Invoices',
      findJson: [{}],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await store.saveQuery(queryA);
    await store.saveQuery(queryB);

    expect(store.listSavedQueries()).toHaveLength(2);

    await store.removeProfile('a');

    const savedQueries = store.listSavedQueries();
    expect(savedQueries).toHaveLength(1);
    expect(savedQueries[0]?.id).toBe('q-b');
  });

  it('ignores invalid stored profiles during hydration', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    await globalState.update('filemakerDataApiTools.profiles', [
      createProfile('valid-profile'),
      {
        id: 'bad',
        name: 'Bad',
        authMode: 'direct',
        serverUrl: 'not-a-url',
        database: 'DB'
      }
    ]);

    const profiles = await store.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe('valid-profile');
  });

  it.each(['?tenant=other', '#other'])('handles stored addresses with %s without crashing and refuses to save them', async (suffix) => {
    const globalState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, new InMemoryMemento() as never);
    const invalid = { ...createProfile('invalid'), serverUrl: `https://fm.example.com${suffix}` };
    await globalState.update('filemakerDataApiTools.profiles', [createProfile('valid'), invalid]);

    expect((await store.listProfiles()).map((profile) => profile.id)).toEqual(['valid']);
    await expect(store.upsertProfile(invalid)).rejects.toThrow('Server URL must not contain a query string or fragment.');
  });

  it('keeps a profile saved with a user name in its address visible, but will not save one', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);
    const legacy = { ...createProfile('legacy'), serverUrl: 'https://admin:pw@fm.example.com' };
    await globalState.update('filemakerDataApiTools.profiles', [legacy]);

    // Still listed, so it can be fixed, and not lost when the list is written back.
    expect((await store.listProfiles()).map((profile) => profile.id)).toEqual(['legacy']);
    await store.upsertProfile(createProfile('another'));
    expect((await store.listProfiles()).map((profile) => profile.id).sort()).toEqual(['another', 'legacy']);

    // A new save with credentials in the address is refused.
    await expect(store.upsertProfile(legacy)).rejects.toThrow(/must not contain a username or password/);
  });

  it('persists TLS override fields with normalized profile metadata', async () => {
    const globalState = new InMemoryMemento();
    const workspaceState = new InMemoryMemento();
    const store = new ProfileStore(globalState as never, workspaceState as never);

    await store.upsertProfile({
      ...createProfile('tls'),
      allowSelfSigned: true,
      caBundlePath: '  /workspace/certs/dev-ca.pem  '
    });

    const profile = await store.getProfile('tls');
    expect(profile?.allowSelfSigned).toBe(true);
    expect(profile?.caBundlePath).toBe('/workspace/certs/dev-ca.pem');
  });
});
