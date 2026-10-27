import { EditorApp } from './ui/app';
import { toast } from './ui/dom';
import { t } from './i18n';

const root = document.getElementById('app');
if (!root) {
  throw new Error(t('main.mountMissing'));
}

try {
  const app = new EditorApp(root);
  // Exposed for debugging in the browser console and for automated tests
  (window as unknown as Record<string, unknown>).vectanim = app;
} catch (error) {
  console.error(error);
  toast(t('main.initFailed', { error: error instanceof Error ? error.message : String(error) }), { type: 'error', duration: 12000 });
  root.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#f87171">
    <h2>${t('main.initFailedTitle')}</h2>
    <pre style="white-space:pre-wrap;color:#a9b7cd">${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}</pre>
  </div>`;
}

window.addEventListener('error', (event) => {
  console.error(event.error ?? event.message);
});
