import { persisted } from '$lib/util/persist.svelte';
import {
  isValidRepo,
  listDiagrams,
  normalizePath,
  readDiagram,
  saveDiagram,
  type RepoFile,
  type RepoFileContent,
  type RepoTarget
} from '$lib/util/github';
import { logEvent } from '$lib/util/stats';

export interface RepoSettings {
  repo: string;
  branch: string;
  folder: string;
}

const TOKEN_KEY = 'githubToken';

const settings = persisted<RepoSettings>('githubRepoSettings', {
  branch: '',
  folder: 'diagrams',
  repo: ''
});
// The file last opened from or saved to GitHub; its sha guards against overwriting
// changes made on GitHub in the meantime.
const openFile = persisted<RepoFile | null>('githubOpenFile', null);

// "Remember" keeps the token in localStorage; otherwise it lives in sessionStorage
// and is gone when the tab closes.
const storages = (): Storage[] =>
  typeof window === 'undefined' ? [] : [window.localStorage, window.sessionStorage];

const readToken = (): string => {
  for (const storage of storages()) {
    const value = storage.getItem(TOKEN_KEY);
    if (value) {
      return value;
    }
  }
  return '';
};

let token = $state(readToken());
let rememberToken = $state(
  typeof window !== 'undefined' && !!window.localStorage.getItem(TOKEN_KEY)
);

export const githubState = {
  get isConfigured(): boolean {
    return !!token && isValidRepo(settings.value.repo);
  },
  get openFile(): RepoFile | null {
    return openFile.value;
  },
  get rememberToken(): boolean {
    return rememberToken;
  },
  get settings(): RepoSettings {
    return settings.value;
  },
  get token(): string {
    return token;
  }
};

export const configure = (next: RepoSettings & { token: string; rememberToken: boolean }): void => {
  const repoChanged =
    next.repo.trim() !== settings.value.repo || next.branch.trim() !== settings.value.branch;
  settings.value = {
    branch: next.branch.trim(),
    folder: normalizePath(next.folder),
    repo: next.repo.trim()
  };
  token = next.token.trim();
  rememberToken = next.rememberToken;
  for (const storage of storages()) {
    storage.removeItem(TOKEN_KEY);
  }
  const [local, session] = storages();
  (rememberToken ? local : session)?.setItem(TOKEN_KEY, token);
  if (repoChanged) {
    openFile.value = null;
  }
};

export const disconnect = (): void => {
  token = '';
  for (const storage of storages()) {
    storage.removeItem(TOKEN_KEY);
  }
  openFile.value = null;
};

const target = (): RepoTarget => ({
  branch: settings.value.branch,
  repo: settings.value.repo,
  token
});

export const listFiles = (): Promise<RepoFile[]> => listDiagrams(target(), settings.value.folder);

export const openDiagram = async (path: string): Promise<RepoFileContent> => {
  const file = await readDiagram(target(), path);
  if (!file) {
    throw new Error(`${path} no longer exists.`);
  }
  openFile.value = { name: file.name, path: file.path, sha: file.sha };
  logEvent('github', { action: 'open' });
  return file;
};

export type SaveResult = { status: 'saved'; file: RepoFile } | { status: 'exists'; sha: string };

/**
 * Saves `code` to `path`. Updating the open file reuses its known sha, so a
 * newer version on GitHub is never silently overwritten. Saving to any other
 * existing path returns `exists` unless `overwriteSha` confirms the overwrite.
 */
export const saveFile = async (
  path: string,
  code: string,
  overwriteSha?: string
): Promise<SaveResult> => {
  const filePath = normalizePath(path);
  let sha = overwriteSha;
  if (!sha && openFile.value?.path === filePath) {
    sha = openFile.value.sha;
  }
  if (!sha) {
    const existing = await readDiagram(target(), filePath);
    if (existing) {
      return { sha: existing.sha, status: 'exists' };
    }
  }
  const file = await saveDiagram(target(), filePath, code, { sha });
  openFile.value = file;
  logEvent('github', { action: 'save' });
  return { file, status: 'saved' };
};
