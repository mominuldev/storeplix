import { isApiError } from '@storeplix/api-client';
import type { PreviewToEditorMessage, StoreTheme, ThemeConfig } from '@storeplix/types';
import { Button, cn, Dialog, Drawer, SegmentedControl } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Eye, Lock, Maximize2, Minimize2, PanelLeft, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { usePreviewStore } from '../../stores/usePreviewStore';
import { storeDomain, useTenantStore } from '../../stores/useTenantStore';
import { ConflictDialog, ErrorState, LoadingState } from '../components/Shell';
import { toast } from '../components/Toast';
import type { PickedMedia } from '../components/MediaPicker';
import { osKeys, useActiveTheme, useCanEditStore, useStorePages } from '../hooks';
import { AutosaveController, type AutosaveStatus } from './autosave';
import { countChanges } from './changes';
import { editorReducer, initEditor, type Device } from './editorReducer';
import type { FieldContext, LinkTarget } from './fields';
import { DEVICE_WIDTH, PreviewFrame, type PreviewFrameHandle } from './PreviewFrame';
import { SectionList, type Selection } from './SectionList';
import { SettingsPanel } from './SettingsPanel';
import { ThemeStyleForm } from './ThemeStyleForm';
import { validateThemeConfig } from './validate';

// Figma V3 editor · Home desktop 2045:48301 (Toolbar 2045:48302, Body 2045:48342), Design tab 2050:49617,
// Full screen 2047:49102, Phone 2045:48770. Full-screen route outside AppShell. Out of scope (hidden): Ask AI,
// Change it with words, history (clock), Rename, in-preview floating toolbar, extra design accordions.

export const AUTOSAVE_DELAY_MS = 600;

export default function ThemeEditorPage() {
  const { theme, isPending, isError, list } = useActiveTheme();
  const [generation, setGeneration] = useState(0);
  if (isPending) return <LoadingState label="Opening the editor" />;
  if (isError || !theme.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-canvas p-4">
        <ErrorState onRetry={() => void Promise.all([list.refetch(), theme.refetch()])} />
      </div>
    );
  }
  return (
    <ThemeEditor
      key={`${theme.data.id}:${generation}`}
      theme={theme.data}
      onReload={async () => {
        await theme.refetch();
        setGeneration((g) => g + 1);
      }}
    />
  );
}

