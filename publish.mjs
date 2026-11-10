// Usage:
//   bun publish.mjs publish <customer> <solution> <file.html> [--dry-run]
//   bun publish.mjs verify  <customer> <solution> <file.html> [--run <run id>]
//
// Publishes one self-contained HTML file to https://unf-vo-proto-<customer>-<solution>.b-cdn.net
// through v4's cd-vo-preview workflow. Each customer has one branch, proto/<customer>, that keeps every
// solution's page at apps/vo/frontend/prototypes/<solution>.html. A publish saves on top of that branch:
// main's latest code, every page already there, the new or updated page, and vo-frontend's build swapped
// for a plain copy of that page, so it goes up byte for byte and VO's app (and its vite config) never runs.
// Branches are never force-replaced, and a proto/ branch pm-publish didn't make is never touched. Nothing
// local is touched either: all git work happens through the GitHub API with the token `gh` already holds.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO = 'unframeai/v4';
const WORKFLOW = 'cd-vo-preview.yml';
const FRONTEND = 'apps/vo/frontend';
const PAGES = `${FRONTEND}/prototypes`;
const MAX_BYTES = 50 * 1024 * 1024;

// Every build script pm-publish has written starts this way, including the first one-page layout
// (cp prototype.html). A proto/ branch whose build doesn't is someone's own work.
const COPY_PREFIX = 'rm -rf dist && mkdir -p dist && cp prototype';
export const copyBuild = (solution) => `rm -rf dist && mkdir -p dist && cp prototypes/${solution}.html dist/index.html`;
// The workflow runs `turbo run build --filter=vo-frontend`, and v4's turbo.json builds every package vo-frontend
// depends on first (74 of them in October 2026). The copy needs none, so the branch tells turbo to skip them.
const SKIP_DEPENDENCY_BUILDS = { extends: ['//'], tasks: { build: { dependsOn: [] } } };
export const madeByPublish = (pkg) => typeof pkg?.scripts?.build === 'string' && pkg.scripts.build.startsWith(COPY_PREFIX);

// Single hyphens only, no leading or trailing hyphen: the workflow's sanitize() then leaves the
// names as they are, so the link we print is the link it creates. 14 + "proto-" fits its 20-char cut.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIMITS = { customer: 14, solution: 16 };

export class PublishError extends Error {}
// Not a failure: the build is still running when verify has to hand back. Running verify again picks up from there.
export class StillBuilding extends PublishError {}

export const branchFor = (customer) => `proto/${customer}`;
export const linkFor = (customer, solution) => `https://unf-vo-proto-${customer}-${solution}.b-cdn.net`;
// A customer name to suggest when proto/<customer> is someone else's: still within the 14-character limit.
export const otherName = (customer) => `${customer.slice(0, 11).replace(/-+$/, '')}-pm`;

// The new branch tree on top of main: the pages already on the branch, this solution's page (new or
// replacing its earlier version), the swapped package.json and the turbo setting that skips dependency builds.
export function treeEntries({ kept, solution, blobSha, pkg }) {
  return [
    ...kept.filter((f) => f.name !== `${solution}.html`).map((f) => ({ path: `${PAGES}/${f.name}`, mode: '100644', type: 'blob', sha: f.sha })),
    { path: `${PAGES}/${solution}.html`, mode: '100644', type: 'blob', sha: blobSha },
    { path: `${FRONTEND}/package.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(pkg, null, 4)}\n` },
    { path: `${FRONTEND}/turbo.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(SKIP_DEPENDENCY_BUILDS, null, 4)}\n` },
  ];
}

export function checkNames(customer, solution) {
  for (const [label, value] of [['customer', customer], ['solution', solution]]) {
    if (!value || value.length > LIMITS[label] || !NAME_RE.test(value)) {
      throw new PublishError(
        `The ${label} name must be 1-${LIMITS[label]} characters: lowercase letters, digits and single hyphens ` +
        `(for example ${label === 'customer' ? 'agco or health-intel' : 'rfq or claims-portal'}). Got: ${value ?? '(nothing)'}`
      );
    }
  }
}

