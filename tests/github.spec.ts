import { TID } from '$/constants';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './test';

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');

interface FakeFile {
  content: string;
  sha: string;
}

/** Serves a single fake private repo `me/private` from memory. */
const fakeGitHub = async (page: Page, files: Map<string, FakeFile>) => {
  const commits: { path: string; message: string; sha?: string }[] = [];
  let shaCounter = 0;
  await page.route('https://api.github.com/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.headers().authorization !== 'Bearer secret-token') {
      return route.fulfill({ json: { message: 'Bad credentials' }, status: 401 });
    }
    if (url.pathname === '/repos/me/private') {
      return route.fulfill({ json: { full_name: 'me/private' } });
    }
    const prefix = '/repos/me/private/contents/';
    if (!url.pathname.startsWith(prefix)) {
      return route.fulfill({ json: { message: 'Not Found' }, status: 404 });
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { content: string; message: string; sha?: string };
      const existing = files.get(path);
      if (existing && existing.sha !== body.sha) {
        return route.fulfill({ json: { message: `${path} does not match` }, status: 409 });
      }
      const sha = `sha-${++shaCounter}`;
      files.set(path, { content: decode(body.content), sha });
      commits.push({ message: body.message, path, sha: body.sha });
      return route.fulfill({
        json: { content: { name: path.split('/').pop(), path, sha } },
        status: existing ? 200 : 201
      });
    }
    const file = files.get(path);
    if (file) {
      return route.fulfill({
        json: {
          content: encode(file.content),
          encoding: 'base64',
          name: path.split('/').pop(),
          path,
          sha: file.sha,
          type: 'file'
        }
      });
    }
    const children = [...files.entries()]
      .filter(([filePath]) => filePath.startsWith(`${path}/`))
      .map(([filePath, { sha }]) => ({
        name: filePath.slice(path.length + 1),
        path: filePath,
        sha,
        type: 'file'
      }));
    return children.length > 0
      ? route.fulfill({ json: children })
      : route.fulfill({ json: { message: 'Not Found' }, status: 404 });
  });
  return commits;
};

test.describe('Save to GitHub', () => {
  test('connects to a private repo, opens and saves diagrams', async ({ editPage, page }) => {
    const files = new Map<string, FakeFile>([
      ['diagrams/existing.mmd', { content: 'flowchart LR\n  Stored --> InRepo', sha: 'sha-0' }],
      ['diagrams/notes.md', { content: '# not a diagram', sha: 'sha-x' }]
    ]);
    const commits = await fakeGitHub(page, files);
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void (dialog.type() === 'prompt' ? dialog.accept('new-flow') : dialog.accept());
    });

    await page.getByTestId(TID.githubToggle).click();
    await page.getByTestId(TID.githubToken).fill('secret-token');
    await page.getByTestId(TID.githubRepo).fill('me/private');
    await page.getByTestId(TID.githubConnect).click();

    // Only .mmd files are listed.
    const list = page.getByTestId(TID.githubFileList);
    await expect(list).toContainText('existing.mmd');
    await expect(list).not.toContainText('notes.md');

    // Without "remember", the token is kept for this tab only.
    expect(await page.evaluate(() => localStorage.getItem('githubToken'))).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('githubToken'))).toBe('secret-token');

    // Open loads the file into the editor and the diagram.
    await list.getByRole('button', { name: 'Open' }).click();
    await editPage.checkInEditor('Stored');
    await editPage.checkTextInView('InRepo');

    // The save prompt answers "new-flow", so this creates a new file.
    await editPage.typeInEditor(' --> Edited', { newline: false });
    await page.getByTestId(TID.githubSave).click();
    await expect(list).toContainText('new-flow.mmd');
    expect(files.get('diagrams/new-flow.mmd')?.content).toContain('Edited');
    expect(commits.at(-1)).toEqual({
      message: 'Add diagrams/new-flow.mmd',
      path: 'diagrams/new-flow.mmd',
      sha: undefined
    });

    // Saving the same name again updates with the sha it was saved at.
    await editPage.typeInEditor(' --> Again', { newline: false });
    await page.getByTestId(TID.githubSave).click();
    await expect.poll(() => files.get('diagrams/new-flow.mmd')?.content).toContain('Again');
    expect(commits.at(-1)?.message).toBe('Update diagrams/new-flow.mmd');

    // A change made on GitHub meanwhile is not overwritten.
    files.set('diagrams/new-flow.mmd', { content: 'changed elsewhere', sha: 'remote' });
    await page.getByTestId(TID.githubSave).click();
    await expect(page.getByText('changed on GitHub')).toBeVisible();
    expect(files.get('diagrams/new-flow.mmd')?.content).toBe('changed elsewhere');
  });

  test('shows a clear error for a bad token', async ({ editPage }) => {
    const { page } = editPage;
    await fakeGitHub(page, new Map());
    await page.getByTestId(TID.githubToggle).click();
    await page.getByTestId(TID.githubToken).fill('wrong');
    await page.getByTestId(TID.githubRepo).fill('me/private');
    await page.getByTestId(TID.githubConnect).click();
    await expect(page.getByText('GitHub rejected the token')).toBeVisible();
  });
});
