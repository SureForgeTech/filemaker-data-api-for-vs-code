import { createRequire } from 'module';
import path from 'path';
import { buildSync } from 'esbuild';

/** A real DOM (jsdom, installed by the designer-ui workspace) for running a webview page script in unit tests. */
export interface DomElement {
  id: string;
  tagName: string;
  value: string;
  textContent: string | null;
  className: string;
  checked: boolean;
  disabled: boolean;
  classList: { contains(token: string): boolean };
  click(): void;
  contains(other: unknown): boolean;
  querySelectorAll(selector: string): DomElement[];
  querySelector(selector: string): DomElement | null;
  getAttribute(name: string): string | null;
}
export interface JsdomWindow {
  document: {
    getElementById(id: string): DomElement | null;
    body: { textContent: string | null };
    dispatchEvent(event: unknown): boolean;
    querySelectorAll(selector: string): DomElement[];
  };
  eval(code: string): void;
  dispatchEvent(event: unknown): boolean;
  MessageEvent: new (type: string, init: { data: unknown; origin?: string }) => unknown;
  Event: new (type: string) => unknown;
  location: { origin: string };
}
type JsdomCtor = new (html: string, options: { runScripts: string; url: string }) => { window: JsdomWindow };

export let JSDOM: JsdomCtor | undefined;
try {
  JSDOM = (createRequire(path.resolve(__dirname, '../../../designer-ui/package.json'))('jsdom') as { JSDOM: JsdomCtor }).JSDOM;
} catch {
  JSDOM = undefined;
}

export interface WebviewStateOptions {
  /** The snapshot the page reads with `getState()`. */
  state?: unknown;
  /** Receives every snapshot the page writes with `setState()`. */
  onSetState?: (value: unknown) => void;
}

/** Loads a webview's HTML and runs its page script; returns the window, what the page posts, and a way to message it. */
export function loadPage(html: string, uiSource: string, url = 'https://panel.invalid/', options: WebviewStateOptions = {}) {
  const dom = new (JSDOM as JsdomCtor)(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''), { runScripts: 'outside-only', url });
  const { window } = dom;
  const posted: Array<Record<string, unknown>> = [];
  // Only a page that asks for it sees a stored state; every other caller keeps the old no-op store.
  const tracksState = 'state' in options || 'onSetState' in options;
  let storedState = options.state;
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    getState: () => (tracksState ? storedState : undefined),
    setState: (value: unknown) => {
      if (!tracksState) {
        return;
      }
      storedState = value;
      options.onSetState?.(value);
    }
  });
  if (html.includes('fieldStandards.js')) {
    window.eval(buildSync({ entryPoints: [path.resolve(__dirname, '../../../shared/src/field-standards.ts')],
      bundle: true, platform: 'browser', format: 'iife', globalName: 'FieldStandards', write: false }).outputFiles[0]!.text + '\nwindow.FieldStandards = FieldStandards;');
  }
  window.eval(uiSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const send = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data, origin: window.location.origin }));
  return { window, document: window.document, posted, send };
}
