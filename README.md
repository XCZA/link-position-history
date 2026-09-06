# Link Position History

**Link Position History** makes Obsidian's Back and Forward navigation remember where you actually were when you followed an internal link.

Instead of returning only to the previous note, the plugin records the source note and its scroll position and, when possible, the exact link element that initiated navigation. Going Back can therefore return you to the place you left rather than merely reopening the file.

## Features

- Position-aware Back and Forward history for internal links.
- Restores the source note and scroll position.
- Attempts to return the original clicked link to the same on-screen offset when the original element is still available.
- Works in Reading View and Source/Live Preview.
- Supports normal internal-link clicks in Reading View.
- Supports Ctrl-click on Windows/Linux and Cmd-click on macOS for editor links.
- Detects common wiki links such as `[[Note]]` and `[[Note#Heading|Alias]]` in the editor.
- Detects standard Markdown links such as `[label](Note.md)`.
- Integrates with Obsidian's native Back and Forward commands and toolbar controls when custom history is available.
- Falls back to Obsidian's normal navigation when the custom stack is empty.
- Includes dedicated **Go back to previous link position** and **Go forward to next link position** commands.
- Mobile-compatible, including toolbar handling and a small Reading View double-tap selection improvement.
- Keeps navigation history in memory only; it does not transmit or persist vault content.

## Why this exists

Following densely connected notes can make it easy to lose your place. Obsidian's normal history is primarily page-oriented, while Link Position History treats the source position as part of navigation history.

A typical flow becomes:

1. Scroll deep into a long note.
2. Follow an internal link.
3. Read another note.
4. Use Back.
5. Return to the source note near the link you originally followed.

## Installation

### Community Plugins

The repository is structured for submission to the Obsidian Community directory, but it is not available there until the initial release has been published and reviewed.

### Manual installation

1. Download `main.js` and `manifest.json` from a GitHub release.
2. Create this folder inside your vault:

   ```text
   .obsidian/plugins/link-position-history/
   ```

3. Put `main.js` and `manifest.json` in that folder.
4. Reload Obsidian.
5. Open **Settings > Community plugins** and enable **Link Position History**.

## Usage

### Reading View

Follow internal links normally. The plugin records the source position before navigation.

Use Obsidian's normal Back and Forward controls. When Link Position History has a custom history entry available, it uses that entry first. When it does not, Obsidian's native history is left alone.

### Source and Live Preview

Follow internal editor links the same way you normally do in Obsidian:

- Windows/Linux: **Ctrl-click**
- macOS: **Cmd-click**

The plugin also recognizes internal links that are represented as CodeMirror editor text instead of normal HTML anchor elements.

### Commands

The plugin adds:

- **Link Position History: Go back to previous link position**
- **Link Position History: Go forward to next link position**

No default hotkeys are assigned. You can configure them under **Settings > Hotkeys**.

## How restoration works

A history entry can contain:

- the source note path;
- Obsidian's view scroll value when available;
- scroll positions of relevant DOM containers;
- the original link element when available;
- the link's vertical offset inside its scroll container.

When restoring an entry, the plugin first tries the most precise available method and then falls back to Obsidian's scroll API and direct scroll-container restoration.

## Compatibility

- Minimum Obsidian version: **1.13.7**.
- Desktop: supported.
- Mobile: supported.

The plugin uses a few undocumented Obsidian internals and DOM selectors as best-effort fallbacks because the public API does not expose all state required for this behavior. Obsidian updates may occasionally require compatibility fixes.

## Privacy

Link Position History:

- makes no network requests;
- includes no analytics or telemetry;
- does not send vault content anywhere;
- keeps its custom history in memory for the current session.

## Known limitations

- Exact element restoration is best-effort. After a cross-note navigation, the original DOM element may have been destroyed, in which case scroll-state restoration is used instead.
- Editor link detection covers common wiki links and standard Markdown links but is not a complete Markdown parser.
- Custom history is not persisted across Obsidian restarts.
- Toolbar integration depends partly on Obsidian's internal markup and history methods and may need adjustment after major UI changes.

## Development

Requirements:

- Node.js 18 or newer.
- npm.
- A separate Obsidian development vault. Do not develop plugins against a vault containing important data.

Install dependencies:

```bash
npm install
```

Start a development build:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

The build outputs `main.js` in the repository root. `main.js` is intentionally ignored by Git because Obsidian recommends publishing compiled output as a release asset rather than committing it to the source repository.

## Releasing

See [`PUBLISHING.md`](./PUBLISHING.md) for the initial publication checklist and subsequent release process.

## Contributing

Bug reports and pull requests are welcome. For navigation bugs, please include:

- Obsidian version;
- operating system or mobile platform;
- Reading View or Source/Live Preview;
- the link syntax involved;
- exact steps to reproduce;
- whether Back, Forward, or both are affected.

## License

MIT. See [`LICENSE`](./LICENSE).
