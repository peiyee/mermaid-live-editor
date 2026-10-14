/**
 * Minimal client for the GitHub Contents API, used to save and open diagrams in
 * a repository the user owns. Calls go straight from the browser to
 * api.github.com (which allows CORS) with a user-supplied personal access token,
 * so private repositories work without a backend.
 */

const API = 'https://api.github.com';

export const DIAGRAM_EXTENSION = '.mmd';

export interface RepoTarget {
  token: string;
  /** `owner/repo` */
  repo: string;
  /** Empty means the repository's default branch. */
  branch: string;
}

export interface RepoFile {
  name: string;
  path: string;
  sha: string;
}

export interface RepoFileContent extends RepoFile {
  code: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export const isValidRepo = (repo: string): boolean => REPO_PATTERN.test(repo.trim());

// Strips leading/trailing slashes and collapses repeats so paths join cleanly.
export const normalizePath = (path: string): string =>
  path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');

export const joinPath = (folder: string, name: string): string =>
  normalizePath(`${folder}/${name}`);

// Appends the diagram extension unless the name already has one.
export const toDiagramFileName = (name: string): string => {
  const trimmed = normalizePath(name);
  return /\.[\w]+$/.test(trimmed) ? trimmed : `${trimmed}${DIAGRAM_EXTENSION}`;
};

// UTF-8 safe base64, since btoa/atob only handle Latin-1.
export const encodeBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

export const decodeBase64 = (base64: string): string => {
  const binary = atob(base64.replaceAll(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
};

const encodePath = (path: string): string =>
  normalizePath(path).split('/').map(encodeURIComponent).join('/');

const contentsURL = ({ repo, branch }: RepoTarget, path: string): string => {
  const url = `${API}/repos/${repo.trim()}/contents/${encodePath(path)}`;
  return branch.trim() ? `${url}?ref=${encodeURIComponent(branch.trim())}` : url;
};

const describeError = (status: number, target: RepoTarget, body: { message?: string }): string => {
  switch (status) {
    case 401: {
      return 'GitHub rejected the token. It may be expired or revoked.';
    }
    case 403: {
      return `The token is not allowed to do this in ${target.repo}. It needs "Contents: Read and write" access to the repository.`;
    }
    case 404: {
      return `Not found: check that ${target.repo}${target.branch ? ` (branch ${target.branch})` : ''} exists and the token has access to it.`;
    }
    case 409: {
      return 'The file changed on GitHub since it was opened. Open it again to get the latest version, then save.';
    }
    default: {
      return body.message ?? `GitHub request failed (${status}).`;
    }
  }
};

const request = async <T>(target: RepoTarget, url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${target.token.trim()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    // GitHub answers a stale `sha` with 409, or 422 on some endpoints.
    const status = response.status === 422 && body.message?.includes('sha') ? 409 : response.status;
    throw new GitHubError(describeError(status, target, body), status);
  }
  return (await response.json()) as T;
};

interface ContentsItem {
  type: string;
  name: string;
  path: string;
  sha: string;
  content?: string;
  encoding?: string;
}

/** Lists the diagram files directly inside `folder`. A missing folder is empty. */
export const listDiagrams = async (target: RepoTarget, folder: string): Promise<RepoFile[]> => {
  try {
    const items = await request<ContentsItem[] | ContentsItem>(target, contentsURL(target, folder));
    if (!Array.isArray(items)) {
      throw new GitHubError(`${folder} is a file, not a folder.`, 400);
    }
    return items
      .filter(({ type, name }) => type === 'file' && name.endsWith(DIAGRAM_EXTENSION))
      .map(({ name, path, sha }) => ({ name, path, sha }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    // Distinguish "folder not created yet" from "repo not reachable".
    if (error instanceof GitHubError && error.status === 404 && normalizePath(folder)) {
      await request(target, `${API}/repos/${target.repo.trim()}`);
      return [];
    }
    throw error;
  }
};

/** Reads a file, or returns undefined when it does not exist. */
export const readDiagram = async (
  target: RepoTarget,
  path: string
): Promise<RepoFileContent | undefined> => {
  let item: ContentsItem;
  try {
    item = await request<ContentsItem>(target, contentsURL(target, path));
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
  if (item.type !== 'file' || item.encoding !== 'base64' || item.content === undefined) {
    throw new GitHubError(`${path} is not a readable file.`, 400);
  }
  return { code: decodeBase64(item.content), name: item.name, path: item.path, sha: item.sha };
};

/**
 * Creates or updates a file with one commit. Pass the `sha` of the version being
 * replaced when updating; GitHub refuses the write if the file has changed since.
 */
export const saveDiagram = async (
  target: RepoTarget,
  path: string,
  code: string,
  { sha, message }: { sha?: string; message?: string } = {}
): Promise<RepoFile> => {
  const filePath = normalizePath(path);
  const { content } = await request<{ content: ContentsItem }>(
    target,
    `${API}/repos/${target.repo.trim()}/contents/${encodePath(filePath)}`,
    {
      body: JSON.stringify({
        branch: target.branch.trim() || undefined,
        content: encodeBase64(code),
        message: message ?? `${sha ? 'Update' : 'Add'} ${filePath}`,
        sha
      }),
      method: 'PUT'
    }
  );
  return { name: content.name, path: content.path, sha: content.sha };
};
