<script lang="ts">
  import Toasts from './components/ui/Toasts.svelte';
  import Spinner from './components/ui/Spinner.svelte';
  import Account from './routes/Account.svelte';
  import Assets from './routes/Assets.svelte';
  import Component from './routes/Component.svelte';
  import Components from './routes/Components.svelte';
  import Deck from './routes/Deck.svelte';
  import DeckAsOf from './routes/DeckAsOf.svelte';
  import DeckHistory from './routes/DeckHistory.svelte';
  import DeckRun from './routes/DeckRun.svelte';
  import Decks from './routes/Decks.svelte';
  import Deleted from './routes/Deleted.svelte';
  import FileVersions from './routes/FileVersions.svelte';
  import ForgotPassword from './routes/ForgotPassword.svelte';
  import Login from './routes/Login.svelte';
  import Members from './routes/Members.svelte';
  import Model3d from './routes/Model3d.svelte';
  import NotFound from './routes/NotFound.svelte';
  import Print from './routes/Print.svelte';
  import Project from './routes/Project.svelte';
  import Projects from './routes/Projects.svelte';
  import ResetPassword from './routes/ResetPassword.svelte';
  import SceneExport from './routes/SceneExport.svelte';
  import Signup from './routes/Signup.svelte';
  import { projectComponents } from './lib/components.svelte.ts';
  import { deckHistory } from './lib/deckHistory.svelte.ts';
  import { deckImports } from './lib/deckImports.svelte.ts';
  import { decks } from './lib/decks.svelte.ts';
  import { deleted } from './lib/deleted.svelte.ts';
  import { files } from './lib/files.svelte.ts';
  import { models } from './lib/model3d.svelte.ts';
  import { projects } from './lib/projects.svelte.ts';
  import { realtime } from './lib/realtime.svelte.ts';
  import { isSignedIn, session } from './lib/session.svelte.ts';
  import { link, router } from './lib/router.svelte.ts';
  import { versions } from './lib/versions.svelte.ts';

  router.start();
  router.beforeNavigate = session.guardRoute;

  // beforeNavigate does not run on the initial page load, so the first route has
  // to be guarded once by hand -- after the session store knows whether there
  // is a signed-in account.
  //
  // Nothing renders until that guard has run, which is why this is a flag of
  // its own rather than a reading of session.status. init() leaves `unknown`
  // one microtask before this callback, and a screen mounted in that window
  // fetches with the token init has just cleared -- a 401 the visitor reads as
  // an error on the login page they land on immediately afterwards.
  let booted = $state(false);

  void session.init().then(() => {
    const redirected = session.guardRoute(router.current, router.path);
    if (typeof redirected === 'string') router.redirect(redirected);
    booted = true;
  });

  // Another tab signing out, or a 401 clearing the session mid-session, must
  // not leave one person's project list on screen for the next.
  $effect(() => {
    if (session.status === 'anon') {
      projects.reset();
      files.reset();
      decks.reset();
      deckImports.reset();
      deckHistory.reset();
      deleted.reset();
      models.reset();
      projectComponents.reset();
      versions.reset();
      realtime.stop();
    }
  });

  // Opened once there is a credential to present, closed when there is not.
  $effect(() => {
    const token = session.status === 'authed' ? session.token : null;
    if (!token) return;
    realtime.start(token);
    return () => realtime.stop();
  });

  const route = $derived(router.current);
  const showChrome = $derived(booted && isSignedIn(session.status));
</script>

<div class="flex min-h-full flex-col">
  {#if showChrome}
    <header class="border-b border-edge bg-surface" use:link>
      <nav class="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-2">
        <a class="focus-ring rounded px-2 py-1 font-semibold" href="/">Three Peaks Hub</a>
        <div class="flex items-center gap-1 text-sm">
          {#if session.status === 'offline'}
            <span class="rounded px-2 py-1 text-warning" role="status">Offline</span>
          {/if}
          <a class="focus-ring rounded px-3 py-2 hover:bg-accent-soft" href="/account">Account</a>
        </div>
      </nav>
    </header>
  {/if}

  <main class="flex-1">
    {#if !booted}
      <div class="flex justify-center py-24"><Spinner label="Loading" /></div>
    {:else if route.name === 'projects'}
      <Projects />
    {:else if route.name === 'project'}
      <Project projectId={route.params.projectId} />
    {:else if route.name === 'assets'}
      <Assets projectId={route.params.projectId} folderId={route.params.folderId} />
    {:else if route.name === 'components'}
      <Components projectId={route.params.projectId} kind={route.params.kind} />
    {:else if route.name === 'component'}
      <Component projectId={route.params.projectId} componentId={route.params.componentId} />
    {:else if route.name === 'members'}
      <Members projectId={route.params.projectId} />
    {:else if route.name === 'deleted'}
      <Deleted projectId={route.params.projectId} />
    {:else if route.name === 'decks'}
      <Decks projectId={route.params.projectId} />
    {:else if route.name === 'deck'}
      <Deck projectId={route.params.projectId} deckId={route.params.deckId} />
    {:else if route.name === 'deck-history'}
      <DeckHistory projectId={route.params.projectId} deckId={route.params.deckId} />
    {:else if route.name === 'deck-run'}
      <DeckRun
        projectId={route.params.projectId}
        deckId={route.params.deckId}
        runId={route.params.runId}
      />
    {:else if route.name === 'deck-as-of'}
      <DeckAsOf
        projectId={route.params.projectId}
        deckId={route.params.deckId}
        runId={route.params.runId}
      />
    {:else if route.name === 'print'}
      <Print
        projectId={route.params.projectId}
        deckId={route.params.deckId}
        boardId={route.params.boardId}
      />
    {:else if route.name === 'scene'}
      <SceneExport projectId={route.params.projectId} />
    {:else if route.name === 'model'}
      <Model3d projectId={route.params.projectId} fileId={route.params.fileId} />
    {:else if route.name === 'versions'}
      <FileVersions projectId={route.params.projectId} fileId={route.params.fileId} />
    {:else if route.name === 'account'}
      <Account />
    {:else if route.name === 'login'}
      <Login />
    {:else if route.name === 'signup'}
      <Signup />
    {:else if route.name === 'forgot-password'}
      <ForgotPassword />
    {:else if route.name === 'reset-password'}
      <ResetPassword token={route.params.token} />
    {:else}
      <NotFound />
    {/if}
  </main>
</div>

<Toasts />
