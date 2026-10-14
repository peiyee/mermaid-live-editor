import * as github from '$lib/util/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, disconnect, githubState, openDiagram, saveFile } from './githubState.svelte';

vi.mock('$lib/util/github', async (importOriginal) => ({
  ...(await importOriginal<typeof github>()),
  readDiagram: vi.fn(),
  saveDiagram: vi.fn()
}));

const readDiagram = vi.mocked(github.readDiagram);
const saveDiagram = vi.mocked(github.saveDiagram);

const settings = { branch: '', folder: '/diagrams/', repo: 'me/diagrams', token: ' tok ' };

beforeEach(() => {
  disconnect();
  localStorage.clear();
  sessionStorage.clear();
  configure({ ...settings, rememberToken: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('configure', () => {
  it('normalizes settings and keeps an unremembered token in sessionStorage', () => {
    expect(githubState.isConfigured).toBe(true);
    expect(githubState.settings).toEqual({ branch: '', folder: 'diagrams', repo: 'me/diagrams' });
    expect(sessionStorage.getItem('githubToken')).toBe('tok');
    expect(localStorage.getItem('githubToken')).toBeNull();
  });

  it('moves a remembered token to localStorage', () => {
    configure({ ...settings, rememberToken: true });
    expect(localStorage.getItem('githubToken')).toBe('tok');
    expect(sessionStorage.getItem('githubToken')).toBeNull();
  });

  it('requires a valid repo', () => {
    configure({ ...settings, rememberToken: false, repo: 'nope' });
    expect(githubState.isConfigured).toBe(false);
  });

  it('removes the token on disconnect', () => {
    disconnect();
    expect(githubState.isConfigured).toBe(false);
    expect(sessionStorage.getItem('githubToken')).toBeNull();
  });
});

describe('saveFile', () => {
  const saved = { name: 'a.mmd', path: 'diagrams/a.mmd', sha: 'new' };

  it('creates a new file without a sha', async () => {
    readDiagram.mockResolvedValueOnce(undefined);
    saveDiagram.mockResolvedValueOnce(saved);
    await expect(saveFile('diagrams/a.mmd', 'graph TD')).resolves.toEqual({
      file: saved,
      status: 'saved'
    });
    expect(saveDiagram.mock.calls[0][3]).toEqual({ sha: undefined });
    expect(githubState.openFile).toEqual(saved);
  });

  it('asks before overwriting a file that was not opened', async () => {
    readDiagram.mockResolvedValueOnce({ ...saved, code: 'old', sha: 'theirs' });
    await expect(saveFile('diagrams/a.mmd', 'graph TD')).resolves.toEqual({
      sha: 'theirs',
      status: 'exists'
    });
    expect(saveDiagram).not.toHaveBeenCalled();

    saveDiagram.mockResolvedValueOnce(saved);
    await saveFile('diagrams/a.mmd', 'graph TD', 'theirs');
    expect(saveDiagram.mock.calls[0][3]).toEqual({ sha: 'theirs' });
  });

  it('updates the open file using the sha it was opened at', async () => {
    readDiagram.mockResolvedValueOnce({ ...saved, code: 'graph TD', sha: 'opened' });
    await openDiagram('diagrams/a.mmd');

    saveDiagram.mockResolvedValueOnce(saved);
    await saveFile('/diagrams/a.mmd', 'graph LR');
    // No fresh read: a newer version on GitHub must make the save fail, not be overwritten.
    expect(readDiagram).toHaveBeenCalledTimes(1);
    expect(saveDiagram.mock.calls[0][3]).toEqual({ sha: 'opened' });
  });

  it('forgets the open file when switching repository', async () => {
    readDiagram.mockResolvedValueOnce({ ...saved, code: 'x', sha: 'opened' });
    await openDiagram('diagrams/a.mmd');
    configure({ ...settings, rememberToken: false, repo: 'me/other' });
    expect(githubState.openFile).toBeNull();
  });
});
