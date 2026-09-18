import {
  Button,
  Column,
  Columns,
  LoadingIndicator,
  ProgressBar,
  Rows,
  Select,
  Text,
  Title,
} from '@canva/app-ui-kit';
import { auth } from '@canva/user';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiMessage, assertOk, setToken } from 'src/api';
import { type Design, DesignError, exportPages, readDesign } from 'src/design';
import {
  type PlanRow,
  type RunCounts,
  type StartedRun,
  abandonRun,
  startRun,
  uploadPages,
} from 'src/importRun';
import * as styles from 'styles/components.css';

interface HubUser {
  id: string;
  name: string;
  email: string;
}

interface Deck {
  id: string;
  name: string;
  project_id: string;
}

interface Project {
  id: string;
  name: string;
}

type Stage =
  | { kind: 'checking' }
  | { kind: 'pairing'; code: string }
  | { kind: 'picking' }
  | { kind: 'working'; label: string }
  | { kind: 'planning'; design: Design; run: StartedRun }
  | { kind: 'uploading'; done: number; total: number }
  | { kind: 'done'; counts: RunCounts }
  | { kind: 'error'; message: string };

// Every wait is a stage of its own, and every stage says what it is waiting
// for. Canva's export dialog closes the moment the export starts, leaving this
// panel in front of somebody for as long as the render takes -- a screen that
// only disabled its buttons read as an app that had died.
function Working({ label }: { label: string }) {
  return (
    <div role="status">
      <Columns spacing="1u" alignY="center">
        <Column width="content">
          <LoadingIndicator size="small" />
        </Column>
        <Column>
          <Text size="small">{label}</Text>
        </Column>
      </Columns>
    </div>
  );
}

// What each row of the plan did, said the way the deck's own import screen says
// it. Which tier matched a card is worth showing rather than hiding: a page
// matched by number is one a reorder could have placed wrongly, and a person
// reading the plan is the only one who can tell.
function rowDetail(page: PlanRow): string {
  // Said here as well as on the deck's own screen: a person confirming from
  // inside Canva sees this list and no other, and a page becoming the back is
  // the one row whose copies the import decides rather than leaves alone.
  const back = page.is_back ? '. The deck\u2019s back, 0 copies' : '';
  if (page.action === 'add') return `New card${back}`;
  const matched =
    page.matched_by === 'page_id'
      ? 'matched by Canva page'
      : page.matched_by === 'identity'
        ? 'matched by page name'
        : 'matched by page number';
  const updates =
    page.name === null ? `Updates a card, ${matched}` : `Updates ${page.name}, ${matched}`;
  return `${updates}${back}`;
}

function rowLabel(page: PlanRow): string {
  return page.title === null ? `Page ${page.page_number}` : `${page.page_number}. ${page.title}`;
}

