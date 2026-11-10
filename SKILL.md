---
name: pm-publish
description: "Turns a prototype into a link. Give it one HTML file, built with /proto or anywhere else, plus a customer and a solution name, and you get a link like https://unf-vo-proto-agco-rfq.b-cdn.net. Use when the user says \"publish this\", \"publish my prototype\", \"get me a link for this prototype\", \"I need a link to present\", \"deploy preview\", names a customer and a solution after \"publish\" (for example \"publish agco rfq\"), or types /pm-publish. Claude Code only; publishes HTML files, not Vue mocks.\n"
---

# /pm-publish: publish a prototype as a link

You publish one HTML file as a link. The PM presents it by sharing their screen on a call; customers never open it themselves.

`$SKILL_DIR` is the absolute path of the folder that contains this `SKILL.md`. Substitute it in every command below.

## 1. Get the two names

The arguments are the customer, then the solution, for example `/pm-publish agco rfq`.

- **Customer:** 1-14 characters. **Solution:** 1-16 characters. Both use lowercase letters, digits and single hyphens.
- Lowercase the names and turn spaces into hyphens, for example Saint Maclou becomes saint-maclou.
- If one is missing, ask for it. If the PM used the old one-name form (`/pm-publish agco`), ask for the solution and say: "Links now carry the customer and the solution, for example unf-vo-proto-agco-rfq."

## 2. Get the HTML file

- If the PM named or attached a file, or you built it in this session, use that.
- Otherwise ask: "Which HTML file should I publish? You can drag it into this window."
- Use the full path. A dragged-in path can arrive with quotes or with backslashes before spaces; remove them.

The file must be one self-contained page. A `/proto` prototype is already packed into one: `prototypes/<customer>/<customer>.html` in the design-system folder.

## 3. Publish

```bash
bun "$SKILL_DIR/publish.mjs" publish <customer> <solution> "<full path to the file>"
```

Show the PM the output as it is. On the happy path that's three ✓ lines, the link and the build link. If it prints ❌, show that line, use the table below and stop.

## 4. Check the link

Say: "The link is usually ready in about 2 minutes. I'm checking that it shows your file."

Run this with a 10-minute timeout. `<run id>` is the number at the end of the build link:

```bash
bun "$SKILL_DIR/publish.mjs" verify <customer> <solution> "<full path to the file>" --run <run id>
```

If the build link is the workflow page rather than a single run, leave out `--run <run id>`.

- ✓ → tell the PM the link is ready to present.
- ⏳ → the build is slow, not broken. Tell the PM "GitHub is slow right now, still checking," and run the same command again, up to two more times. If it still says ⏳, give the PM the build link and say the link will show the new version once the build finishes.
- ❌ → show the line and use the table below.

## When something fails

| The ❌ line says | Tell the PM |
|---|---|
| The customer (or solution) name must be... | Pick a name that fits, for example `health-intel` or `claims-portal` |
| Can't find the file / isn't an HTML file / doesn't look like a web page | Ask for the right file |
| ...points to files it doesn't carry inside it | The page needs files that sit next to it on the laptop. For `/proto`, publish the packed file. From another tool, export a single-file version, or offer to put those files inside the page. Only edit the file if the PM says yes. |
| ...loads things from apps running on your laptop | The page uses v4 (or another app) running on the laptop, and the link would break whenever it isn't running. Rebuild it as one page with `/proto`, or export a single-file version from the tool that made it. |
| ...already holds someone else's work | That branch is a colleague's own work. Ask the PM for another customer name; the message suggests one. Don't work around it. |
| You are not logged in to GitHub | Run `gh auth login`, or `/pm-setup-prototype` |
| Your GitHub account can't see / can't push | Follow the message: Yael for org access, Gal Charag for push access |
| ...package.json on main no longer looks like vo-frontend | v4 changed. Ask Gal Charag; don't work around it. |
| The build failed (or was cancelled) | Send the build link to Gal Charag |
| The link isn't showing ... yet | Wait a minute and open the link. If it's still wrong, send both links to Gal Charag. |
| GitHub said... / Something unexpected went wrong | Show it as it is and ask Gal Charag |

## Hard rules

- **Only through `publish.mjs`.** Don't run git, don't push and don't change any local v4 folder. Don't touch `main` or the workflow.
- **HTML files only.** If asked to publish a Vue mock: "pm-publish publishes HTML files now. Rebuild the mock with /proto, or export it as one HTML file."
- **Don't edit the PM's file** to get past a check unless they ask.
- **Don't create a new workflow file.** `cd-vo-preview` already covers every customer and solution.
- **Present, don't send.** Describe the link as something to present on a call, never as something to send to a customer.

## How it works

- `cd-vo-preview` builds a v4 branch and uploads `apps/vo/frontend/dist` to a BunnyCDN zone named `unf-vo-<branch>-<product>`, cutting each part to 20 characters. Branch `proto/agco` and product `rfq` give `unf-vo-proto-agco-rfq`.
- Each customer has one branch, `proto/<customer>`, that keeps every solution's page in a subfolder: `apps/vo/frontend/prototypes/<solution>.html`.
- `publish.mjs` saves on top of that branch: `main`'s latest code, every page already there, the new or updated page, and vo-frontend's build swapped for a copy of that page into `dist/index.html`. The page goes up byte for byte. VO's app is never built, so its blank-page bug doesn't apply.
- The branch also carries `apps/vo/frontend/turbo.json`, which tells the build to skip v4's other packages. A publish takes about 1.5 minutes, most of it v4's install step, which GitHub sometimes runs much slower.
- It never force-replaces a branch, so earlier pages and commits stay on it. A `proto/` branch it didn't make (a colleague's own work) is never touched.
- Everything goes through the GitHub API with the PM's `gh` login; nothing on the laptop changes.
- Each link keeps what it got when it was published, so `agco rfq` and `agco portal` don't affect each other.
- **Known limit:** two publishes for the same customer within about a minute could give one link the other's page. Publishing again fixes it.
- Tests: `bun test "$SKILL_DIR"`.

$ARGUMENTS
