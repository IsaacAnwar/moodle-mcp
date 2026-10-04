#!/usr/bin/env node
// Moodle MCP server: read-only access to a student's Moodle (courses, materials, deadlines, grades, forums).
// No dependencies: speaks MCP (newline-delimited JSON-RPC over stdio) directly.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { readConfig, normalizeSiteUrl, CONFIG_PATH } = require('./config');

// Environment variables override ~/.moodle-mcp/config.json (written by setup.js).
const CONFIG = readConfig();
const SITE = normalizeSiteUrl(process.env.MOODLE_URL || CONFIG.url);
const SITE_HOST = SITE ? new URL(SITE).host : null;
const TOKEN = (process.env.MOODLE_TOKEN || CONFIG.token || '').trim() || null;
const TZ = process.env.MOODLE_TZ || CONFIG.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const CACHE_MS = 10 * 60 * 1000;
const NOT_SET_UP = `Moodle is not set up yet (no site URL or token in ${CONFIG_PATH}). Run the moodle-setup skill, or run "node setup.js" in a terminal.`;

// The visible Desktop can be redirected (e.g. to OneDrive\Desktop), so ask Windows where it is.
function desktopDir() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/Desktop\s+REG_\w+\s+(.+)/);
      if (m) {
        const p = m[1].trim().replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all);
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }
  return path.join(os.homedir(), 'Desktop');
}
const DESKTOP_DIR = desktopDir();
const DOWNLOAD_DIR = process.env.MOODLE_DOWNLOAD_DIR || CONFIG.download_dir || path.join(DESKTOP_DIR, 'Moodle Files');

// ---------- Moodle web service ----------

function flatten(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out);
    else out.append(key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return out;
}

async function ws(fn, args = {}) {
  if (!TOKEN || !SITE) throw new Error(NOT_SET_UP);
  const body = flatten({ wstoken: TOKEN, wsfunction: fn, moodlewsrestformat: 'json', ...args });
  const res = await fetch(`${SITE}/webservice/rest/server.php`, { method: 'POST', body });
  if (!res.ok) throw new Error(`Moodle returned HTTP ${res.status} for ${fn}`);
  const data = await res.json();
  if (data && data.exception) throw new Error(`Moodle error in ${fn}: ${data.message} (${data.errorcode})`);
  return data;
}

const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { value, expires: Date.now() + CACHE_MS });
  return value;
}

const siteInfo = () => cached('siteinfo', () => ws('core_webservice_get_site_info'));

async function getCourses() {
  return cached('courses', async () => {
    const { userid } = await siteInfo();
    const list = await ws('core_enrol_get_users_courses', { userid });
    return list.map((c) => ({ ...c, fullname: decode(c.fullname).trim(), shortname: decode(c.shortname).trim() }));
  });
}

const getContents = (courseid) => cached(`contents:${courseid}`, () => ws('core_course_get_contents', { courseid }));
const getAllAssignments = () => cached('assignments', async () => (await ws('mod_assign_get_assignments')).courses || []);

// A course is "current" if it hasn't ended (2-week grace) or, lacking an end date, started within ~10 months.
function isCurrent(c, now = Date.now() / 1000) {
  if (c.enddate) return c.enddate > now - 14 * 86400;
  return c.startdate > now - 300 * 86400;
}