function ThemeEditor({ theme, onReload }: { theme: StoreTheme; onReload: () => Promise<void> }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const store = useTenantStore().data!;
  const canEdit = useCanEditStore();
  const pages = useStorePages();
  const previewTab = usePreviewStore();
  const [state, dispatch] = useReducer(editorReducer, theme.draft_config, initEditor);
  const [locked, setLocked] = useState<Selection | null>(null);
  const [leftTab, setLeftTab] = useState<'sections' | 'style'>('sections');
  const [device, setDevice] = useState<Device>('desktop');
  const [scale, setScale] = useState(1);
  const [fullScreen, setFullScreen] = useState(false);
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(theme.draft_updated_at);
  const [published, setPublished] = useState<ThemeConfig | null>(theme.published_config);
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busyAction, setBusyAction] = useState<'publish' | 'discard' | 'leave' | null>(null);
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null);
  const [pickedMedia, setPickedMedia] = useState<Record<string, { url: string }>>({});
  const previewRef = useRef<PreviewFrameHandle>(null);
  const initialConfig = useRef(theme.draft_config);

  const [controller] = useState(
    () =>
      new AutosaveController<ThemeConfig, StoreTheme>({
        delay: AUTOSAVE_DELAY_MS,
        baseRevision: theme.draft_revision,
        save: async (config, base_revision) => {
          const saved = await api.storeThemes.saveDraft(store.id, theme.code, { config, base_revision });
          return { revision: saved.draft_revision, result: saved };
        },
      }),
  );
  // Callbacks touch refs/state, so they are bound in an effect (setters and refs are stable) rather than during render.
  useEffect(() => {
    controller.setHandlers({
      onStatus: setStatus,
      onSaved: (saved) => {
        setSavedAt(saved.draft_updated_at);
        setServerErrors({});
        queryClient.setQueryData(osKeys.storeTheme(store.id, theme.code), saved);
        previewRef.current?.refresh();
      },
      onConflict: () => setConflict(true),
      onInvalid: (details) => setServerErrors(details),
      onError: () => toast('We couldn’t save your last change. We’ll retry with the next one.', 'error'),
    });
  }, [controller, queryClient, store.id, theme.code]);

  const clientErrors = useMemo(() => validateThemeConfig(state.config), [state.config]);
  const errors = useMemo(() => ({ ...serverErrors, ...clientErrors }), [serverErrors, clientErrors]);
  const invalid = Object.keys(clientErrors).length > 0;

  // Autosave every change (except the initial load) once it passes client validation.
  useEffect(() => {
    if (!canEdit || state.config === initialConfig.current) return;
    if (invalid) return;
    controller.schedule(state.config);
  }, [state.config, canEdit, invalid, controller]);

  // Leaving while a save is pending or in flight: browser prompt; in-app exits flush first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!controller.busy) return;
      e.preventDefault();
      e.returnValue = 'Your latest change is still saving';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Router navigation away (e.g. browser back): send whatever is pending instead of dropping it.
      void controller.flush();
    };
  }, [controller]);

  const selection: Selection | null = locked ?? (state.selectedId ? { kind: 'section', id: state.selectedId } : null);

  const select = useCallback((s: Selection) => {
    if (s.kind === 'locked') setLocked(s);
    else {
      setLocked(null);
      dispatch({ type: 'select', id: s.id });
    }
    setLeftTab('sections');
  }, []);

  useEffect(() => {
    previewRef.current?.select(selection?.kind === 'section' ? selection.id : null);
  }, [selection?.kind, selection?.kind === 'section' ? selection.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPreviewMessage = useCallback(
    (msg: PreviewToEditorMessage) => {
      if (msg.type === 'section-click' && state.config.sections.some((s) => s.id === msg.section_id)) select({ kind: 'section', id: msg.section_id });
    },
    [state.config.sections, select],
  );

  // Keyboard: F = full screen, ⌘/Ctrl+Z = undo (outside text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) setFullScreen((f) => !f);
      if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && canEdit) {
        e.preventDefault();
        dispatch({ type: 'undo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit]);

  useEffect(() => {
    if (state.notice) toast(state.notice, 'error');
  }, [state.notice]);

  const changes = countChanges(state.config, published);
  const leave = () => navigate('/online-store/themes');

  const onBack = () => {
    if (controller.busy) setConfirmLeave(true);
    else leave();
  };

  const publish = async () => {
    setBusyAction('publish');
    try {
      await controller.flush();
      if (controller.status === 'conflict' || controller.status === 'invalid') return;
      const t = await api.storeThemes.publish(store.id, theme.code, { draft_revision: controller.baseRevision });
      setPublished(t.published_config);
      queryClient.setQueryData(osKeys.storeTheme(store.id, theme.code), t);
      void queryClient.invalidateQueries({ queryKey: osKeys.storeThemes(store.id) });
      toast('Published. Your shop updates in a few seconds.');
    } catch (e) {
      if (isApiError(e) && e.status === 409 && e.code === 'revision_conflict') setConflict(true);
      else toast(isApiError(e) ? e.message : 'Publishing failed. Try again.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const discard = async () => {
    setBusyAction('discard');
    try {
      await controller.flush();
      const t = await api.storeThemes.discard(store.id, theme.code);
      initialConfig.current = t.draft_config;
      controller.reset(t.draft_revision);
      dispatch({ type: 'reset', config: t.draft_config });
      setPublished(t.published_config);
      setSavedAt(t.draft_updated_at);
      setServerErrors({});
      queryClient.setQueryData(osKeys.storeTheme(store.id, theme.code), t);
      previewRef.current?.refresh();
      toast('Changes discarded. You’re back to the live version.');
    } catch (e) {
      if (isApiError(e) && e.status === 409 && e.code === 'revision_conflict') setConflict(true);
      else toast(isApiError(e) ? e.message : 'Couldn’t discard. Try again.', 'error');
    } finally {
      setBusyAction(null);
      setConfirmDiscard(false);
    }
  };

  const linkTargets: LinkTarget[] = useMemo(
    () => [
      { label: 'Home page', href: '/' },
      ...(pages.data?.data ?? []).filter((p) => p.status === 'published').map((p) => ({ label: `Page · ${p.title}`, href: `/pages/${p.slug}` })),
      { label: 'Track order', href: '/track-order' },
    ],
    [pages.data],
  );

  const media = useMemo(() => {
    const out: Record<string, { url: string }> = {};
    for (const [id, ref] of Object.entries(theme.media ?? {})) out[id] = { url: ref.url };
    return { ...out, ...pickedMedia };
  }, [theme.media, pickedMedia]);

  const ctx: FieldContext = {
    disabled: !canEdit,
    media,
    linkTargets,
    onMediaPicked: (m: PickedMedia) => setPickedMedia((prev) => ({ ...prev, [m.id]: { url: m.url } })),
  };

  const statusLabel =
    status === 'saving' || status === 'pending'
      ? 'Saving…'
      : status === 'error'
        ? 'Not saved'
        : status === 'invalid' || invalid
          ? 'Fix the highlighted fields to save'
          : savedAt
            ? `Saved ${new Date(savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
            : '';

  const left = (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        size="sm"
        aria-label="Left panel"
        value={leftTab}
        onChange={setLeftTab}
        options={[
          { value: 'sections', label: 'Sections' },
          { value: 'style', label: 'Theme style' },
        ]}
      />
      {leftTab === 'sections' ? (
        <SectionList
          config={state.config}
          selection={selection}
          onSelect={(s) => {
            select(s);
            setDrawer(null);
          }}
          dispatch={dispatch}
          readOnly={!canEdit}
        />
      ) : (
        <ThemeStyleForm config={state.config} dispatch={dispatch} disabled={!canEdit} />
      )}
    </div>
  );
  const right = <SettingsPanel config={state.config} selection={selection} dispatch={dispatch} errors={errors} ctx={ctx} />;

  return (
    <div className="flex h-dvh flex-col bg-surface-subtle">
      {/* Toolbar 2045:48302 */}
      <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-border-default bg-surface-card pr-3 pl-2 sm:gap-3 sm:pr-4 sm:pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <button type="button" aria-label="Back to themes" onClick={onBack} className="flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
            <ChevronLeft aria-hidden className="size-4" />
          </button>
          <div className="hidden min-w-0 flex-col rounded-control border border-border-default py-1.5 pr-2 pl-2.5 sm:flex">
            <span className="truncate text-[10px] leading-[13px] font-medium text-text-muted">{theme.name} theme · Page</span>
            <span className="text-[13px] leading-[18px] font-semibold text-text-primary">Home page</span>
          </div>
          {changes > 0 && (
            <span className="flex shrink-0 items-center gap-[5px] rounded-full bg-warning-bg px-2 py-0.5 text-[11px] leading-4 font-medium text-warning">
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              {changes} change{changes === 1 ? '' : 's'}
            </span>
          )}
          <span role="status" aria-live="polite" className={cn('hidden truncate text-caption md:inline', status === 'error' || invalid ? 'text-danger' : 'text-text-muted')}>
            {canEdit ? statusLabel : ''}
          </span>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <SegmentedControl<Device>
            size="sm"
            aria-label="Preview device"
            value={device}
            onChange={setDevice}
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'tablet', label: 'Tablet' },
              { value: 'phone', label: 'Phone' },
            ]}
          />
          <span className="w-9 text-caption font-medium text-text-muted" aria-label={`Zoom ${Math.round(scale * 100)}%`}>
            {Math.round(scale * 100)}%
          </span>
          <span aria-hidden className="h-5 w-px bg-border-default" />
          <button
            type="button"
            aria-label={fullScreen ? 'Exit full screen (F)' : 'Full screen (F)'}
            title={fullScreen ? 'Exit full screen (F)' : 'Full screen (F)'}
            aria-pressed={fullScreen}
            onClick={() => setFullScreen((f) => !f)}
            className="flex size-8 items-center justify-center rounded-md bg-surface-subtle outline-none focus-visible:shadow-focus"
          >
            {fullScreen ? <Minimize2 aria-hidden className="size-4" /> : <Maximize2 aria-hidden className="size-4" />}
          </button>
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          <button type="button" aria-label="Sections" onClick={() => setDrawer('left')} className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-surface-subtle focus-visible:shadow-focus lg:hidden">
            <PanelLeft aria-hidden className="size-4" />
          </button>
          <button type="button" aria-label="Section settings" onClick={() => setDrawer('right')} className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-surface-subtle focus-visible:shadow-focus lg:hidden">
            <SlidersHorizontal aria-hidden className="size-4" />
          </button>
          {canEdit && (
            <button
              type="button"
              aria-label="Undo"
              title="Undo (⌘Z)"
              disabled={state.past.length === 0}
              onClick={() => dispatch({ type: 'undo' })}
              className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:opacity-40"
            >
              <Undo2 aria-hidden className="size-4" />
            </button>
          )}
          <Button variant="secondary" className="hidden sm:inline-flex" leftIcon={<Eye aria-hidden className="size-4" />} loading={previewTab.isPending} onClick={() => previewTab.mutate(store.id)}>
            Preview
          </Button>
          {canEdit ? (
            <>
              <Button variant="ghost" className="hidden xl:inline-flex" disabled={!published || busyAction !== null || changes === 0} onClick={() => setConfirmDiscard(true)}>
                Discard
              </Button>
              <Button loading={busyAction === 'publish'} disabled={busyAction !== null || invalid || conflict} onClick={() => void publish()}>
                Publish
              </Button>
            </>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-surface-subtle px-3 py-1.5 text-caption font-medium text-text-secondary">
              <Lock aria-hidden className="size-3.5" /> View only
            </span>
          )}
        </div>
      </header>

      {!canEdit && (
        <div role="note" className="flex items-center justify-center gap-2 border-b border-border-default bg-info-bg px-4 py-2 text-caption text-info">
          <Lock aria-hidden className="size-3.5" /> You’re viewing the editor. Ask a manager to make changes.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {!fullScreen && <aside aria-label="Sections" className="hidden w-72 shrink-0 overflow-y-auto border-r border-border-default bg-surface-card p-4 lg:block">{left}</aside>}
        <main className="flex min-w-0 flex-1 flex-col">
          <p className="pt-3 pb-1 text-center text-caption text-text-muted">
            {storeDomain(store)} · {DEVICE_WIDTH[device]} px wide
          </p>
          <PreviewFrame ref={previewRef} path="/" device={device} onScale={setScale} onMessage={onPreviewMessage} label={`${store.name} preview`} />
        </main>
        {!fullScreen && <aside aria-label="Section settings" className="hidden w-80 shrink-0 overflow-y-auto border-l border-border-default bg-surface-card p-5 lg:block">{right}</aside>}
      </div>

      <Drawer open={drawer === 'left'} onClose={() => setDrawer(null)} title="Sections" side="left">
        <div className="p-4">{left}</div>
      </Drawer>
      <Drawer open={drawer === 'right'} onClose={() => setDrawer(null)} title="Section settings" side="right">
        <div className="p-4">{right}</div>
      </Drawer>

      <Dialog
        open={confirmDiscard}
        tone="danger"
        title="Discard all unpublished changes?"
        description="Your theme goes back to what buyers see now. This can’t be undone."
        confirmLabel="Discard changes"
        loading={busyAction === 'discard'}
        onConfirm={() => void discard()}
        onCancel={() => setConfirmDiscard(false)}
      />
      <Dialog
        open={confirmLeave}
        title="Your latest change is still saving"
        description="Wait a moment so it isn’t lost, or save it now and leave."
        confirmLabel="Save and leave"
        cancelLabel="Stay"
        loading={busyAction === 'leave'}
        onConfirm={async () => {
          setBusyAction('leave');
          await controller.flush();
          setBusyAction(null);
          setConfirmLeave(false);
          leave();
        }}
        onCancel={() => setConfirmLeave(false)}
      />
      <ConflictDialog
        open={conflict}
        loading={reloading}
        onReload={async () => {
          setReloading(true);
          await onReload();
        }}
      />
    </div>
  );
}
