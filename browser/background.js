/**
 * Posts what the pages report to yanpresence, on the loopback interface.
 *
 * This is the only part with network access: the page cannot reach 127.0.0.1
 * through its own CSP, and yanpresence only accepts requests carrying an
 * extension origin, which is exactly what a request from here has.
 */
const DEFAULTS = { host: '127.0.0.1', port: 8763, token: '' };

// Last payload per tab, so a closed tab can be retracted immediately instead
// of waiting for yanpresence to time it out.
const lastByTab = new Map();

async function settings() {
  try {
    return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  } catch {
    return DEFAULTS;
  }
}

async function post(payload) {
  const { host, port, token } = await settings();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-YanPresence-Token'] = token;

  try {
    await fetch(`http://${host}:${port}/state`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    // yanpresence is not running. Nothing to do about it here -- reporting
    // resumes on its own when it comes back.
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'yanpresence-state') return;

  const tabId = `${sender.tab?.id ?? 0}:${sender.frameId ?? 0}`;
  const payload = { ...message.payload, tabId };

  if (sender.tab?.id !== undefined) lastByTab.set(sender.tab.id, payload);
  post(payload);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const last = lastByTab.get(tabId);
  lastByTab.delete(tabId);
  if (last) post({ ...last, state: 'stopped' });
});