async function resolveCourse(q, { required = false } = {}) {
  if (q === undefined || q === null || String(q).trim() === '') {
    if (required) throw new Error('A course is required (id or part of its name). Use list_courses to find it.');
    return null;
  }
  const courses = await getCourses();
  const s = String(q).trim();
  const exact = courses.find((c) => String(c.id) === s || c.shortname === s);
  if (exact) return exact;
  const n = norm(s);
  let matches = courses.filter((c) => norm(c.fullname).includes(n));
  const same = matches.find((c) => norm(c.fullname) === n);
  if (same) return same;
  if (matches.length > 1) {
    const current = matches.filter((c) => isCurrent(c));
    if (current.length) matches = current;
  }
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No enrolled course matches "${s}". Try list_courses with include_past=true.`);
  throw new Error(`"${s}" matches several courses: ${matches.map((c) => `${c.fullname} [id ${c.id}]`).join('; ')}. Pass the course id instead.`);
}

async function courseName(id) {
  const c = (await getCourses()).find((x) => x.id === id);
  return c ? c.fullname : `course ${id}`;
}

// ---------- Formatting helpers ----------

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿', euro: '€', pound: '£',
  copy: '©', reg: '®', deg: '°', times: '×', divide: '÷', ordf: 'ª', ordm: 'º', szlig: 'ß', shy: '',
};
// Accented letters (&aacute; &ntilde; &ccedil; ...) built from Unicode combining marks.
for (const [mark, comb] of Object.entries({ acute: '́', grave: '̀', circ: '̂', uml: '̈', tilde: '̃', cedil: '̧', ring: '̊' })) {
  for (const ch of 'aeiouyncAEIOUYNC') {
    const composed = (ch + comb).normalize('NFC');
    if (composed.length === 1) ENTITIES[ch + mark] = composed;
  }
}
function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  if (!html) return '';
  // Source whitespace is insignificant in HTML; line breaks come only from tags below.
  const s = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return !label || label === href ? href : `${label} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^[ |]+$/gm, '')
    .replace(/ *\| *$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}… [truncated]` : s);
const indent = (s, pad = '  ') => s.split('\n').map((l) => pad + l).join('\n');

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
const fmtDate = (ts) => (ts ? dateFmt.format(new Date(ts * 1000)) : 'none');
const fmtDay = (ts) => (ts ? dayFmt.format(new Date(ts * 1000)) : 'open');

function rel(ts) {
  const diff = ts - Date.now() / 1000;
  const a = Math.abs(diff);
  const v = a < 3600 ? `${Math.round(a / 60)} min` : a < 2 * 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return diff >= 0 ? `in ${v}` : `${v} ago`;
}

function fmtSize(b) {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100) || 'file';

function fmtModule(m, { descLimit = 600 } = {}) {
  // A label's "name" is just a truncated copy of its text, so show only the text.
  if (m.modname === 'label') {
    const text = htmlToText(m.description);
    return text ? `- Note [label, cmid ${m.id}]:\n${indent(clip(text, descLimit || 250), '  ')}` : '';
  }
  let head = `- ${decode(m.name).trim()} [${m.modname}, cmid ${m.id}]`;
  if (m.uservisible === false) head += ' (not available to you yet)';
  if (m.completiondata && m.completiondata.state > 0) head += ' (completed)';
  const lines = [head];
  for (const d of m.dates || []) lines.push(`  ${d.label} ${fmtDate(d.timestamp)}`);
  if (m.availabilityinfo) lines.push(`  Restriction: ${clip(htmlToText(m.availabilityinfo), 200)}`);
  if (descLimit && m.description) {
    const d = htmlToText(m.description);
    if (d && d !== decode(m.name).trim()) lines.push(indent(clip(d, descLimit), '  '));
  }
  for (const f of m.contents || []) {
    if (f.type === 'url') lines.push(`  link: ${f.fileurl}`);
    else if (f.type === 'file') {
      const p = f.filepath && f.filepath !== '/' ? f.filepath.replace(/^\//, '') : '';
      lines.push(`  file: ${p}${f.filename} (${fmtSize(f.filesize)}) ${f.fileurl}`);
    }
  }
  if (m.url && !['resource', 'folder', 'label'].includes(m.modname)) lines.push(`  view: ${m.url}`);
  return lines.join('\n');
}

const fileLines = (files, pad = '  ') => (files || []).map((f) => `${pad}file: ${f.filename} (${fmtSize(f.filesize)}) ${f.fileurl || f.url}`);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- Tools ----------

async function listCourses({ include_past = false }) {
  const courses = (await getCourses()).filter((c) => include_past || isCurrent(c)).sort((a, b) => b.startdate - a.startdate);
  const lines = courses.map((c) => {
    const dates = `${fmtDay(c.startdate)} to ${fmtDay(c.enddate)}`;
    const progress = typeof c.progress === 'number' ? `, ${Math.round(c.progress)}% complete` : '';
    return `- [id ${c.id}] ${c.fullname} (${dates}${progress})`;
  });
  const scope = include_past ? 'all enrolled courses' : 'current courses (use include_past=true for older ones)';
  return `${courses.length} ${scope}:\n${lines.join('\n')}`;
}

async function getCourseContents({ course, section }) {
  const c = await resolveCourse(course, { required: true });
  let sections = await getContents(c.id);
  if (section !== undefined && section !== null && String(section).trim() !== '') {
    const q = String(section).trim();
    sections = sections.filter((s) => String(s.section) === q || norm(s.name).includes(norm(q)));
    if (!sections.length) throw new Error(`No section matching "${q}" in ${c.fullname}.`);
  }
  const out = [`# ${c.fullname} [id ${c.id}]`];
  for (const s of sections) {
    const mods = (s.modules || []).filter((m) => m.modname !== 'label' || m.description);
    const summary = htmlToText(s.summary);
    if (!mods.length && !summary) continue;
    out.push('', `## ${decode(s.name)} (section ${s.section})`);
    if (summary) out.push(clip(summary, 800));
    for (const m of mods) out.push(fmtModule(m));
  }
  return out.join('\n');
}

