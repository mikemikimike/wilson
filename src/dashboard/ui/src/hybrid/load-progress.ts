/**
 * In-tab model load progress: the labels a first use shows, and the mapping
 * from transformers.js progress events to them. Pure (no DOM, no
 * transformers.js), so the model engine runs it in the worker and bun tests
 * pin the wording.
 *
 * "Downloading" only while weights are fetched from the Hub, with the size
 * the catalog gives (GET /api/config/local-chat downloadSize); "Loading" once
 * the weights are cached and only being read and initialised. transformers.js
 * emits the same progress events for a Cache API read as for a network
 * download, so the engine checks the cache before loading and passes the
 * answer in as `cached`.
 */

export const IN_TAB_PREPARING_LABEL = 'Preparing in-tab model…';
export const IN_TAB_LOADING_LABEL = 'Loading in-tab model…';
export const IN_TAB_WARMUP_LABEL = 'Warming up in-tab model…';

/** Catalog size ('~3.6GB', '~570MB') as display text ('3.6 GB'); null when it is not a size ('unknown', ''). */
export function formatDownloadSize(raw: string | null | undefined): string | null {
  const m = /^\s*~?\s*(\d+(?:\.\d+)?)\s*([KMGT]B)\s*$/i.exec(raw ?? '');
  return m ? `${m[1]} ${m[2].toUpperCase()}` : null;
}

/** "Downloading in-tab model (3.6 GB, first use only)… 42%"; size and percent are each optional. */
export function downloadingLabel(size: string | null, pct?: number | null): string {
  const what = size ? `${size}, first use only` : 'first use only';
  const tail = typeof pct === 'number' && Number.isFinite(pct) ? ` ${clampPct(pct)}%` : '';
  return `Downloading in-tab model (${what})…${tail}`;
}

/** "Loading in-tab model… 42%" (cached weights being read and initialised). */
export function loadingLabel(pct?: number | null): string {
  return typeof pct === 'number' && Number.isFinite(pct) ? `${IN_TAB_LOADING_LABEL} ${clampPct(pct)}%` : IN_TAB_LOADING_LABEL;
}

/** Floor, so 99.6% of the bytes never reads as 100% while they are still arriving. */
function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, Math.floor(pct)));
}

/** The transformers.js progress_callback fields this reads. */
export interface LoadProgressEvent {
  status?: string;
  progress?: number;
  file?: string;
}

export interface LoadProgressReporterOpts {
  /** True: every file is in the Cache API. False or undefined (unknown): treat bytes as a download. */
  cached: boolean | undefined;
  /** Catalog downloadSize, raw ('~3.6GB'). */
  downloadSize: string | null | undefined;
  emit: (label: string) => void;
}

/**
 * A progress_callback for pipeline(). Prefers the aggregate `progress_total`
 * event (all files, by bytes) and falls back to per-file `progress` only when
 * no aggregate arrives. Emits on every event, not only when the text changes:
 * the worker backend's load timeout restarts on each progress message, so a
 * slow download must keep reporting. Once a download reaches 100% the bytes
 * are in and the label switches to "Loading" (session creation follows).
 */
export function createLoadProgressReporter(opts: LoadProgressReporterOpts): (event: LoadProgressEvent) => void {
  const size = formatDownloadSize(opts.downloadSize);
  const downloading = opts.cached !== true;
  let sawTotal = false;
  const label = (pct: number | undefined) =>
    !downloading ? loadingLabel(pct) : typeof pct === 'number' && pct >= 100 ? loadingLabel() : downloadingLabel(size, pct);
  return (event) => {
    if (event.status === 'progress_total' && typeof event.progress === 'number') {
      sawTotal = true;
      opts.emit(label(event.progress));
    } else if (event.status === 'progress' && typeof event.progress === 'number') {
      if (!sawTotal) opts.emit(label(event.progress));
    } else if (event.status === 'initiate' || event.status === 'download') {
      if (!sawTotal) opts.emit(label(undefined));
    }
  };
}

/**
 * Appended to the load progress in the chat status line while the server
 * answers meanwhile: only when the server's chat model runs on this machine
 * (the legacy dashboard embeds it too).
 */
export const IN_TAB_SERVER_MEANWHILE = " · the server answers until it's ready";
/**
 * Appended instead when chat turns wait for the in-tab model (the server's
 * model is not on this machine, or that is unknown): "Downloading in-tab
 * model (3.6 GB, first use only)… answers start when it's ready", with a " · "
 * after a percent.
 */
export const IN_TAB_WAITS_FOR_MODEL = "answers start when it's ready";

/**
 * The status line the chat shows beside the composer while the in-tab model
 * is loading: its progress, and whether the server answers meanwhile
 * (`serverMeanwhile`, true only for a local server model) or answers start
 * once it is ready. Null when there is nothing to say (idle, ready, or
 * failed: a failure shows as the note under the server's answer). The legacy
 * dashboard (html.ts) mirrors it inline from the same constants.
 */
export function inTabStatusLine(status: { state: string; label?: string; serverMeanwhile?: boolean }): string | null {
  if (status.state !== 'loading') return null;
  const label = status.label?.trim() || IN_TAB_PREPARING_LABEL;
  if (status.serverMeanwhile === true) return `${label}${IN_TAB_SERVER_MEANWHILE}`;
  return `${label}${label.endsWith('…') ? ' ' : ' · '}${IN_TAB_WAITS_FOR_MODEL}`;
}
