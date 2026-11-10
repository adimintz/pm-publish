# pm-publish

A Claude Code skill that turns one HTML prototype into a link a PM can present on a call, for example `https://unf-vo-proto-agco-rfq.b-cdn.net`. Every link opens on a sign-in page first.

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com) logged in (`gh auth login`), with push access to `unframeai/v4`
- An account in VO's Supabase project to sign in to published links (ask Adi Azarya)

There are no packages to install: the scripts use only Bun's built-ins.

## Install

Link the repo into Claude Code's skills folder, so a `git pull` updates the skill:

```bash
ln -s "$(pwd)" ~/.claude/skills/pm-publish
```

Or install a packed copy (see [Packing a .skill file](#packing-a-skill-file)):

```bash
unzip pm-publish.skill -d ~/.claude/skills/
```

Start a new Claude Code session after installing.

## Use

In Claude Code:

```
/pm-publish <customer> <solution>
```

Then give it the HTML file. Claude follows [SKILL.md](SKILL.md): it publishes, waits for the build and checks the link.

The script also runs on its own:

```bash
bun publish.mjs publish <customer> <solution> <file.html> [--dry-run]
bun publish.mjs verify  <customer> <solution> <file.html> [--run <run id>]
```

- **Customer:** 1-14 characters. **Solution:** 1-16 characters. Lowercase letters, digits and single hyphens.
- The file must be one self-contained page: no files next to it, nothing loaded from `localhost`. Pages from other sites (a CDN, an API) are fine.
- Publishing again with the same customer and solution replaces that link's page.

## How it works

1. `publish.mjs` checks the file, then wraps it in the sign-in page from `login.mjs`.
2. Through the GitHub API, it commits the wrapped page to `apps/vo/frontend/prototypes/<solution>.html` on the branch `proto/<customer>` in `unframeai/v4`, creating the branch from `main` if needed. On that branch, vo-frontend's build script only copies the page to `dist/index.html`, so the VO app itself is never built.
3. It starts v4's `cd-vo-preview` workflow with `branch=proto/<customer>` and `product=<solution>`. The workflow uploads `dist` to the BunnyCDN zone `unf-vo-proto-<customer>-<solution>`.
4. `verify` waits for the build, then checks that the link serves exactly the wrapped page.

Nothing on the laptop changes, and branches are never force-pushed. A `proto/` branch that pm-publish didn't create is never touched.

### The sign-in page

The prototype rides inside the sign-in page as base64. The page checks the email and password against VO's Supabase project and, once they're accepted, replaces itself with the prototype and adds a floating Sign out button. The session stays in the browser's `localStorage`, so a refresh doesn't ask again. Each link is its own site, so signing in to one doesn't sign in to another.

## Files

| File | What it is |
|---|---|
| `SKILL.md` | The instructions Claude follows, including what to tell the PM when something fails |
| `publish.mjs` | `publish` and `verify` |
| `login.mjs` | The sign-in page template |
| `publish.test.mjs` | Tests |

## Tests

```bash
bun test
```

## Known limits

- **The content isn't secret.** The sign-in keeps visitors out, but the prototype is still readable in the page source.
- **Shared accounts.** Anyone with an account in VO's Supabase project can sign in to every link, and that project allows sign-ups.
- **Links can't be deleted from here.** Nothing removes a BunnyCDN zone; ask whoever runs the Bunny account. Publishing a blank page over a link is the only way to empty it yourself.
- **Close publishes can collide.** Two publishes for the same customer within about a minute can give one link the other's page. Publishing again fixes it.

## Packing a .skill file

```bash
mkdir -p /tmp/pack/pm-publish && git archive HEAD | tar -x -C /tmp/pack/pm-publish
(cd /tmp/pack && zip -r -X pm-publish.skill pm-publish)
```

Don't commit the `.skill` file; build it from the source when you need to share it.

## History

Based on the pm-publish skill by Gal Charag, which publishes through the `cd-vo-preview` workflow by Adi Azarya. This repo adds the sign-in page.
