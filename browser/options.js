const DEFAULTS = { host: '127.0.0.1', port: 8763, token: '' };
const $ = (id) => document.getElementById(id);
const status = (text, ok) => {
  $('status').textContent = text;
  $('status').className = ok === undefined ? '' : ok ? 'ok' : 'bad';
};

chrome.storage.local.get(DEFAULTS).then((saved) => {
  $('host').value = saved.host;
  $('port').value = saved.port;
  $('token').value = saved.token;
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    host: $('host').value.trim() || DEFAULTS.host,
    port: Number($('port').value) || DEFAULTS.port,
    token: $('token').value.trim(),
  });
  status('Saved.', true);
});

$('test').addEventListener('click', async () => {
  const host = $('host').value.trim() || DEFAULTS.host;
  const port = Number($('port').value) || DEFAULTS.port;
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    const body = await res.json();
    status(
      body.app === 'yanpresence'
        ? `Connected — yanpresence is listening (${body.tabs} tab(s) reporting).`
        : `Something answered on ${host}:${port}, but it was not yanpresence.`,
      body.app === 'yanpresence'
    );
  } catch (err) {
    status(`No answer from ${host}:${port} — is yanpresence running?`, false);
  }
});