async function searchMaterials({ query, course, include_past = false }) {
  const terms = norm(query).split(' ').filter(Boolean);
  if (!terms.length) throw new Error('query is required.');
  const courses = course ? [await resolveCourse(course)] : (await getCourses()).filter((c) => include_past || isCurrent(c));
  const hits = [];
  await mapLimit(courses, 4, async (c) => {
    let sections;
    try { sections = await getContents(c.id); } catch { return; }
    for (const s of sections) {
      for (const m of s.modules || []) {
        const hay = norm([s.name, decode(m.name), htmlToText(m.description), ...(m.contents || []).map((f) => f.filename)].join(' '));
        if (terms.every((t) => hay.includes(t))) hits.push({ c, s, m });
      }
    }
  });
  if (!hits.length) return `No materials match "${query}" in ${courses.length} course(s).`;
  const shown = hits.slice(0, 40);
  const out = [`${hits.length} match(es) for "${query}"${hits.length > shown.length ? ' (showing 40)' : ''}:`];
  for (const { c, s, m } of shown) out.push('', `${c.fullname} > ${decode(s.name)}`, fmtModule(m, { descLimit: 250 }));
  return out.join('\n');
}

// Downloads a pluginfile URL with the token. The token is only ever sent to the Moodle site itself.
async function fetchFile(url) {
  if (!TOKEN || !SITE) throw new Error(NOT_SET_UP);
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('url must be a full Moodle file URL.'); }
  if (u.host !== SITE_HOST) throw new Error(`Only files on ${SITE_HOST} can be fetched (this link points to ${u.host}; open it directly instead).`);
  if (!u.pathname.includes('/webservice/pluginfile.php/')) {
    if (!u.pathname.includes('/pluginfile.php/')) throw new Error('Not a Moodle file URL (expected .../pluginfile.php/...). Use the other tools for activity pages.');
    u.pathname = u.pathname.replace('/pluginfile.php/', '/webservice/pluginfile.php/');
  }
  u.searchParams.delete('token');
  u.searchParams.delete('forcedownload');
  const shown = u.toString();
  u.searchParams.set('token', TOKEN);

  const res = await fetch(u);
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}: ${shown}`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (type.includes('json')) {
    let j = null;
    try { j = JSON.parse(buf.toString('utf8')); } catch {}
    if (j && (j.error || j.exception)) throw new Error(`Moodle refused the file: ${j.error || j.message}`);
  }
  return { buf, type, filename: safeName(decodeURIComponent(u.pathname.split('/').pop() || 'file')) };
}

const resolveFolder = (folder) => (path.isAbsolute(folder) ? folder : path.join(DESKTOP_DIR, folder));

async function downloadCourseFiles({ course, folder, layout = 'sections', dry_run = false }) {
  const c = await resolveCourse(course, { required: true });
  const root = folder ? resolveFolder(String(folder)) : path.join(DOWNLOAD_DIR, safeName(c.fullname));
  const flat = layout === 'flat';
  const jobs = [];
  const locked = [];
  const links = [];
  const pages = [];

  for (const s of await getContents(c.id)) {
    const sub = flat ? '' : safeName(`${String(s.section).padStart(2, '0')} ${decode(s.name)}`);
    for (const m of s.modules || []) {
      if (m.modname === 'label') continue;
      if (m.uservisible === false) {
        locked.push(`${decode(m.name).trim()} (${htmlToText(m.availabilityinfo) || 'not available yet'})`);
        continue;
      }
      if (m.modname === 'page') { pages.push(decode(m.name).trim()); continue; }
      for (const f of m.contents || []) {
        if (f.type === 'url') links.push(`${decode(m.name).trim()}: ${f.fileurl}`);
        if (f.type !== 'file') continue;
        const inner = flat ? [] : (f.filepath || '/').split('/').filter(Boolean).map(safeName);
        jobs.push({ url: f.fileurl, size: f.filesize, dest: path.join(root, sub, ...inner, safeName(f.filename)) });
      }
    }
  }
  const ac = (await getAllAssignments()).find((x) => x.id === c.id);
  for (const a of ac?.assignments || []) {
    for (const f of a.introattachments || []) {
      jobs.push({ url: f.fileurl, size: f.filesize, dest: path.join(root, flat ? '' : 'Assignment files', safeName(f.filename)) });
    }
  }

  // Same file listed twice: download once. Different files sharing a name (flat layout): number them.
  const byDest = new Map();
  for (const j of jobs) {
    let dest = j.dest;
    for (let n = 2; byDest.has(dest.toLowerCase()) && byDest.get(dest.toLowerCase()).size !== j.size; n++) {
      const ext = path.extname(j.dest);
      dest = `${j.dest.slice(0, j.dest.length - ext.length)} (${n})${ext}`;
    }
    if (!byDest.has(dest.toLowerCase())) byDest.set(dest.toLowerCase(), { ...j, dest });
  }
  const unique = [...byDest.values()];

  const result = { added: [], updated: [], current: [], failed: [] };
  await mapLimit(unique, 4, async (j) => {
    const rel = path.relative(root, j.dest);
    let existing = null;
    try { existing = fs.statSync(j.dest); } catch {}
    if (existing && existing.size === j.size) return result.current.push(rel);
    const bucket = existing ? result.updated : result.added;
    if (dry_run) return bucket.push(rel);
    try {
      const { buf } = await fetchFile(j.url);
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      fs.writeFileSync(j.dest, buf);
      bucket.push(rel);
    } catch (e) {
      result.failed.push(`${rel}: ${e.message}`);
    }
  });

  const verb = dry_run ? 'Would download' : 'Downloaded';
  const list = (items, max = 60) => [...items.sort().slice(0, max).map((x) => `  - ${x}`), ...(items.length > max ? [`  ... and ${items.length - max} more`] : [])];
  const out = [
    `${dry_run ? 'DRY RUN, nothing was written. ' : ''}${c.fullname}`,
    `Folder: ${root}`,
    `${unique.length} files on Moodle: ${result.added.length} new, ${result.updated.length} changed on Moodle, ${result.current.length} already up to date${result.failed.length ? `, ${result.failed.length} FAILED` : ''}.`,
  ];
  if (result.added.length) out.push('', `${verb} (new):`, ...list(result.added));
  if (result.updated.length) out.push('', `${verb} (newer version replaces local copy):`, ...list(result.updated));
  if (result.failed.length) out.push('', 'Failed:', ...list(result.failed));
  if (locked.length) out.push('', 'Locked until the teacher releases them (run again later):', ...list(locked));
  if (links.length) out.push('', 'External links (not files, not downloaded):', ...list(links, 20));
  if (pages.length) out.push('', `${pages.length} Moodle page(s) are text, not files; read them with get_course_contents/get_file.`);
  return out.join('\n');
}

async function getFile({ url, course }) {
  const { buf, type, filename } = await fetchFile(url);

  if (/^text\/(html|plain|csv|markdown)|json|xml/.test(type)) {
    const text = type.includes('html') ? htmlToText(buf.toString('utf8')) : buf.toString('utf8');
    return `${filename} (${type.split(';')[0]}):\n\n${clip(text, 80000)}`;
  }

  let dir = DOWNLOAD_DIR;
  if (course) {
    try { dir = path.join(DOWNLOAD_DIR, safeName((await resolveCourse(course)).fullname)); } catch {}
  }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, buf);
  return `Saved ${filename} (${fmtSize(buf.length)}, ${type.split(';')[0] || 'unknown type'}) to:\n${dest}\n\n` +
    'Open it with your file-reading tool (PDFs and images can be read directly; use a document skill for .docx/.pptx/.xlsx).';
}

async function getDeadlines({ days = 30, course, include_overdue = false }) {
  const now = Math.floor(Date.now() / 1000);
  const from = include_overdue ? now - 30 * 86400 : now;
  const to = now + Number(days) * 86400;
  const c = await resolveCourse(course);
  const range = { timesortfrom: from, timesortto: to, limitnum: 50 };
  const [actions, calendar] = await Promise.all([
    c ? ws('core_calendar_get_action_events_by_course', { courseid: c.id, ...range }) : ws('core_calendar_get_action_events_by_timesort', range),
    ws('core_calendar_get_calendar_events', {
      events: c ? { courseids: [c.id] } : {},
      options: { userevents: 1, siteevents: 1, timestart: from, timeend: to },
    }).catch(() => ({ events: [] })),
  ]);

  const items = new Map();
  for (const e of actions.events || []) items.set(e.id, { ...e, todo: true });
  for (const e of calendar.events || []) {
    if (items.has(e.id)) continue;
    // Calendar events for activities you've already completed aren't to-dos; keep only non-activity events here.
    if (e.modulename && e.eventtype === 'due') continue;
    items.set(e.id, { ...e, timesort: e.timestart, todo: false });
  }
  const list = [...items.values()].filter((e) => e.timesort >= from && e.timesort <= to).sort((a, b) => a.timesort - b.timesort);
  if (!list.length) return `Nothing due in the next ${days} days${c ? ` for ${c.fullname}` : ''}.`;

  const out = [`${list.length} item(s), next ${days} days${include_overdue ? ' plus last 30 days overdue' : ''} (times in ${TZ}):`];
  for (const e of list) {
    const cname = e.course ? decode(e.course.fullname).trim() :e.courseid ? await courseName(e.courseid) : 'Personal/site';
    const flag = e.overdue ? ' OVERDUE' : '';
    out.push(`- ${fmtDate(e.timesort)} (${rel(e.timesort)})${flag}: ${decode(e.name)}`);
    out.push(`  ${cname}${e.modulename ? ` · ${e.modulename}` : ''}${e.todo ? ' · to do' : ' · event'}${e.url ? ` · ${e.url}` : ''}`);
  }
  return out.join('\n');
}

async function getAssignments({ course, include_past = false }) {
  const c = await resolveCourse(course);
  const now = Date.now() / 1000;
  const all = await getAllAssignments();
  const courses = await getCourses();
  const out = [];
  for (const ac of all) {
    if (c ? ac.id !== c.id : !isCurrent(courses.find((x) => x.id === ac.id) || { startdate: 0 })) continue;
    const list = ac.assignments.filter((a) => include_past || !a.duedate || a.duedate > now - 7 * 86400).sort((a, b) => (a.duedate || Infinity) - (b.duedate || Infinity));
    if (!list.length) continue;
    out.push('', `## ${decode(ac.fullname)} [id ${ac.id}]`);
    for (const a of list) {
      out.push(`- ${decode(a.name)} [assignment ${a.id}, cmid ${a.cmid}]`);
      out.push(`  Due: ${fmtDate(a.duedate)}${a.duedate ? ` (${rel(a.duedate)})` : ''}${a.cutoffdate ? ` · cut-off ${fmtDate(a.cutoffdate)}` : ''}${a.grade > 0 ? ` · graded out of ${a.grade}` : ''}`);
      const intro = htmlToText(a.intro);
      if (intro) out.push(indent(clip(intro, 500)));
      out.push(...fileLines(a.introattachments));
    }
  }
  if (!out.length) return `No ${include_past ? '' : 'upcoming or recent '}assignments found${c ? ` in ${c.fullname}` : ''}.`;
  return `Assignments (times in ${TZ}; use get_assignment_details for full instructions, submission status and feedback):${out.join('\n')}`;
}

