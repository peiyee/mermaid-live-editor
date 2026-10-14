import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeBase64,
  encodeBase64,
  GitHubError,
  isValidRepo,
  joinPath,
  listDiagrams,
  readDiagram,
  saveDiagram,
  toDiagramFileName,
  type RepoTarget
} from './github';

const target: RepoTarget = { branch: 'main', repo: 'me/diagrams', token: 'tok' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status
  });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('helpers', () => {
  it('round-trips UTF-8 through base64', () => {
    const code = 'flowchart LR\n  A[Café ☕] --> B[日本]';
    expect(decodeBase64(encodeBase64(code))).toBe(code);
    // GitHub wraps base64 content with newlines.
    expect(decodeBase64('aGVs\nbG8=\n')).toBe('hello');
  });

  it('validates owner/repo', () => {
    expect(isValidRepo('me/diagrams')).toBe(true);
    expect(isValidRepo(' me/my.repo-1 ')).toBe(true);
    expect(isValidRepo('me')).toBe(false);
    expect(isValidRepo('me/repo/extra')).toBe(false);
    expect(isValidRepo('https://github.com/me/repo')).toBe(false);
  });

  it('builds file paths', () => {
    expect(joinPath('/diagrams/', 'a.mmd')).toBe('diagrams/a.mmd');
    expect(joinPath('', 'a.mmd')).toBe('a.mmd');
    expect(toDiagramFileName('flow')).toBe('flow.mmd');
    expect(toDiagramFileName('sub/flow')).toBe('sub/flow.mmd');
    expect(toDiagramFileName('notes.md')).toBe('notes.md');
  });
});

describe('listDiagrams', () => {
  it('lists only .mmd files, sorted, sending the token and branch', async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        { name: 'z.mmd', path: 'diagrams/z.mmd', sha: '1', type: 'file' },
        { name: 'readme.md', path: 'diagrams/readme.md', sha: '2', type: 'file' },
        { name: 'sub', path: 'diagrams/sub', sha: '3', type: 'dir' },
        { name: 'a.mmd', path: 'diagrams/a.mmd', sha: '4', type: 'file' }
      ])
    );
    const files = await listDiagrams(target, 'diagrams');
    expect(files.map(({ name }) => name)).toEqual(['a.mmd', 'z.mmd']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/me/diagrams/contents/diagrams?ref=main');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('treats a missing folder in a reachable repo as empty', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ full_name: 'me/diagrams' }));
    await expect(listDiagrams(target, 'diagrams')).resolves.toEqual([]);
  });

  it('reports an unreachable repo', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Not Found' }, 404));
    await expect(listDiagrams(target, 'diagrams')).rejects.toThrow(/me\/diagrams/);
  });

  it('explains a rejected token', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Bad credentials' }, 401));
    await expect(listDiagrams(target, '')).rejects.toThrow(/rejected the token/);
  });
});

describe('readDiagram', () => {
  it('decodes file content', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        content: encodeBase64('graph TD\n  A-->B'),
        encoding: 'base64',
        name: 'a.mmd',
        path: 'diagrams/a.mmd',
        sha: 'abc',
        type: 'file'
      })
    );
    await expect(readDiagram(target, 'diagrams/a.mmd')).resolves.toEqual({
      code: 'graph TD\n  A-->B',
      name: 'a.mmd',
      path: 'diagrams/a.mmd',
      sha: 'abc'
    });
  });

  it('returns undefined for a missing file', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
    await expect(readDiagram(target, 'nope.mmd')).resolves.toBeUndefined();
  });

  it('encodes path segments', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
    await readDiagram({ ...target, branch: '' }, 'my folder/a #1.mmd');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/me/diagrams/contents/my%20folder/a%20%231.mmd'
    );
  });
});

describe('saveDiagram', () => {
  it('commits base64 content with branch and sha', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ content: { name: 'a.mmd', path: 'diagrams/a.mmd', sha: 'new' } })
    );
    const file = await saveDiagram(target, '/diagrams/a.mmd', 'graph TD', { sha: 'old' });
    expect(file).toEqual({ name: 'a.mmd', path: 'diagrams/a.mmd', sha: 'new' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/me/diagrams/contents/diagrams/a.mmd');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({
      branch: 'main',
      content: encodeBase64('graph TD'),
      message: 'Update diagrams/a.mmd',
      sha: 'old'
    });
  });

  it('reports a stale sha as a conflict', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'diagrams/a.mmd does not match abc' }, 409));
    const error = await saveDiagram(target, 'diagrams/a.mmd', 'x', { sha: 'abc' }).catch(
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(409);
    expect((error as Error).message).toMatch(/changed on GitHub/);
  });
});
