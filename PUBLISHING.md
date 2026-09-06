# Publishing Link Position History

This repository is prepared for an initial Obsidian Community Plugin release.

## Before the first public release

### 1. Confirm the author metadata

The plugin is configured to publish under:

```json
"author": "XCZA"
```

The MIT license also lists `XCZA` as the copyright holder.

If you want an author website, add an `authorUrl` field to `manifest.json`.

### 2. Confirm the identity

Current plugin identity:

- Name: `Link Position History`
- ID: `link-position-history`
- Initial version: `0.1.0`
- Minimum Obsidian version: `1.13.7`

The plugin ID becomes difficult to change after publication, so confirm it before submitting.

### 3. Install dependencies and build

```bash
npm install
npm run build
```

This creates `main.js`.

Commit the generated `package-lock.json` after your first `npm install` so future builds are reproducible. Do not commit `main.js`.

### 4. Test manually

Copy these files into a development vault at:

```text
.obsidian/plugins/link-position-history/
```

Files:

```text
main.js
manifest.json
```

Test at minimum:

- Reading View internal links.
- Source/Live Preview Ctrl/Cmd-click internal links.
- Cross-note Back and Forward.
- Same-note heading/block jumps where applicable.
- Native Back/Forward toolbar behavior.
- Custom plugin Back/Forward commands.
- Mobile if you intend to advertise mobile support.
- Disabling and re-enabling the plugin without duplicate handlers.

### 5. Commit and push the source repository

The source repository should contain `manifest.json`, `README.md`, `LICENSE`, `versions.json`, the TypeScript source, and build configuration.

### 6. Create the initial Git tag

The Git tag must exactly match the version in `manifest.json` and must not include a `v` prefix:

```bash
git tag 0.1.0
git push origin 0.1.0
```

The included release workflow builds the plugin and creates a draft GitHub release containing `main.js` and `manifest.json`.

Review the draft release, add release notes if desired, and publish it.

### 7. Submit to the Obsidian Community directory

Sign in to the Obsidian Community directory, connect the GitHub account that owns the repository, and add the plugin for review.

The repository default branch must contain the same accurate `manifest.json`, and a GitHub release matching its version must already exist.

## Subsequent releases

1. If necessary, update `minAppVersion` in `manifest.json`.
2. Run one of:

```bash
npm version patch
npm version minor
npm version major
```

The version hook updates `manifest.json` and `versions.json`.
3. Review and commit the version changes.
4. Push the commit and the generated version tag.
5. Review and publish the draft GitHub release created by the workflow.