async function getAssignmentDetails({ assignment_id }) {
  const id = Number(assignment_id);
  let found;
  for (const ac of await getAllAssignments()) {
    const a = ac.assignments.find((x) => x.id === id || x.cmid === id);
    if (a) { found = { a, ac }; break; }
  }
  if (!found) throw new Error(`No assignment with id or cmid ${assignment_id}. Use get_assignments to find it.`);
  const { a, ac } = found;
  const out = [
    `# ${decode(a.name)} [assignment ${a.id}, cmid ${a.cmid}]`,
    `Course: ${decode(ac.fullname)}`,
    `Opens: ${fmtDate(a.allowsubmissionsfromdate)} · Due: ${fmtDate(a.duedate)}${a.duedate ? ` (${rel(a.duedate)})` : ''} · Cut-off: ${fmtDate(a.cutoffdate)}`,
    a.grade > 0 ? `Graded out of ${a.grade}` : null,
    '', '## Instructions', htmlToText(a.intro) || '(none)',
  ].filter((x) => x !== null);
  if (a.activity) out.push('', htmlToText(a.activity));
  if (a.introattachments?.length) out.push('', '## Attached files', ...fileLines(a.introattachments, ''));

  try {
    const st = await ws('mod_assign_get_submission_status', { assignid: a.id });
    const sub = st.lastattempt?.submission || st.lastattempt?.teamsubmission;
    out.push('', '## Your submission');
    out.push(`Status: ${sub ? sub.status : 'no submission'}${st.lastattempt?.gradingstatus ? ` · grading: ${st.lastattempt.gradingstatus}` : ''}`);
    if (sub?.timemodified) out.push(`Last modified: ${fmtDate(sub.timemodified)}`);
    for (const p of sub?.plugins || []) {
      for (const fa of p.fileareas || []) out.push(...fileLines(fa.files, ''));
      for (const ef of p.editorfields || []) if (ef.text) out.push(`${ef.description || 'Online text'}:`, clip(htmlToText(ef.text), 3000));
    }
    const fb = st.feedback;
    if (fb) {
      out.push('', '## Feedback', `Grade: ${htmlToText(fb.gradefordisplay) || '-'}${fb.gradeddate ? ` (graded ${fmtDate(fb.gradeddate)})` : ''}`);
      for (const p of fb.plugins || []) {
        for (const ef of p.editorfields || []) if (ef.text) out.push(htmlToText(ef.text));
        for (const fa of p.fileareas || []) out.push(...fileLines(fa.files, ''));
      }
    }
  } catch (e) {
    out.push('', `(Submission status unavailable: ${e.message})`);
  }
  return out.join('\n');
}

