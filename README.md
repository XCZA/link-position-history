# Link Position History

**Link Position History** improves Obsidian’s Back and Forward navigation by remembering **where you were when you followed an internal link**.

Instead of only returning to the previous note, it also restores your scroll position and, when possible, the original link location.

## Features

- Position-aware Back and Forward navigation
- Restores note and scroll position
- Tracks the internal link you followed
- Supports Reading View and Live Preview / Source View
- Integrates with Obsidian’s native Back/Forward controls
- Works on desktop and mobile
- Falls back to Obsidian’s native history when needed
- Keeps navigation history in memory for the current session

## Mobile Quality-of-Life

On mobile, the plugin also prevents accidental **tap-to-edit behavior while viewing a note in preview/reading mode**, making it much easier to select, highlight, and copy text without being dropped into the editor.

It also improves double-tap text selection for a smoother reading experience.

## Why Use It?

For heavily linked or long notes, Back should take you **back to where you actually left off**.

**Follow a link → press Back → return to your previous position.**

Especially useful for large vaults, research notes, documentation, and mobile reading.

## Privacy

The plugin runs entirely inside Obsidian and does not include analytics, telemetry, tracking, or external network requests.

# Manual installation

1. Download `main.js` and `manifest.json` from a GitHub release.
2. Create this folder inside your vault:

   ```text
   .obsidian/plugins/link-position-history/
   ```

3. Put `main.js` and `manifest.json` in that folder.
4. Reload Obsidian.
5. Open **Settings > Community plugins** and enable **Link Position History**.
