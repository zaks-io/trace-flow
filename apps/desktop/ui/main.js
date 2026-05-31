// Trace Flow Desktop first-run / settings window.
// Talks to the Rust commands via the global Tauri bridge (withGlobalTauri = true). No bundler.

const invoke = window.__TAURI__.core.invoke;

const el = (id) => document.getElementById(id);
const msg = (text) => {
  el('msg').textContent = text || '';
};

async function refreshStatus() {
  const status = await invoke('connection_status');
  const dot = el('dot');
  dot.classList.toggle('connected', status.connected);

  let label;
  if (!status.connected) {
    label = 'Not connected';
  } else if (!status.credential_present || status.expired) {
    label = `Connected (${status.org_id}) — sign in again`;
  } else {
    label = `Connected — ${status.org_id} — ${status.sync}`;
  }
  el('status').textContent = label;

  el('raw-upload').checked = !!status.raw_upload;

  const ready = status.connected && status.credential_present && !status.expired;
  el('connect').textContent = status.connected ? 'Reconnect…' : 'Connect…';
  el('start').disabled = !ready;
  el('sync-now').disabled = !ready;
  el('disconnect').disabled = !status.connected;
}

async function refreshSources() {
  const sources = await invoke('detect_sources');
  const container = el('sources');
  container.replaceChildren();

  const span = (cls, text) => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    return s;
  };

  for (const s of sources) {
    const row = document.createElement('div');
    row.className = 'row';
    const left = span('src-name', s.source);
    const right = document.createElement('span');
    if (s.supported) {
      right.append(
        span('src-meta', `${s.file_count} files · ${s.location}`),
        document.createTextNode(' '),
        span('tag ready', 'ready'),
      );
    } else {
      right.append(span('tag unsupported', 'unsupported'));
    }
    row.append(left, right);
    container.append(row);
  }
}

async function refresh() {
  try {
    await Promise.all([refreshStatus(), refreshSources()]);
  } catch (err) {
    msg(`${err}`);
  }
}

el('connect').addEventListener('click', async () => {
  msg('Opening your browser to sign in…');
  el('connect').disabled = true;
  try {
    const org = await invoke('start_login');
    msg(`Connected to ${org}.`);
  } catch (err) {
    msg(`Login failed: ${err}`);
  } finally {
    el('connect').disabled = false;
    await refresh();
  }
});

el('raw-upload').addEventListener('change', async (e) => {
  try {
    await invoke('set_raw_upload', { value: e.target.checked });
  } catch (err) {
    e.target.checked = !e.target.checked;
    msg(`${err}`);
  }
});

el('start').addEventListener('click', async () => {
  msg('Syncing… you can close this window; it keeps running in the menu bar.');
  try {
    await invoke('start_syncing');
  } catch (err) {
    msg(`${err}`);
  }
  await refresh();
});

el('sync-now').addEventListener('click', async () => {
  msg('Running a sync…');
  try {
    await invoke('run_sync');
  } catch (err) {
    msg(`${err}`);
  }
  await refresh();
});

el('disconnect').addEventListener('click', async () => {
  try {
    await invoke('disconnect');
    msg('Disconnected. Local credential removed.');
  } catch (err) {
    msg(`${err}`);
  }
  await refresh();
});

refresh();
setInterval(refresh, 4000);