async function getGrades({ course, include_past = false }) {
  const c = await resolveCourse(course);
  const { userid } = await siteInfo();
  if (!c) {
    const { grades = [] } = await ws('gradereport_overview_get_course_grades', { userid });
    const courses = await getCourses();
    const rows = grades
      .map((g) => ({ g, c: courses.find((x) => x.id === g.courseid) }))
      .filter(({ g, c: cc }) => include_past || !cc || isCurrent(cc) || (g.grade && g.grade !== '-'));
    const lines = rows.map(({ g, c: cc }) => `- ${cc ? cc.fullname : `course ${g.courseid}`} [id ${g.courseid}]: ${g.grade || '-'}${g.rank ? ` (rank ${g.rank})` : ''}`);
    return `Course totals (pass a course for the item-by-item breakdown):\n${lines.join('\n')}`;
  }
  const res = await ws('gradereport_user_get_grade_items', { courseid: c.id, userid });
  const items = res.usergrades?.[0]?.gradeitems || [];
  if (!items.length) return `No grade items in ${c.fullname}.`;
  const out = [`# Grades: ${c.fullname}`];
  for (const it of items) {
    const name = it.itemtype === 'course' ? 'COURSE TOTAL' : it.itemtype === 'category' ? `Category total: ${decode(it.itemname) || 'overall'}` : decode(it.itemname);
    const [grade, range, pct, weight] = [it.gradeformatted, it.rangeformatted, it.percentageformatted, it.weightformatted].map((v) => htmlToText(v));
    const bits = [grade || '-'];
    if (range) bits.push(`range ${range}`);
    if (pct && pct !== '-') bits.push(pct);
    if (weight && weight !== '-') bits.push(`weight ${weight}`);
    out.push(`- ${name}: ${bits.join(' · ')}`);
    const fb = htmlToText(it.feedback);
    if (fb) out.push(indent(`Feedback: ${clip(fb, 1500)}`));
  }
  return out.join('\n');
}

