<script lang="ts">
  import Card from '$lib/components/Card/Card.svelte';
  import { TID } from '$lib/constants';
  import { joinPath, toDiagramFileName, type RepoFile } from '$lib/util/github';
  import { notify, prompt } from '$lib/util/notify';
  import { inputState, updateCode } from '$lib/util/state.svelte';
  import FileIcon from '~icons/mdi/file-document-outline';
  import LogoutIcon from '~icons/mdi/logout';
  import GitHubIcon from '~icons/mdi/github';
  import OpenInNewIcon from '~icons/material-symbols/open-in-new-rounded';
  import RefreshIcon from '~icons/mdi/refresh';
  import SaveIcon from '~icons/material-symbols/save-outline-rounded';
  import SettingsIcon from '~icons/mdi/cog-outline';
  import { Button } from '../ui/button';
  import { Input } from '../ui/input';
  import { Separator } from '../ui/separator';
  import {
    configure,
    disconnect,
    githubState,
    listFiles,
    openDiagram,
    saveFile
  } from './githubState.svelte';

  const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

  let showSettings = $state(!githubState.isConfigured);
  let form = $state({
    ...githubState.settings,
    rememberToken: githubState.rememberToken,
    token: githubState.token
  });

  let files = $state<RepoFile[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  // Code as last opened from or saved to GitHub, to warn before discarding edits.
  let syncedCode: string | undefined;

  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const refresh = async () => {
    if (!githubState.isConfigured) {
      return;
    }
    loading = true;
    try {
      files = await listFiles();
    } catch (error) {
      files = [];
      notify(errorMessage(error));
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    if (!showSettings) {
      void refresh();
    }
  });

  const saveSettings = (event: SubmitEvent) => {
    event.preventDefault();
    configure(form);
    if (!githubState.isConfigured) {
      notify('Enter a token and a repository in the form owner/repo.');
      return;
    }
    showSettings = false;
  };

  const signOut = () => {
    if (prompt('Remove the GitHub token from this browser?')) {
      disconnect();
      form.token = '';
      files = [];
      showSettings = true;
    }
  };

  const open = async ({ path }: RepoFile) => {
    if (
      syncedCode !== inputState.code &&
      !prompt(`Replace the diagram in the editor with ${path}?`)
    ) {
      return;
    }
    busy = true;
    try {
      const file = await openDiagram(path);
      updateCode(file.code, { resetPanZoom: true, updateDiagram: true });
      syncedCode = file.code;
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      busy = false;
    }
  };

  const defaultFileName = (): string => {
    const folder = githubState.settings.folder;
    const current = githubState.openFile?.path;
    if (current && (!folder || current.startsWith(`${folder}/`))) {
      return folder ? current.slice(folder.length + 1) : current;
    }
    return 'diagram.mmd';
  };

  const save = async () => {
    const name = window.prompt(
      `Save as (in ${githubState.settings.repo}/${githubState.settings.folder})`,
      defaultFileName()
    );
    if (!name?.trim()) {
      return;
    }
    const path = joinPath(githubState.settings.folder, toDiagramFileName(name));
    const code = inputState.code;
    busy = true;
    try {
      let result = await saveFile(path, code);
      if (result.status === 'exists') {
        if (!prompt(`${path} already exists. Overwrite it?`)) {
          return;
        }
        result = await saveFile(path, code, result.sha);
      }
      if (result.status === 'saved') {
        syncedCode = code;
        notify(`Saved ${result.file.path}`);
        await refresh();
      }
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      busy = false;
    }
  };

  const fileURL = (path: string): string => {
    const { repo, branch } = githubState.settings;
    return `https://github.com/${repo}/blob/${encodeURIComponent(branch || 'HEAD')}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  };
</script>

<Card title="GitHub" icon={{ component: GitHubIcon }} isOpen isClosable={false}>
  {#snippet actions()}
    {#if githubState.isConfigured && !showSettings}
      <div class="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          disabled={loading}
          onclick={refresh}
          title="Refresh file list"><RefreshIcon /></Button>
        <Button
          size="icon"
          variant="ghost"
          disabled={busy}
          onclick={save}
          data-testid={TID.githubSave}
          title="Save current diagram to GitHub"><SaveIcon /></Button>
        <Separator orientation="vertical" />
        <Button
          size="icon"
          variant="ghost"
          onclick={() => (showSettings = true)}
          title="Repository settings"><SettingsIcon /></Button>
        <Button
          size="icon"
          variant="ghost"
          class="hover:text-destructive"
          onclick={signOut}
          title="Remove token"><LogoutIcon /></Button>
      </div>
    {/if}
  {/snippet}

  {#if showSettings}
    <form class="flex flex-col gap-3 p-3 text-sm" onsubmit={saveSettings}>
      <p class="text-primary-foreground/70">
        Save diagrams as <code>.mmd</code> files in a public or private repository. Create a
        <a class="text-blue-500 hover:underline" href={TOKEN_URL} target="_blank" rel="noopener"
          >fine-grained token</a>
        with access to only that repository and the permission
        <b>Contents: Read and write</b>.
      </p>
      <label class="flex flex-col gap-1">
        Token
        <Input
          type="password"
          autocomplete="off"
          placeholder="github_pat_..."
          data-testid={TID.githubToken}
          bind:value={form.token} />
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={form.rememberToken} />
        Remember token in this browser
      </label>
      <p class="text-xs text-primary-foreground/50">
        Unchecked, the token is forgotten when this tab closes. It is only ever sent to
        api.github.com.
      </p>
      <label class="flex flex-col gap-1">
        Repository
        <Input placeholder="owner/repo" data-testid={TID.githubRepo} bind:value={form.repo} />
      </label>
      <div class="flex gap-2">
        <label class="flex flex-1 flex-col gap-1">
          Branch
          <Input placeholder="default branch" bind:value={form.branch} />
        </label>
        <label class="flex flex-1 flex-col gap-1">
          Folder
          <Input placeholder="repository root" bind:value={form.folder} />
        </label>
      </div>
      <div class="flex justify-end gap-2">
        {#if githubState.isConfigured}
          <Button variant="ghost" onclick={() => (showSettings = false)}>Cancel</Button>
        {/if}
        <Button type="submit" data-testid={TID.githubConnect}>Connect</Button>
      </div>
    </form>
  {:else}
    <div class="flex h-full flex-col">
      <div class="truncate px-3 pt-2 text-xs text-primary-foreground/50">
        {githubState.settings.repo}{githubState.settings.branch
          ? ` @ ${githubState.settings.branch}`
          : ''} / {githubState.settings.folder}
      </div>
      <ul class="flex flex-col gap-2 overflow-auto p-2" data-testid={TID.githubFileList}>
        {#if loading}
          <li class="m-2 text-center">Loading…</li>
        {:else if files.length === 0}
          <li class="m-2 text-center">
            No .mmd files here yet.<br />Click the Save button to commit the current diagram.
          </li>
        {:else}
          {#each files as file (file.path)}
            <li class="flex flex-col gap-2">
              <div class="flex items-center justify-between gap-2">
                <span
                  class={[
                    'flex min-w-0 items-center gap-1 truncate',
                    githubState.openFile?.path === file.path && 'font-semibold'
                  ]}
                  title={file.path}>
                  <FileIcon class="shrink-0" />
                  {file.name}
                </span>
                <div class="flex items-center gap-2">
                  <Button
                    href={fileURL(file.path)}
                    target="_blank"
                    rel="noopener"
                    size="icon"
                    variant="ghost"
                    title="View on GitHub"><OpenInNewIcon /></Button>
                  <Button size="sm" variant="ghost" disabled={busy} onclick={() => open(file)}
                    >Open</Button>
                </div>
              </div>
              <Separator />
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  {/if}
</Card>
