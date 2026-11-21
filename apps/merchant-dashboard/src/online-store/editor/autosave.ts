import { isApiError, type ApiErrorDetails } from '@storeplix/api-client';

// Contract §6 autosave: debounce (600 ms theme / 800 ms pages); at most one request in flight; the latest
// queued state is saved after it; each response sets the next base revision. 409 → stop and report a conflict;
// 422 → report field errors and keep the local state.

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'invalid' | 'conflict';

export interface AutosaveOptions<T, R> {
  delay: number;
  baseRevision: number;
  save: (value: T, baseRevision: number) => Promise<{ revision: number; result: R }>;
  onStatus?: (status: AutosaveStatus) => void;
  onSaved?: (result: R, value: T) => void;
  onConflict?: () => void;
  onInvalid?: (details: ApiErrorDetails) => void;
  onError?: (error: unknown) => void;
}

export type AutosaveHandlers<T, R> = Pick<AutosaveOptions<T, R>, 'onStatus' | 'onSaved' | 'onConflict' | 'onInvalid' | 'onError'>;

export class AutosaveController<T, R = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: { value: T } | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private _status: AutosaveStatus = 'idle';
  baseRevision: number;

  constructor(private opts: AutosaveOptions<T, R>) {
    this.baseRevision = opts.baseRevision;
  }

  /** Swaps the callbacks (React components re-bind them after every render). */
  setHandlers(handlers: AutosaveHandlers<T, R>) {
    this.opts = { ...this.opts, ...handlers };
  }

  get status() {
    return this._status;
  }

  /** True while a debounce is pending or a save is in flight (drives the leave guard). */
  get busy(): boolean {
    return this.timer !== null || this.inFlight !== null || this.latest !== null;
  }

  private setStatus(s: AutosaveStatus) {
    this._status = s;
    this.opts.onStatus?.(s);
  }

  schedule(value: T) {
    if (this.stopped) return;
    this.latest = { value };
    if (this.timer) clearTimeout(this.timer);
    this.setStatus(this.inFlight ? 'saving' : 'pending');
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.opts.delay);
  }

  /** Saves immediately (publish, leave) and resolves once nothing is pending or in flight. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (!this.stopped && (this.inFlight || this.latest)) {
      if (this.inFlight) await this.inFlight;
      else await this.run();
    }
  }

  /** Cancels pending work (after a conflict, or on unmount). */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
  }

  /** Re-arms after a reload with a fresh revision. */
  reset(baseRevision: number) {
    this.stop();
    this.stopped = false;
    this.baseRevision = baseRevision;
    this.setStatus('idle');
  }

  private run(): Promise<void> {
    if (this.inFlight || !this.latest || this.stopped) return this.inFlight ?? Promise.resolve();
    const { value } = this.latest;
    this.latest = null;
    this.setStatus('saving');
    this.inFlight = this.opts
      .save(value, this.baseRevision)
      .then(({ revision, result }) => {
        this.baseRevision = revision;
        this.opts.onSaved?.(result, value);
        if (!this.latest && !this.timer) this.setStatus('saved');
      })
      .catch((error: unknown) => {
        if (isApiError(error) && error.status === 409) {
          this.stop();
          this.setStatus('conflict');
          this.opts.onConflict?.();
        } else if (isApiError(error) && error.status === 422) {
          this.setStatus('invalid');
          this.opts.onInvalid?.(error.details ?? {});
        } else {
          this.setStatus('error');
          this.opts.onError?.(error);
        }
      })
      .finally(() => {
        this.inFlight = null;
        // A change arrived while saving and its debounce already elapsed → save it now.
        if (this.latest && !this.timer && !this.stopped) void this.run();
      });
    return this.inFlight;
  }
}