export const App = () => {
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [user, setUser] = useState<HubUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  // Null while the project's decks are being fetched. An empty array is a
  // project with no decks, which is worth saying and is not what a fetch in
  // flight means.
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [projectId, setProjectId] = useState<string>('');
  const [deckId, setDeckId] = useState<string>('');
  // The export URLs belong with the design they came from, and only the
  // confirm step uses them. A ref rather than state: nothing renders from them,
  // and re-rendering on an export would only re-run the effects below.
  const exportedUrls = useRef<string[]>([]);

  const fail = (error: unknown) => setStage({ kind: 'error', message: apiMessage(error) });

  const connect = useCallback(async (switchAccount = false) => {
    setStage({ kind: 'checking' });
    try {
      // Minted fresh every time. Canva's token lasts five minutes, so a stored
      // one is a token that has usually expired.
      const canvaToken = await auth.getCanvaUserToken();
      const result = assertOk(
        await api.POST('/api/canva-app/session', {
          // Every open reports the build, which is what makes the record one of
          // what is running rather than of what somebody meant to upload.
          body: {
            token: canvaToken,
            build: APP_BUILD,
            ...(switchAccount ? { switch_account: true } : {}),
          },
        })
      );

      if (!result.linked) {
        setToken(null);
        setUser(null);
        setStage({ kind: 'pairing', code: result.pairing_code });
        return;
      }

      setToken(result.token);
      setUser(result.user);
      const loaded = assertOk(await api.GET('/api/projects')).projects as Project[];
      setProjects(loaded);
      setProjectId(loaded[0]?.id ?? '');
      setStage({ kind: 'picking' });
    } catch (error) {
      fail(error);
    }
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    if (projectId === '') {
      setDecks([]);
      setDeckId('');
      return;
    }
    setDecks(null);
    setDeckId('');
    void (async () => {
      try {
        const loaded = assertOk(
          await api.GET('/api/decks', { params: { query: { project_id: projectId } } })
        ).decks as Deck[];
        setDecks(loaded);
        setDeckId(loaded[0]?.id ?? '');
      } catch (error) {
        fail(error);
      }
    })();
  }, [projectId]);

  // Read the design, export it, and ask the server what importing would do.
  // Nothing is uploaded here -- the plan is read first, because re-importing
  // tombstones the cards the design has stopped having.
  const plan = async () => {
    try {
      setStage({ kind: 'working', label: 'Reading this design' });
      const design = await readDesign();

      setStage({ kind: 'working', label: 'Exporting pages from Canva' });
      const exported = await exportPages(design.pages.length);
      // Closing the dialog is not a failure, and the picking screen is where
      // that person was.
      if (exported === null) {
        setStage({ kind: 'picking' });
        return;
      }

      setStage({ kind: 'working', label: 'Working out what this import will do' });
      const run = await startRun(deckId, design);
      exportedUrls.current = exported.urls;
      setStage({ kind: 'planning', design, run });
    } catch (error) {
      if (error instanceof DesignError) setStage({ kind: 'error', message: error.message });
      else fail(error);
    }
  };

  const confirm = async (design: Design, run: StartedRun) => {
    setStage({ kind: 'uploading', done: 0, total: design.pages.length });
    try {
      const counts = await uploadPages(run.runId, design.pages, exportedUrls.current, (progress) =>
        setStage({ kind: 'uploading', done: progress.done, total: progress.total })
      );
      setStage({ kind: 'done', counts });
    } catch (error) {
      fail(error);
    }
  };

  const discard = async (run: StartedRun) => {
    setStage({ kind: 'working', label: 'Discarding this run' });
    try {
      await abandonRun(run.runId);
      setStage({ kind: 'picking' });
    } catch (error) {
      fail(error);
    }
  };

  return (
    <div className={styles.scrollContainer}>
      <Rows spacing="2u">
        <Title size="small">Three Peaks</Title>

        {stage.kind === 'checking' && <Working label="Connecting" />}

        {stage.kind === 'working' && <Working label={stage.label} />}

        {stage.kind === 'pairing' && (
          <Rows spacing="1u">
            <Text size="small">
              Enter this code on your account page at tools.threepeaksgames.com to connect Canva to
              your projects.
            </Text>
            <Title size="medium">{stage.code}</Title>
            <Text size="small" tone="tertiary">
              The code lasts ten minutes. Asking again replaces it.
            </Text>
            <Button variant="primary" onClick={() => void connect()} stretch>
              I have entered it
            </Button>
          </Rows>
        )}

        {stage.kind === 'picking' && (
          <Rows spacing="1u">
            <Text size="small">Import this design into a deck.</Text>
            <Select
              stretch
              value={projectId}
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
              onChange={setProjectId}
            />
            <Select
              stretch
              value={deckId}
              options={(decks ?? []).map((deck) => ({ value: deck.id, label: deck.name }))}
              onChange={setDeckId}
              disabled={decks === null || decks.length === 0}
              placeholder={decks === null ? 'Loading decks' : 'No decks'}
            />
            {decks !== null && decks.length === 0 && (
              <Text size="small" tone="tertiary">
                This project has no decks yet. Make one on the web first.
              </Text>
            )}
            <Button variant="primary" onClick={() => void plan()} disabled={deckId === ''} stretch>
              Export and check
            </Button>
            {user !== null && (
              <Button variant="tertiary" onClick={() => void connect(true)} stretch>
                {`Connected as ${user.name}`}
              </Button>
            )}
          </Rows>
        )}

        {stage.kind === 'planning' && (
          <Rows spacing="1u">
            <Text size="small">
              {`${stage.run.added} new, ${stage.run.updated} updated`}
              {stage.run.removed.length > 0 ? `, ${stage.run.removed.length} removed` : ''}
            </Text>
            {stage.run.removed.length > 0 && (
              <Rows spacing="0.5u">
                {/* Named rather than counted. Tombstoning artwork is the
                    destructive half of a re-import, and this is the only place
                    it can be seen coming. */}
                <Text size="small">These cards will be deleted:</Text>
                {stage.run.removed.map((card) => (
                  <Text key={card.file_id} size="small" tone="critical">
                    {card.name}
                  </Text>
                ))}
              </Rows>
            )}
            {/* Every page, not just the destructive half. The counts alone
                cannot say which card a page is about to land on, and matching
                by page number is the tier worth noticing before it runs. */}
            <Rows spacing="0.5u">
              {stage.run.pages.map((page) => (
                <Text key={page.page_number} size="small" tone="tertiary">
                  {`${rowLabel(page)} — ${rowDetail(page)}`}
                </Text>
              ))}
            </Rows>
            <Button variant="primary" onClick={() => void confirm(stage.design, stage.run)} stretch>
              {`Import ${stage.design.pages.length} pages`}
            </Button>
            <Button variant="secondary" onClick={() => void discard(stage.run)} stretch>
              Cancel
            </Button>
          </Rows>
        )}

        {stage.kind === 'uploading' && (
          <Rows spacing="1u">
            {/* The last page posted leaves the finish call still to run, and it
                is the one that decides what the deck ends up holding. */}
            <Working
              label={
                stage.done === stage.total
                  ? 'Finishing the import'
                  : `Uploading page ${stage.done + 1} of ${stage.total}`
              }
            />
            <ProgressBar
              value={stage.total === 0 ? 0 : Math.round((stage.done / stage.total) * 100)}
              ariaLabel="Pages uploaded"
            />
          </Rows>
        )}

        {stage.kind === 'done' && (
          <Rows spacing="1u">
            <Text size="small">
              {`${stage.counts.added} added, ${stage.counts.updated} updated, ` +
                `${stage.counts.unchanged} unchanged, ${stage.counts.removed} removed`}
            </Text>
            <Button variant="primary" onClick={() => setStage({ kind: 'picking' })} stretch>
              Done
            </Button>
          </Rows>
        )}

        {stage.kind === 'error' && (
          <Rows spacing="1u">
            <Text size="small">{stage.message}</Text>
            <Button variant="primary" onClick={() => void connect()} stretch>
              Start again
            </Button>
          </Rows>
        )}
      </Rows>
    </div>
  );
};