// Based on unframe-design-system/scripts/check-standalone.mjs, with these differences for files built
// elsewhere: a <script src> pointing at a local file counts; links that load nothing (<a>, <base>, and
// <link> other than stylesheets and preloads) don't, since a dead nav link or favicon never blanks a page;
// addresses on the PM's own laptop (v4's dev server at localhost:5173, a local API) count, in code too.
const LAPTOP_HOST = /(?:localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::\d+)?(?![a-z0-9.-])/.source;
const LAPTOP_REF = new RegExp(`^(?:[a-z]+:)?//${LAPTOP_HOST}`, 'i');
const LAPTOP_IN_CODE = new RegExp(`\\b(?:https?|wss?)://${LAPTOP_HOST}[^\\s"'\`)<>\\\\]*`, 'gi');
export const isLaptop = (ref) => LAPTOP_REF.test(ref.trim());
const isLocal = (ref) => isLaptop(ref) || !/^(data:|https?:|\/\/|#|%23|mailto:|tel:|javascript:|blob:|about:)/i.test(ref.trim());
const cssUrls = (css) => [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((m) => m[1].trim());

export function localRefs(html) {
  const refs = [];
  // Only the page's own markup and styles count. Inlined code (React's error text, SVG strings) contains href="%s" and similar,
  // so script bodies go; the opening <script> tag stays so its src is still checked.
  const noScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => tag.replace(/>[\s\S]*<\/script>$/i, '></script>'));
  const styles = [...noScripts.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const markup = noScripts.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  for (const [tag, name] of markup.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const tagName = name.toLowerCase();
    if (tagName === 'a' || tagName === 'base') continue;
    if (tagName === 'link' && !/\srel=["']?[^"'>]*\b(?:stylesheet|preload|modulepreload)\b/i.test(tag)) continue;
    for (const [, ref] of tag.matchAll(/\s(?:src|href)=["']([^"']+)["']/gi)) if (isLocal(ref)) refs.push(ref);
    for (const [, , css] of tag.matchAll(/\sstyle=(["'])([\s\S]*?)\1/gi)) for (const ref of cssUrls(css)) if (isLocal(ref)) refs.push(ref);
  }
  for (const css of styles) for (const ref of cssUrls(css)) if (isLocal(ref)) refs.push(ref);
  // Inside code only laptop addresses count: a fetch() to a local API breaks the page as surely as a <script src>.
  for (const [, js] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) for (const [ref] of js.matchAll(LAPTOP_IN_CODE)) refs.push(ref);
  return [...new Set(refs)];
}

export function checkFile(file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) throw new PublishError(`Can't find the file: ${file ?? '(nothing)'}`);
  const name = basename(file);
  if (!['.html', '.htm'].includes(extname(file).toLowerCase())) {
    throw new PublishError(`${name} isn't an HTML file. pm-publish publishes one .html file.`);
  }
  const bytes = readFileSync(file);
  if (bytes.length === 0) throw new PublishError(`${name} is empty.`);
  if (bytes.length > MAX_BYTES) throw new PublishError(`${name} is ${mb(bytes.length)}; the limit is ${mb(MAX_BYTES)}.`);
  const html = bytes.toString('utf8');
  if (!/<html\b|<!doctype html|<body\b/i.test(html)) throw new PublishError(`${name} doesn't look like a web page (no <html> or <body> tag).`);
  const refs = localRefs(html);
  const files = refs.filter((ref) => !isLaptop(ref));
  const apps = refs.filter(isLaptop);
  if (refs.length) {
    throw new PublishError([
      files.length && `${name} points to files it doesn't carry inside it, so they'd be missing on the link:\n   ${files.join('\n   ')}`,
      apps.length && `${name} loads things from apps running on your laptop, so the link would break whenever they aren't running:\n   ${apps.join('\n   ')}`,
      `   Publish a single-file version instead. For a /proto prototype that's the packed prototypes/<customer>/<customer>.html.`,
    ].filter(Boolean).join('\n'));
  }
  return { name, bytes, sha256: sha256(bytes) };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TOKEN;
function token() {
  if (TOKEN) return TOKEN;
  try {
    TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    TOKEN = '';
  }
  if (!TOKEN) throw new PublishError('You are not logged in to GitHub. Run `gh auth login` (or /pm-setup-prototype), then try again.');
  return TOKEN;
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new PublishError(`GitHub said ${res.status} to ${method} ${path.split('?')[0]}: ${data?.message ?? text}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const unlessMissing = (e) => {
  if (e.status === 404) return null;
  throw e;
};

// What proto/<customer> holds now: nothing, a branch pm-publish made (with its pages), or someone's own work.
async function readBranch(branch) {
  const ref = await gh('GET', `repos/${REPO}/git/ref/heads/${branch}`).catch(unlessMissing);
  if (!ref) return null;
  const head = ref.object.sha;
  const pkgFile = await gh('GET', `repos/${REPO}/contents/${FRONTEND}/package.json?ref=${head}`).catch(unlessMissing);
  const pkg = pkgFile && JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf8'));
  if (!madeByPublish(pkg)) return { head, ours: false };
  const pages = (await gh('GET', `repos/${REPO}/contents/${PAGES}?ref=${head}`).catch(unlessMissing)) ?? [];
  return { head, ours: true, kept: pages.filter((f) => f.type === 'file' && f.name.endsWith('.html')).map(({ name, sha }) => ({ name, sha })) };
}

async function someoneElses(branch, customer, head) {
  const [last, diff] = await Promise.all([
    gh('GET', `repos/${REPO}/commits/${head}`),
    gh('GET', `repos/${REPO}/compare/main...${branch}`).catch(() => null),
  ]);
  const who = last.author?.login ?? last.commit.author.name;
  const commits = diff ? `${diff.ahead_by} commits, ` : '';
  return new PublishError(
    `${branch} already holds someone else's work (${who}: ${commits}last change ${last.commit.author.date.slice(0, 10)}), ` +
    `so pm-publish won't add to it or replace it.\n   Publish under another customer name, for example ${otherName(customer)}.`
  );
}

const pagesOn = (state, solution) => (state?.kept ?? []).map((f) => f.name.replace(/\.html$/, '')).filter((s) => s !== solution);

export async function publish({ customer, solution, file, dryRun = false, log = console.log }) {
  checkNames(customer, solution);
  const { name, bytes } = checkFile(file);
  log(`✓ Checked ${name} (${mb(bytes.length)}, self-contained)`);

  const repo = await gh('GET', `repos/${REPO}`).catch((e) => {
    if (e.status === 404) throw new PublishError(`Your GitHub account can't see ${REPO}. Ask Yael to add you to the unframeai org.`);
    throw e;
  });
  if (!repo.permissions?.push) throw new PublishError(`Your GitHub account can't push to ${REPO}. Ask Gal Charag for access.`);

  const mainSha = (await gh('GET', `repos/${REPO}/git/ref/heads/main`)).object.sha;
  const treeSha = (await gh('GET', `repos/${REPO}/git/commits/${mainSha}`)).tree.sha;
  const pkgFile = await gh('GET', `repos/${REPO}/contents/${FRONTEND}/package.json?ref=${mainSha}`);
  const pkg = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf8'));
  if (pkg.name !== 'vo-frontend' || !pkg.scripts?.build) {
    throw new PublishError(`${FRONTEND}/package.json on main no longer looks like vo-frontend, so publishing would break. Ask Gal Charag.`);
  }
  pkg.scripts.build = copyBuild(solution);

  const branch = branchFor(customer);
  const link = linkFor(customer, solution);
  let state = await readBranch(branch);
  if (state && !state.ours) throw await someoneElses(branch, customer, state.head);
  if (dryRun) {
    log(`✓ Dry run: would ${state ? 'save on top of' : 'create'} ${branch}: main (${mainSha.slice(0, 10)}) plus ${PAGES}/${solution}.html`);
    const others = pagesOn(state, solution);
    if (others.length) log(`  keeping the other pages on it: ${others.join(', ')}`);
    log(`  and set vo-frontend's build to: ${copyBuild(solution)}`);
    log(`  then run ${WORKFLOW} with branch=${branch} product=${solution}`);
    log(`\n  Link: ${link}`);
    return { link, branch, mainSha, dryRun: true };
  }

  const blob = await gh('POST', `repos/${REPO}/git/blobs`, { content: bytes.toString('base64'), encoding: 'base64' });
  let commit;
  for (let attempt = 1; ; attempt++) {
    const tree = await gh('POST', `repos/${REPO}/git/trees`, {
      base_tree: treeSha,
      tree: treeEntries({ kept: state?.kept ?? [], solution, blobSha: blob.sha, pkg }),
    });
    // Saved on top of the branch and of main, never instead of the branch: every earlier page and commit stays on it.
    commit = await gh('POST', `repos/${REPO}/git/commits`, {
      message: `prototype: ${customer}/${solution}`,
      tree: tree.sha,
      parents: state ? [state.head, mainSha] : [mainSha],
    });
    try {
      if (state) await gh('PATCH', `repos/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
      else await gh('POST', `repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      break;
    } catch (e) {
      // Someone published to this customer a moment ago, so the branch moved: start again from what they saved.
      if (e.status !== 422 || attempt === 3) throw e;
      state = await readBranch(branch);
      if (state && !state.ours) throw await someoneElses(branch, customer, state.head);
    }
  }
  const others = pagesOn(state, solution);
  log(`✓ Saved ${solution} to ${branch}${others.length ? `, next to ${others.join(', ')}` : ''} (commit ${commit.sha.slice(0, 10)})`);

  const me = (await gh('GET', 'user')).login;
  const dispatchedAt = Date.now();
  await gh('POST', `repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs: { branch, product: solution } });
  log('✓ Started the build');

  let run;
  for (let i = 0; i < 10 && !run; i++) {
    await sleep(3000);
    const { workflow_runs: runs } = await gh(
      'GET', `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&actor=${encodeURIComponent(me)}&per_page=5`
    );
    // 30s of slack for clock differences between this laptop and GitHub.
    run = runs.find((r) => new Date(r.created_at).getTime() >= dispatchedAt - 30_000);
  }

  log(`\n  Link:  ${link}   (usually ready in about 2 minutes)`);
  log(`  Build: ${run ? run.html_url : `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`}`);
  return { link, branch, commit: commit.sha, runId: run?.id ?? null, runUrl: run?.html_url ?? null };
}

// Both waits together stay under the 10 minutes a single command may run in Claude Code.
export async function verify({
  customer, solution, file, runId, log = console.log, maxBuildMs = 7 * 60_000, maxCdnMs = 2 * 60_000,
  fetchRun = (id) => gh('GET', `repos/${REPO}/actions/runs/${id}`), pause = sleep,
}) {
  checkNames(customer, solution);
  const { name, sha256: want } = checkFile(file);
  const link = linkFor(customer, solution);

  if (runId) {
    const started = Date.now();
    let run;
    for (;;) {
      run = await fetchRun(runId);
      if (run.status === 'completed') break;
      if (Date.now() - started >= maxBuildMs) {
        const minutes = Math.round((Date.now() - new Date(run.run_started_at ?? run.created_at).getTime()) / 60_000);
        throw new StillBuilding(`Still building (${minutes} minutes so far): ${run.html_url}. Run the check again.`);
      }
      await pause(10_000);
    }
    if (run.conclusion !== 'success') throw new PublishError(`The build ${run.conclusion}: ${run.html_url}. Send this link to Gal Charag.`);
    log('✓ Build finished');
  }

  // A new link can take a minute to start answering, and the CDN may briefly serve the previous version.
  const started = Date.now();
  let last = 'no answer yet';
  for (;;) {
    try {
      const res = await fetch(`${link}/`, { headers: { 'Cache-Control': 'no-cache' } });
      const body = Buffer.from(await res.arrayBuffer());
      if (res.ok && sha256(body) === want) {
        log(`✓ Checked the link: it shows exactly ${name}.`);
        return { link, ok: true };
      }
      last = res.ok ? 'it shows a different page' : `it answered ${res.status}`;
    } catch {
      last = "it doesn't answer yet";
    }
    if (Date.now() - started > maxCdnMs) throw new PublishError(`The link isn't showing ${name} yet (${last}): ${link}`);
    await sleep(10_000);
  }
}

function parseArgs(argv) {
  const [command, customer, solution, file, ...rest] = argv;
  const runAt = rest.indexOf('--run');
  return { command, customer, solution, file, dryRun: rest.includes('--dry-run'), runId: runAt >= 0 ? rest[runAt + 1] : null };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.command === 'publish') await publish(args);
    else if (args.command === 'verify') await verify(args);
    else {
      console.error('Usage: bun publish.mjs publish|verify <customer> <solution> <file.html> [--dry-run] [--run <id>]');
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof StillBuilding) {
      console.error(`⏳ ${e.message}`);
      process.exit(3);
    }
    console.error(`❌ ${e instanceof PublishError ? e.message : `Something unexpected went wrong: ${e.message}`}`);
    process.exit(1);
  }
}
