// Trace Flow Desktop first-run / settings window.
// Talks to the Rust commands via the global Tauri bridge (withGlobalTauri = true). No bundler.

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const el = (id) => document.getElementById(id);
const msg = (text) => {
  el('msg').textContent = text || '';
};

function applyUpdateStatus(status) {
  const button = el('update');
  button.disabled = status.status === 'checking' || status.status === 'installing';
  if (status.status === 'checking') {
    button.textContent = 'Checking for updates…';
  } else if (status.status === 'installing') {
    button.textContent = `Installing ${status.version}…`;
  } else {
    button.textContent = 'Update to latest';
  }
}

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
  if (status.archive_error) {
    label += ` — Archive: ${status.archive_error}`;
  }
  el('status').textContent = label;

  const ready = status.connected && status.credential_present && !status.expired;
  el('connect').textContent = status.connected ? 'Reconnect…' : 'Connect…';
  el('start').disabled = !ready;
  el('sync-now').disabled = !ready;
  el('disconnect').disabled = !status.connected;
  applyUpdateStatus(status.update);
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

el('update').addEventListener('click', async () => {
  const button = el('update');
  button.disabled = true;
  button.textContent = 'Checking for updates…';
  msg('Checking for the latest version…');
  try {
    const result = await invoke('update_to_latest');
    msg(`Trace Flow Desktop ${result.currentVersion} is up to date.`);
  } catch (err) {
    msg(`Update failed: ${err}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Update to latest';
  }
});

function show(id, visible) {
  el(id).classList.toggle('hidden', !visible);
}

function selectedHistory() {
  const checked = document.querySelector('input[name="history"]:checked');
  return checked ? checked.value : 'new_only';
}

function renderArchive(dto) {
  if (!dto) return;
  const flow = dto.flow;
  const local = dto.local;
  const health = [];
  if (local.policy && local.policy !== 'inactive') {
    health.push(`Local enrollment: ${local.policy}`);
  }
  if (local.spool_bytes != null) {
    health.push(`Spool ${local.spool_bytes} / ${local.spool_cap_bytes} bytes`);
  }
  if (local.archive_error || local.load_error) {
    health.push(local.archive_error || local.load_error);
  }
  if (local.acknowledged_content_remains && (flow.step === 'left' || local.policy === 'revoked')) {
    health.push(
      'Acknowledged archive content remains until the owner deletes it. Re-enrollment needs a fresh history choice.',
    );
  }
  el('archive-health').textContent = health.join(' · ');

  el('archive-sources').textContent =
    `Covered now: ${flow.covered_sources.join(', ')}. Later Sources (${flow.unsupported_sources.join(', ')}) stay off until you add them.`;
  el('history-new-detail').textContent = flow.history_new_only_detail;
  el('history-all-detail').textContent = flow.history_all_detail;
  const disclosures = el('archive-disclosures');
  disclosures.replaceChildren();
  for (const text of flow.disclosures) {
    const p = document.createElement('p');
    p.className = 'disclosure';
    p.textContent = text;
    disclosures.append(p);
  }

  const consent = flow.step === 'consent';
  const failed = flow.step === 'failed';
  const enrolled = flow.step === 'enrolled' || local.policy === 'enrolled';
  const ineligible = flow.step === 'ineligible';
  show('archive-consent', consent);
  show('archive-confirm', consent);
  show('archive-decline', consent);
  show('archive-retry', failed);
  show('archive-unenroll', enrolled);
  show('archive-revoke', enrolled);
  const connectedReady = !el('start').disabled;
  el('archive-enable').disabled = !connectedReady || consent || enrolled;
  el('archive-contribute').disabled = !connectedReady || consent || enrolled;

  if (ineligible) {
    el('archive-summary').textContent = `Cannot continue: ${flow.ineligible_reason}`;
  } else if (flow.step === 'declined_history') {
    el('archive-summary').textContent =
      'History choice declined. Nothing was enrolled. Start again to choose.';
  } else if (enrolled) {
    el('archive-summary').textContent = 'This computer is enrolled. Fact sync continues independently.';
  } else {
    el('archive-summary').textContent =
      'Parsed fact sync stays on. Archive enrollment is a separate Pro consent.';
  }
  if (flow.error) msg(flow.error);
}

async function refreshArchive() {
  try {
    const dto = await invoke('archive_status');
    renderArchive(dto);
  } catch {
    // Not connected yet — keep the card in its idle copy.
  }
}

el('archive-enable').addEventListener('click', async () => {
  msg('Sign in as the Organization owner to enable Conversation Archive…');
  try {
    renderArchive(await invoke('start_archive_enable'));
  } catch (err) {
    msg(`${err}`);
  }
});

el('archive-contribute').addEventListener('click', async () => {
  msg('Sign in to contribute this computer…');
  try {
    renderArchive(await invoke('start_archive_contribute'));
  } catch (err) {
    msg(`${err}`);
  }
});

el('archive-confirm').addEventListener('click', async () => {
  try {
    await invoke('choose_archive_history', { choice: selectedHistory() });
    renderArchive(await invoke('confirm_archive_flow'));
  } catch (err) {
    msg(`${err}`);
  }
});

el('archive-decline').addEventListener('click', async () => {
  try {
    renderArchive(await invoke('decline_archive_history'));
  } catch (err) {
    msg(`${err}`);
  }
});

el('archive-retry').addEventListener('click', async () => {
  try {
    renderArchive(await invoke('retry_archive_flow'));
  } catch (err) {
    msg(`${err}`);
  }
});

el('archive-unenroll').addEventListener('click', async () => {
  msg('Unenrolling stops archive upload with no final flush.');
  try {
    renderArchive(await invoke('unenroll_archive'));
  } catch (err) {
    msg(`${err}`);
  }
});

el('archive-revoke').addEventListener('click', async () => {
  msg('Owner revocation stops this Collector with no final archive upload.');
  try {
    renderArchive(await invoke('revoke_archive_collector'));
  } catch (err) {
    msg(`${err}`);
  }
});

listen('desktop-update-status', (event) => applyUpdateStatus(event.payload)).catch((err) => {
  msg(`Update status listener failed: ${err}`);
});

refresh();
refreshArchive();
setInterval(() => {
  refresh();
  refreshArchive();
}, 4000);
