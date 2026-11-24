# pm-publish

A Claude Code skill that turns one HTML prototype into a link a PM can present on a call, for example `https://unf-vo-proto-agco-rfq.b-cdn.net`. The prototype is encrypted: every link opens on a sign-in page, and only the users the PM creates while publishing can open it.

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com) logged in (`gh auth login`), with push access to `unframeai/v4`

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

Then give it the HTML file. Claude follows [SKILL.md](SKILL.md): it asks you to create the users who can open the link, publishes, waits for the build and signs in to the link to check it. For each user you pick **Use the default user** (`prototype@unframe.ai`, shared by every link that uses it), **Generate a random user** (a random `@unframe.ai` username and a strong password, shown once so you can save them) or **Choose my own**. From the second user on there's also **Finish and publish**.

The script also runs on its own. New users go on stdin as JSON, so passwords stay off the command line:

```bash
bun publish.mjs publish <customer> <solution> <file.html> --users-stdin <<'USERS'
[{"username": "viewer-k3m9xq@unframe.ai", "password": "at-least-12-characters"}]
USERS
bun publish.mjs new-user                                       # print a random user as JSON
bun publish.mjs publish <customer> <solution> <file.html>   # republish for the users saved last time
bun publish.mjs verify  <customer> <solution> <file.html> [--run <run id>]
bun publish.mjs users   <customer> <solution>                # list the saved usernames
```

- **Customer:** 1-14 characters. **Solution:** 1-16 characters. Lowercase letters, digits and single hyphens.
- The file must be one self-contained page: no files next to it, nothing loaded from `localhost`. Pages from other sites (a CDN, an API) are fine.
- Publishing again with the same customer and solution replaces that link's page.
- Passwords must be at least 12 characters. Usernames ignore case.

## How it works

1. `publish.mjs` checks the file, then encrypts it inside the locked page from `login.mjs`, for the users you created.
2. Through the GitHub API, it commits the wrapped page to `apps/vo/frontend/prototypes/<solution>.html` on the branch `proto/<customer>` in `unframeai/v4`, creating the branch from `main` if needed. On that branch, vo-frontend's build script only copies the page to `dist/index.html`, so the VO app itself is never built.
3. It starts v4's `cd-vo-preview` workflow with `branch=proto/<customer>` and `product=<solution>`. The workflow uploads `dist` to the BunnyCDN zone `unf-vo-proto-<customer>-<solution>`.
4. `verify` waits for the build, then signs in to the live link as the first saved user and checks it opens to exactly your file.

Nothing on the laptop changes, and branches are never force-pushed. A `proto/` branch that pm-publish didn't create is never touched.

### The locked page

- The prototype is encrypted with a random 256-bit key (AES-GCM).
- Each user's username and password are stretched with PBKDF2-SHA256 (600,000 rounds) into a key that locks its own copy of the content key.
- The page holds only ciphertext: no usernames, no passwords, nothing readable.
- On sign-in the browser opens it with WebCrypto, replaces the page with the prototype and adds a floating Sign out button. It keeps the key in `localStorage` so a refresh doesn't ask again; Sign out forgets it.
- Each link is its own site, so signing in to one doesn't sign in to another.

Users are saved on the publishing laptop in `~/.pm-publish/credentials.json` (mode 600), per customer and solution, so a republish can keep them and `verify` can sign in.

## Files

| File | What it is |
|---|---|
| `SKILL.md` | The instructions Claude follows, including what to tell the PM when something fails |
| `publish.mjs` | `publish` and `verify` |
| `login.mjs` | The locked page: encryption, and the browser code that signs in and opens it |
| `publish.test.mjs` | Tests |

## Tests

```bash
bun test
```

## Known limits

- **Only as strong as the passwords.** Anyone with the link can download the page and try passwords offline, hence the 12-character minimum.
- **Changing users means republishing.** Someone who saved an older page keeps access to that old version with its old password.
- **Users live on one laptop.** Publishing the same link from another laptop needs the users again; `verify` there can't sign in until it has.
- **Links can't be deleted from here.** Nothing removes a BunnyCDN zone; ask whoever runs the Bunny account. Publishing a blank page over a link is the only way to empty it yourself.
- **Close publishes can collide.** Two publishes for the same customer within about a minute can give one link the other's page. Publishing again fixes it.

## Packing a .skill file

```bash
mkdir -p /tmp/pack/pm-publish && git archive HEAD | tar -x -C /tmp/pack/pm-publish
(cd /tmp/pack && zip -r -X pm-publish.skill pm-publish)
```

Don't commit the `.skill` file; build it from the source when you need to share it.

## History

Based on the pm-publish skill by Gal Charag, which publishes through the `cd-vo-preview` workflow by Adi Azarya. This repo adds the encrypted, sign-in-only page.