async function getForumDiscussions({ course, forum_id, limit = 10 }) {
  const c = await resolveCourse(course, { required: true });
  let forums = await ws('mod_forum_get_forums_by_courses', { courseids: [c.id] });
  if (forum_id) forums = forums.filter((f) => f.id === Number(forum_id) || f.cmid === Number(forum_id));
  if (!forums.length) return `No forums found in ${c.fullname}.`;
  forums.sort((a, b) => (b.type === 'news') - (a.type === 'news'));
  const out = [`# Forums in ${c.fullname}`];
  let empty = 0;
  for (const f of forums) {
    const { discussions = [] } = await ws('mod_forum_get_forum_discussions', { forumid: f.id, sortorder: -1, page: 0, perpage: Number(limit) });
    if (!discussions.length) { empty++; continue; }
    out.push('', `## ${decode(f.name)}${f.type === 'news' ? ' (announcements)' : ''} [forum ${f.id}]`);
    for (const d of discussions) {
      out.push(`- ${decode(d.name || d.subject)} [discussion ${d.discussion}] by ${d.userfullname}, ${fmtDate(d.created)}${d.numreplies ? ` · ${d.numreplies} replies` : ''}`);
      const msg = htmlToText(d.message);
      if (msg) out.push(indent(clip(msg, 700)));
      out.push(...fileLines(d.attachments));
    }
  }
  if (empty) out.push('', `(${empty} other forum(s) have no discussions.)`);
  return out.join('\n');
}

