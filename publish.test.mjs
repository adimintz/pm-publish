// Run: bun test ~/.claude/skills/pm-publish
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkNames, checkFile, checkUsers, savedUsers, localRefs, linkFor, branchFor, copyBuild, madeByPublish, otherName, treeEntries, verify, PublishError, StillBuilding } from './publish.mjs';
import { lockedPage, readLocked, unlock } from './login.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pm-publish-'));
// Saved users go to a scratch file, never the real ~/.pm-publish.
process.env.PM_PUBLISH_CREDENTIALS = join(dir, 'credentials.json');
writeFileSync(process.env.PM_PUBLISH_CREDENTIALS, JSON.stringify({ 'agco/rfq': [{ username: 'pm', password: 'correct horse battery' }] }));
const file = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

test('names: customer up to 14, solution up to 16, single hyphens only', () => {
  expect(() => checkNames('agco', 'rfq')).not.toThrow();
  expect(() => checkNames('abcdefghijklmn', 'abcdefghijklmnop')).not.toThrow();
  for (const [c, s] of [['abcdefghijklmno', 'rfq'], ['agco', 'abcdefghijklmnopq'], ['Agco', 'rfq'], ['ag--co', 'rfq'],
    ['-agco', 'rfq'], ['agco-', 'rfq'], ['agco', undefined], ['agco', 'claims_portal']]) {
    expect(() => checkNames(c, s)).toThrow(PublishError);
  }
});

test('branch and link', () => {
  expect(branchFor('agco')).toBe('proto/agco');
  expect(linkFor('health-intel', 'rfq')).toBe('https://unf-vo-proto-health-intel-rfq.b-cdn.net');
});

test('branch owner: only builds pm-publish wrote count as ours', () => {
  expect(madeByPublish({ scripts: { build: copyBuild('rfq') } })).toBe(true);
  expect(madeByPublish({ scripts: { build: 'rm -rf dist && mkdir -p dist && cp prototype.html dist/index.html' } })).toBe(true);
  expect(madeByPublish({ scripts: { build: 'vite build' } })).toBe(false);
  expect(madeByPublish(null)).toBe(false);
  expect(copyBuild('voice-agent')).toBe('rm -rf dist && mkdir -p dist && cp prototypes/voice-agent.html dist/index.html');
});

test('another customer name to suggest fits the name rules', () => {
  expect(otherName('ball')).toBe('ball-pm');
  for (const c of ['ball', 'abcdefghijklmn', 'abcdefghij-xy', 'health-intel']) expect(() => checkNames(otherName(c), 'rfq')).not.toThrow();
});

test('new branch tree keeps the other pages and replaces only this one', () => {
  const kept = [{ name: 'chat.html', sha: 'a1' }, { name: 'voice-agent.html', sha: 'b1' }];
  const entries = treeEntries({ kept, solution: 'voice-agent', blobSha: 'b2', pkg: { name: 'vo-frontend' } });
  expect(entries.map((e) => [e.path, e.sha ?? 'content'])).toEqual([
    ['apps/vo/frontend/prototypes/chat.html', 'a1'],
    ['apps/vo/frontend/prototypes/voice-agent.html', 'b2'],
    ['apps/vo/frontend/package.json', 'content'],
    ['apps/vo/frontend/turbo.json', 'content'],
  ]);
  expect(JSON.parse(entries[3].content)).toEqual({ extends: ['//'], tasks: { build: { dependsOn: [] } } });
});

test('a slow build hands back as still building, not as a failure', async () => {
  const page = file('slow.html', '<!doctype html><html><body>hi</body></html>');
  const run = { status: 'in_progress', html_url: 'https://github.com/unframeai/v4/actions/runs/1', run_started_at: new Date(Date.now() - 8 * 60_000).toISOString() };
  const attempt = verify({ customer: 'agco', solution: 'rfq', file: page, runId: '1', maxBuildMs: 0, fetchRun: async () => run, pause: async () => {}, log: () => {} });
  await expect(attempt).rejects.toBeInstanceOf(StillBuilding);
  await expect(attempt).rejects.toThrow(/Still building \(8 minutes so far\).*Run the check again/);
});

test('local references: files the page loads count, links and remote files do not', () => {
  const html = `<!doctype html><html><head>
    <link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="https://cdn.example/a.css">
    <link rel="stylesheet" href="styles.css"><script src="app.js"></script>
    <script src="https://cdnjs.cloudflare.com/x.js"></script>
    <script>el.innerHTML = '<img src="inside-code.png"><a href="%s">';</script>
    <style>.a{background:url('assets/logo.png')} .b{background:url(data:image/png;base64,AA)} .c{fill:url(#g)}</style>
  </head><body><a href="details.html">x</a><img src="./hero.jpg"><div style="background:url(bg.jpg)"></div>
  <iframe src="chart.html"></iframe><svg><use href="#i"/></svg></body></html>`;
  expect(localRefs(html).sort()).toEqual(['./hero.jpg', 'app.js', 'assets/logo.png', 'bg.jpg', 'chart.html', 'styles.css']);
});

