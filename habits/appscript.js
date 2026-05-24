// Habits Tracker — hosted logic, loaded by the launcher in Apps Script
// Update this file → all users get the change within 6 hours automatically.

function handleGet(e, ss) {
  const p = e.parameter || {};
  try {
    switch (p.action) {
      case 'ping':       return j({ ok: true });
      case 'init':       return j(init(ss));
      case 'getAll':     return j(getAll(ss));
      case 'getConfig':  return j(getConfig(ss));
      case 'cleanSheet': return j(cleanSheet(ss));
      default:           return j({ error: 'Unknown action: ' + p.action });
    }
  } catch (err) { return j({ error: String(err) }); }
}

function handlePost(e, ss) {
  const p = e.parameter || {};
  try {
    switch (p.action) {
      case 'saveDay':    return j(saveDay(ss, p));
      case 'saveConfig': return j(saveConfig(ss, p));
      case 'chat':       return j(handleChat(p));
      default:           return j({ error: 'Unknown action: ' + p.action });
    }
  } catch (err) { return j({ error: String(err) }); }
}

function j(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function fmtDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).trim().slice(0, 10);
}

function getSheet(ss) {
  let s = ss.getSheetByName('Habits');
  if (!s) {
    s = ss.insertSheet('Habits');
    const hdr = s.getRange(1, 1, 1, 1);
    hdr.setValues([['date']]);
    hdr.setFontWeight('bold').setBackground('#111').setFontColor('#fff');
    s.setFrozenRows(1);
  }
  return s;
}

function getConfig(ss) {
  const s = ss.getSheetByName('Config');
  if (!s) return { config: null };
  const val = s.getRange('A1').getValue();
  if (!val) return { config: null };
  try { return { config: JSON.parse(String(val)) }; } catch(_) { return { config: null }; }
}

function saveConfig(ss, p) {
  let s = ss.getSheetByName('Config');
  if (!s) s = ss.insertSheet('Config');
  s.getRange('A1').setValue(p.configJson);
  return { ok: true };
}

function init(ss) {
  const cfg  = getConfig(ss);
  const data = getAll(ss);
  return { config: cfg.config, rows: data.rows };
}

function getAll(ss) {
  const s = getSheet(ss);
  const v = s.getDataRange().getValues();
  if (v.length <= 1) return { rows: [] };
  const h = v[0].map(String);
  const rows = [];
  for (let i = 1; i < v.length; i++) {
    const row = {};
    h.forEach((k, j) => { row[k] = k === 'date' ? fmtDateStr(v[i][j]) : (v[i][j] === '' ? null : v[i][j]); });
    rows.push(row);
  }
  return { rows };
}

function saveDay(ss, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const s    = getSheet(ss);
    const skip = new Set(['action', 'token', 'date']);
    let lastCol = s.getLastColumn();
    let headers = s.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const toAdd = Object.keys(p).filter(k => !skip.has(k) && !headers.includes(k));
    if (toAdd.length > 0) {
      const r = s.getRange(1, lastCol + 1, 1, toAdd.length);
      r.setValues([toAdd]);
      r.setFontWeight('bold').setBackground('#111').setFontColor('#fff');
    }
    const v  = s.getDataRange().getValues();
    const h  = v[0].map(String);
    let ri   = -1;
    for (let i = 1; i < v.length; i++) {
      if (fmtDateStr(v[i][0]) === p.date) { ri = i + 1; break; }
    }
    const ex  = ri > 0 ? v[ri - 1] : [];
    const row = h.map((k, i) => {
      if (k === 'date') return p.date;
      if (p[k] !== undefined && p[k] !== '') return p[k];
      return ex[i] !== undefined ? ex[i] : '';
    });
    if (ri > 0) s.getRange(ri, 1, 1, row.length).setValues([row]);
    else        s.appendRow(row);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function cleanSheet(ss) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const s = getSheet(ss);
    const v = s.getDataRange().getValues();
    if (v.length <= 1) return { ok: true, removed: 0 };
    const h = v[0].map(String);
    const merged = {};
    for (let i = 1; i < v.length; i++) {
      const dateStr = fmtDateStr(v[i][0]);
      if (!dateStr || dateStr.length < 10) continue;
      if (!merged[dateStr]) merged[dateStr] = h.map(k => k === 'date' ? dateStr : '');
      h.forEach((k, j) => {
        if (k === 'date') return;
        const cell = v[i][j];
        if (cell !== '' && cell !== null && cell !== undefined) merged[dateStr][j] = cell;
      });
    }
    const before = v.length - 1;
    const dates  = Object.keys(merged).sort();
    if (before > 0) s.getRange(2, 1, before, h.length).clearContent();
    dates.forEach((d, i) => s.getRange(i + 2, 1, 1, h.length).setValues([merged[d]]));
    return { ok: true, removed: before - dates.length };
  } finally { lock.releaseLock(); }
}

function handleChat(p) {
  const key = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!key) return { reply: 'Add CLAUDE_API_KEY to Script Properties to enable AI insights.' };
  const history  = p.history  ? JSON.parse(p.history) : [];
  const context  = p.context  || '';
  const question = p.question || '';
  const system =
    'You are a forward-focused personal coach. Your job is to point people toward where they\'re going, not where they\'ve been.\n\n' +
    'TONE RULES — follow these strictly:\n' +
    '- NEVER list or name habits that weren\'t completed. Unchecked habits do not exist in your reply.\n' +
    '- ALWAYS tell the person what TO DO next, not what they missed or didn\'t do.\n' +
    '- Frame everything as momentum and possibility, not gaps or shortfalls.\n' +
    '- If they\'ve written goals, connect their actions directly to those goals — show them the link.\n' +
    '- Lead with what\'s working or what\'s worth building on.\n\n' +
    'TIME AWARENESS:\n' +
    '- The data includes the current time. Morning/midday = day is still ahead. Never treat an unchecked morning habit as a failure.\n' +
    '- Morning tone: energise and set direction. Evening tone: acknowledge what was done and look ahead to tomorrow.\n\n' +
    'STYLE:\n' +
    '- Warm, direct, and specific. Reference things they actually did or wrote.\n' +
    '- 2–4 sentences unless asked for more. No bullet lists unless asked.\n' +
    '- NEVER end with a question. Not rhetorical, not literal. End with a statement or a clear directive.\n' +
    '- Do not invite further conversation. The insight should stand alone and feel complete.\n\n' +
    'Data:\n' + context;
  const initialPrompt = 'Given the time of day and my recent habit data, give me a brief personalised insight. If it\'s morning or early, focus on setting me up well for today. If it\'s evening, reflect on what I accomplished.';
  const msgs = [...history];
  msgs.push({ role: 'user', content: question || initialPrompt });
  try {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, system: system, messages: msgs })
    });
    const b = JSON.parse(res.getContentText());
    const reply = b.content?.[0]?.text || 'Keep going — you\'re building something great.';
    return { reply, messages: [...msgs, { role: 'assistant', content: reply }] };
  } catch(e) { return { reply: 'Could not load insight right now. Try again later.' }; }
}
