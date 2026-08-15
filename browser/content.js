/**
 * Isolated-world half of the pair. The page-world script cannot reach the
 * network (Apple's CSP) and the service worker cannot reach the page, so this
 * sits between them and does nothing else.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__yanpresence !== 1 || !data.payload) return;

  try {
    chrome.runtime.sendMessage({ type: 'yanpresence-state', payload: data.payload });
  } catch {
    // The extension was reloaded or is shutting down; the next tick retries.
  }
});