test('laptop addresses: v4 or an API running locally counts, in tags and in code', () => {
  const html = `<!doctype html><html><head><script type="module" src="http://localhost:5173/src/main.ts"></script>
    <link rel="stylesheet" href="//127.0.0.1:8080/app.css"></head><body><iframe src="http://localhost:5173/mocks/rfq"></iframe>
    <script>fetch('http://localhost:8000/api/loans'); new WebSocket('ws://[::1]:24678'); go('https://localhost.example.com/x');</script>
    <a href="http://localhost:3000">nav</a><img src="https://cdn.example/localhost.png"></body></html>`;
  expect(localRefs(html).sort()).toEqual(['//127.0.0.1:8080/app.css', 'http://localhost:5173/mocks/rfq',
    'http://localhost:5173/src/main.ts', 'http://localhost:8000/api/loans', 'ws://[::1]:24678']);
});

test('the locked page opens to the exact file for each user, and only for them', async () => {
  const html = '<!doctype html><html><head><title>Proto</title></head><body><p>Secret plan ✓</p><script>x("</script>")</script></body></html>';
  const users = [{ username: 'admin@unframe.ai', password: 'first-password-1' }, { username: 'gal', password: 'second-password-2' }];
  const page = await lockedPage({ html, users });
  expect(page).toContain('<title>Sign in</title>');
  for (const secret of ['Secret plan', 'Proto', 'admin@unframe.ai', 'gal', 'first-password-1', 'second-password-2', Buffer.from(html).toString('base64').slice(0, 24)]) {
    expect(page).not.toContain(secret);
  }
  expect(readLocked(page).locks).toHaveLength(2);
  expect(await unlock({ page, username: 'admin@unframe.ai', password: 'first-password-1' })).toBe(html);
  // Usernames match regardless of case and surrounding spaces; passwords match exactly.
  expect(await unlock({ page, username: ' GAL ', password: 'second-password-2' })).toBe(html);
  expect(await unlock({ page, username: 'gal', password: 'first-password-1' })).toBeNull();
  expect(await unlock({ page, username: 'admin@unframe.ai', password: 'First-password-1' })).toBeNull();
  // The locked page passes the same checks the PM's file does.
  expect(localRefs(page)).toEqual([]);
});

test('users: at least one, unique names, passwords of 12+ characters', () => {
  expect(checkUsers([{ username: ' Admin@Unframe.ai ', password: 'twelve-chars' }])).toEqual([{ username: 'admin@unframe.ai', password: 'twelve-chars' }]);
  expect(() => checkUsers([])).toThrow(/at least one user/);
  expect(() => checkUsers(undefined)).toThrow(/at least one user/);
  expect(() => checkUsers([{ username: '', password: 'twelve-chars' }])).toThrow(/username/);
  expect(() => checkUsers([{ username: 'pm', password: 'short' }])).toThrow(/at least 12 characters/);
  expect(() => checkUsers([{ username: 'pm', password: 'twelve-chars' }, { username: 'PM', password: 'other-twelve' }])).toThrow(/twice/);
});

test('saved users are read per customer and solution', () => {
  expect(savedUsers('agco', 'rfq').map((u) => u.username)).toEqual(['pm']);
  expect(savedUsers('agco', 'portal')).toEqual([]);
});

test('verify needs a saved user to open the link', async () => {
  const page = file('nouser.html', '<!doctype html><html><body>hi</body></html>');
  await expect(verify({ customer: 'agco', solution: 'portal', file: page, log: () => {} })).rejects.toThrow(/no saved user/);
});

test('file checks', () => {
  expect(checkFile(file('ok.html', '<!doctype html><html><body><img src="data:image/png;base64,AA"></body></html>')).name).toBe('ok.html');
  expect(() => checkFile(join(dir, 'missing.html'))).toThrow(/Can't find/);
  expect(() => checkFile(file('notes.txt', 'hi'))).toThrow(/isn't an HTML file/);
  expect(() => checkFile(file('empty.html', ''))).toThrow(/is empty/);
  expect(() => checkFile(file('fake.html', 'just text'))).toThrow(/doesn't look like a web page/);
  expect(() => checkFile(file('bad.html', '<html><body><img src="logo.png"></body></html>'))).toThrow(/logo\.png/);
  expect(() => checkFile(file('v4.html', '<html><body><iframe src="http://localhost:5173/mocks/rfq"></iframe></body></html>')))
    .toThrow(/apps running on your laptop[\s\S]*localhost:5173\/mocks\/rfq/);
  expect(() => checkFile(file('both.html', '<html><body><img src="logo.png"><script>fetch("http://127.0.0.1:8000/a")</script></body></html>')))
    .toThrow(/files it doesn't carry[\s\S]*logo\.png[\s\S]*apps running on your laptop[\s\S]*127\.0\.0\.1:8000/);
});