async function getDiscussion({ discussion_id }) {
  const { posts = [] } = await ws('mod_forum_get_discussion_posts', { discussionid: Number(discussion_id), sortby: 'created', sortdirection: 'ASC' });
  if (!posts.length) return 'No posts found in that discussion.';
  const out = [];
  for (const p of posts) {
    out.push(`### ${decode(p.subject)}`, `${p.author?.fullname || 'Unknown'} · ${fmtDate(p.timecreated)}${p.parentid ? ` · reply to post ${p.parentid}` : ''}`);
    out.push(htmlToText(p.message) || '(empty)');
    out.push(...fileLines(p.attachments, ''), '');
  }
  return out.join('\n').trim();
}

async function getNotifications({ limit = 20, unread_only = false }) {
  const { userid } = await siteInfo();
  const { notifications = [] } = await ws('message_popup_get_popup_notifications', { useridto: userid, newestfirst: 1, limit: Number(limit), offset: 0 });
  const list = notifications.filter((n) => !unread_only || !n.read);
  if (!list.length) return unread_only ? 'No unread notifications.' : 'No notifications.';
  return list.map((n) => {
    const body = htmlToText(n.smallmessage || n.fullmessage || '');
    return `- ${fmtDate(n.timecreated)}${n.read ? '' : ' (unread)'}: ${decode(n.subject)}` +
      (body && body !== decode(n.subject) ? `\n${indent(clip(body, 400))}` : '') +
      (n.contexturl ? `\n  ${n.contexturl}` : '');
  }).join('\n');
}

const COURSE_ARG = { type: 'string', description: 'Course id, or part of the course name (e.g. "Corporate Finance").' };

const TOOLS = [
  {
    name: 'list_courses',
    description: 'List the student\'s enrolled Moodle courses with ids, dates and progress. Defaults to current courses.',
    inputSchema: { type: 'object', properties: { include_past: { type: 'boolean', description: 'Include finished/older courses.' } } },
    handler: listCourses,
  },
  {
    name: 'get_course_contents',
    description: 'Show a course\'s sections and activities: slides, readings, files (with download URLs), links, pages, quizzes, assignments and their descriptions.',
    inputSchema: {
      type: 'object',
      properties: { course: COURSE_ARG, section: { type: 'string', description: 'Optional section number or part of its name to narrow the output.' } },
      required: ['course'],
    },
    handler: getCourseContents,
  },
  {
    name: 'search_materials',
    description: 'Search activity names, descriptions and file names across courses (current ones by default). All words must match; accents and case are ignored.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, course: COURSE_ARG, include_past: { type: 'boolean', description: 'Also search past courses.' } },
      required: ['query'],
    },
    handler: searchMaterials,
  },
  {
    name: 'get_file',
    description: 'Fetch a Moodle file by its URL (from get_course_contents, assignments or forums). HTML/text is returned inline; other files (PDF, PPTX, DOCX, XLSX, images) are saved locally and the path is returned so you can open them.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A pluginfile.php URL on the Moodle site.' }, course: { ...COURSE_ARG, description: 'Optional: course id or name, used to file the download into a per-course folder.' } },
      required: ['url'],
    },
    handler: getFile,
  },
  {
    name: 'download_course_files',
    description: 'Download every file in a course (slides, readings, templates, solutions, assignment attachments) to a folder on the Desktop. ' +
      'Only fetches files that are new or changed since last time, so it is safe to re-run. Reports locked items and external links it could not download.',
    inputSchema: {
      type: 'object',
      properties: {
        course: COURSE_ARG,
        folder: { type: 'string', description: 'Target folder: a name on the Desktop (e.g. "Y3CorporateFinance") or an absolute path. Default: Desktop\\Moodle Files\\<course name>.' },
        layout: { type: 'string', enum: ['sections', 'flat'], description: '"sections" (default) makes a subfolder per course section; "flat" puts all files in one folder.' },
        dry_run: { type: 'boolean', description: 'Only report what would be downloaded.' },
      },
      required: ['course'],
    },
    handler: downloadCourseFiles,
  },
  {
    name: 'get_deadlines',
    description: 'Upcoming deadlines and to-dos (assignments, quizzes, etc. not yet completed) plus other calendar events, soonest first.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to look (default 30).' },
        course: COURSE_ARG,
        include_overdue: { type: 'boolean', description: 'Also include items from the last 30 days that are still incomplete.' },
      },
    },
    handler: getDeadlines,
  },
  {
    name: 'get_assignments',
    description: 'List assignments with due dates, short instructions and attached files. Defaults to current courses and assignments due from a week ago onward.',
    inputSchema: { type: 'object', properties: { course: COURSE_ARG, include_past: { type: 'boolean', description: 'Include assignments whose due date passed more than a week ago.' } } },
    handler: getAssignments,
  },
  {
    name: 'get_assignment_details',
    description: 'Full instructions, attachments, the student\'s submission status, grade and teacher feedback for one assignment.',
    inputSchema: { type: 'object', properties: { assignment_id: { type: 'number', description: 'Assignment id or cmid (from get_assignments or get_course_contents).' } }, required: ['assignment_id'] },
    handler: getAssignmentDetails,
  },
  {
    name: 'get_grades',
    description: 'Without a course: course totals across courses. With a course: every grade item with range, percentage, weight and feedback.',
    inputSchema: { type: 'object', properties: { course: COURSE_ARG, include_past: { type: 'boolean', description: 'Overview only: include past courses without a grade.' } } },
    handler: getGrades,
  },
  {
    name: 'get_forum_discussions',
    description: 'Announcements and forum discussions for a course (newest first), including the opening message of each.',
    inputSchema: {
      type: 'object',
      properties: { course: COURSE_ARG, forum_id: { type: 'number', description: 'Optional forum id or cmid to limit to one forum.' }, limit: { type: 'number', description: 'Discussions per forum (default 10).' } },
      required: ['course'],
    },
    handler: getForumDiscussions,
  },
  {
    name: 'get_discussion',
    description: 'All posts in one forum discussion thread.',
    inputSchema: { type: 'object', properties: { discussion_id: { type: 'number' } }, required: ['discussion_id'] },
    handler: getDiscussion,
  },
  {
    name: 'get_notifications',
    description: 'Recent Moodle notifications (new grades, announcements, submissions, reminders).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Default 20.' }, unread_only: { type: 'boolean' } } },
    handler: getNotifications,
  },
];

// ---------- MCP over stdio ----------

const INSTRUCTIONS = `Read-only access to the student's Moodle${SITE ? ` (${SITE})` : ''}. Times are shown in ${TZ}. ` +
  'Tools taking `course` accept a course id or part of its name. Typical flow: list_courses, then get_course_contents and get_file for materials; ' +
  'get_deadlines for what is due; get_assignment_details for instructions and feedback; get_grades for marks.';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'moodle', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ handler, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return reply(id, { content: [{ type: 'text', text: await tool.handler(params.arguments || {}) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
  }
}

// `node server.js --check` verifies the setup without starting the MCP server.
async function check() {
  if (!TOKEN || !SITE) { console.error(NOT_SET_UP); process.exitCode = 1; return; }
  try {
    const info = await siteInfo();
    const courses = await getCourses();
    console.log(`OK: connected to ${decode(info.sitename)} (${SITE}) as ${info.fullname}; ${courses.filter((c) => isCurrent(c)).length} current of ${courses.length} enrolled courses.`);
    console.log(`Downloads go to: ${DOWNLOAD_DIR}`);
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv.includes('--check')) {
  check();
} else {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return replyError(null, -32700, 'Parse error'); }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m).catch((e) => console.error('[moodle-mcp]', e));
  });
  if (!TOKEN || !SITE) console.error(`[moodle-mcp] ${NOT_SET_UP}`);
}
