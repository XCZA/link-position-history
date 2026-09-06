const { Plugin } = require('obsidian');


/**
 * Link Position History
 *
 * Position-aware Back/Forward navigation for internal links.
 * This intentionally uses a small number of Obsidian internals and DOM
 * selectors as best-effort fallbacks because core navigation does not expose
 * all of the state needed for precise source-position restoration.
 */
module.exports = class LinkPositionHistoryPlugin extends Plugin {
	onload() {
		const app = this.app;
		// Avoid duplicate listeners if the plugin is reloaded unexpectedly.
		if (typeof window.__linkPositionHistoryCleanup === 'function') {
			window.__linkPositionHistoryCleanup();
		}

		const cleanups = [];
		const backStack = [];
		const forwardStack = [];
		const MAX_STACK = 100;
		const forcedToolbarStates = new WeakMap();
		let refreshQueued = false;
		let isRestoringCustomHistory = false;
		let suppressNextFileOpenPushUntil = 0;
		let lastToolbarHandledAt = 0;
		let lastRecordedActivation = null;
		let lastKnownState = null;
		let lastKnownPath = null;
		let snapshotQueued = false;

		// ---------------------------------------------------------------------
		// Mobile reader-mode double-tap fix
		// ---------------------------------------------------------------------
		let lastTap = 0;

		function onPointerDownDoubleTapFix(e) {
			const isReader = e.target.closest?.('.markdown-reading-view');
			if (!isReader || e.pointerType !== 'touch') return;

			Object.defineProperty(e, 'pointerType', { get: () => 'mouse', configurable: true });

			const now = Date.now();
			if (now - lastTap < 300) {
				const sel = window.getSelection();
				const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
				if (sel && range) {
					sel.removeAllRanges();
					sel.addRange(range);
					sel.modify('move', 'backward', 'word');
					sel.modify('extend', 'forward', 'word');
				}
			}
			lastTap = now;
		}

		window.addEventListener('pointerdown', onPointerDownDoubleTapFix, { capture: true });
		cleanups.push(() => window.removeEventListener('pointerdown', onPointerDownDoubleTapFix, true));

		// ---------------------------------------------------------------------
		// Unified link-position history
		//
		// Normal Back/Forward toolbar taps use this custom stack first.
		// If the custom stack is empty, Obsidian's native navigation runs normally.
		// ---------------------------------------------------------------------
		function getActiveMarkdownView() {
			const view = app.workspace.activeLeaf?.view;
			if (!view || view.getViewType?.() !== 'markdown' || !view.file) return null;
			return view;
		}

		function getActivePath() {
			return getActiveMarkdownView()?.file?.path ?? app.workspace.getActiveFile?.()?.path ?? null;
		}

		const SCROLL_SELECTORS = [
			'.markdown-preview-view',
			'.markdown-reading-view',
			'.markdown-source-view .cm-scroller',
			'.cm-scroller',
			'.view-content'
		];

		function uniqueElements(elements) {
			const seen = new Set();
			return elements.filter((el) => {
				if (!el || seen.has(el)) return false;
				seen.add(el);
				return true;
			});
		}

		function isScrollable(el) {
			if (!el || el === document || el === window) return false;
			try {
				return el.scrollHeight > el.clientHeight + 2;
			} catch (_) {
				return false;
			}
		}

		function getScrollCandidates(view = getActiveMarkdownView()) {
			const root = view?.containerEl ?? view?.contentEl ?? document;
			const candidates = [];

			for (const selector of SCROLL_SELECTORS) {
				for (const el of Array.from(root.querySelectorAll?.(selector) ?? [])) {
					candidates.push(el);
				}
			}

			if (document.scrollingElement) candidates.push(document.scrollingElement);
			return uniqueElements(candidates);
		}

		function getScrollElement(view = getActiveMarkdownView()) {
			const candidates = getScrollCandidates(view);
			const scrollables = candidates.filter(isScrollable);

			const active = scrollables.find((el) => Math.abs(el.scrollTop ?? 0) > 1);
			return active ?? scrollables[0] ?? candidates[0] ?? null;
		}

		function getNearestScrollableAncestor(el) {
			let node = el?.parentElement;
			while (node && node !== document.body && node !== document.documentElement) {
				if (isScrollable(node)) return node;
				node = node.parentElement;
			}
			return document.scrollingElement ?? null;
		}

		function getScrollerTop(scroller) {
			if (!scroller) return 0;
			if (scroller === document.scrollingElement || scroller === document.body || scroller === document.documentElement) return 0;
			try {
				return scroller.getBoundingClientRect().top;
			} catch (_) {
				return 0;
			}
		}

		function getElementOffsetInsideScroller(el, scroller) {
			try {
				return el.getBoundingClientRect().top - getScrollerTop(scroller);
			} catch (_) {
				return null;
			}
		}

		function getScrollState(view = getActiveMarkdownView(), sourceEl = null) {
			if (!view?.file) return null;

			let apiScroll = null;
			try {
				const scroll = view.currentMode?.getScroll?.();
				if (typeof scroll === 'number' && Number.isFinite(scroll)) apiScroll = scroll;
			} catch (_) {
				// Some internal view modes may throw while being swapped/re-rendered.
			}

			const candidates = getScrollCandidates(view);
			const scroller = getScrollElement(view);
			const sourceScroller = sourceEl ? getNearestScrollableAncestor(sourceEl) : null;

			return {
				path: view.file.path,
				basename: view.file.basename,
				apiScroll,
				scrollTop: scroller?.scrollTop ?? 0,
				scrollTops: candidates.map((el, index) => ({ index, scrollTop: el?.scrollTop ?? 0 })),
				sourceEl,
				sourceScroller,
				sourceOffsetTop: sourceEl && sourceScroller ? getElementOffsetInsideScroller(sourceEl, sourceScroller) : null,
				time: Date.now()
			};
		}

		function stateLooksSamePlace(a, b) {
			if (!a || !b || a.path !== b.path) return false;

			const apiSame =
				typeof a.apiScroll === 'number' &&
				typeof b.apiScroll === 'number' &&
				Math.abs(a.apiScroll - b.apiScroll) < 0.001;

			const topSame = Math.abs((a.scrollTop ?? 0) - (b.scrollTop ?? 0)) < 4;
			const sameSource = a.sourceEl && b.sourceEl && a.sourceEl === b.sourceEl;

			return !!sameSource || (apiSame && topSame);
		}

		function pushStack(stack, state, options = {}) {
			if (!state?.path) return false;
			const previous = stack[stack.length - 1];
			if (!options.force && stateLooksSamePlace(previous, state)) return false;

			stack.push(state);
			if (stack.length > MAX_STACK) stack.shift();
			queueRefreshToolbarButtons();
			return true;
		}

		function clearForwardStack() {
			if (forwardStack.length) {
				forwardStack.length = 0;
				queueRefreshToolbarButtons();
			}
		}

		function updateSnapshotNow() {
			const state = getScrollState();
			if (state?.path) {
				lastKnownState = state;
				lastKnownPath = state.path;
			}
		}

		function queueSnapshot() {
			if (snapshotQueued) return;
			snapshotQueued = true;
			requestAnimationFrame(() => {
				snapshotQueued = false;
				updateSnapshotNow();
			});
		}

		function getLinkElement(link) {
			return link?.element ?? link ?? null;
		}

		function getLinkText(link) {
			const el = getLinkElement(link);
			return (
				link?.target ||
				el?.getAttribute?.('data-href') ||
				el?.getAttribute?.('href') ||
				''
			).trim();
		}

		function cleanMarkdownDestination(raw) {
			let value = (raw ?? '').trim();
			if (!value) return '';

			// Markdown permits angle brackets around destinations containing spaces.
			if (value.startsWith('<')) {
				const closing = value.indexOf('>');
				if (closing > 0) return value.slice(1, closing).trim();
			}

			// Strip an optional Markdown title: (target "title") or (target 'title').
			// This deliberately handles the common Obsidian cases without pretending to
			// be a complete Markdown parser.
			const titleMatch = value.match(/^(.*?)(?:\s+["'][^"']*["']|\s+\([^)]*\))\s*$/);
			if (titleMatch?.[1]) value = titleMatch[1].trim();
			return value;
		}

		function getEditorPositionFromEvent(e, view, sourceRoot) {
			const editor = view?.editor;
			if (!editor) return null;

			// Some Obsidian builds expose this convenience method even though it is not
			// part of the stable Editor interface.
			if (typeof editor.posAtMouse === 'function') {
				try {
					const pos = editor.posAtMouse(e);
					if (pos && typeof pos.line === 'number' && typeof pos.ch === 'number') return pos;
				} catch (_) {}
			}

			// CodeMirror 6's EditorView can translate screen coordinates to a document
			// offset. Obsidian commonly exposes it as editor.cm; alternate locations are
			// included for compatibility with different desktop builds.
			const cm =
				editor.cm ||
				view?.currentMode?.editor?.cm ||
				view?.currentMode?.cmEditor ||
				sourceRoot?.querySelector?.('.cm-editor')?.cmView?.view ||
				null;

			if (cm?.posAtCoords && editor.offsetToPos) {
				try {
					const offset = cm.posAtCoords({ x: e.clientX, y: e.clientY }, false);
					if (typeof offset === 'number') return editor.offsetToPos(offset);
				} catch (_) {}
			}

			// Pointerdown capture runs before CodeMirror moves the cursor. By click time,
			// getCursor() is a useful last-resort position for Ctrl/Cmd-click navigation.
			if (e.type === 'click' && typeof editor.getCursor === 'function') {
				try {
					const pos = editor.getCursor();
					if (pos && typeof pos.line === 'number' && typeof pos.ch === 'number') return pos;
				} catch (_) {}
			}

			return null;
		}

		function getEditorLinkAtEvent(e, view = getActiveMarkdownView()) {
			const sourceRoot = e.target.closest?.('.markdown-source-view');
			const editor = view?.editor;
			if (!sourceRoot || !editor?.getLine) return null;

			const pos = getEditorPositionFromEvent(e, view, sourceRoot);
			if (!pos) return null;

			let line = '';
			try {
				line = editor.getLine(pos.line) ?? '';
			} catch (_) {
				return null;
			}
			if (!line) return null;

			const candidates = [];
			let match;

			// Wiki links and embeds: [[Note]], [[Note#Heading|Alias]], ![[Note]].
			const wikiLink = /\[\[([^\]\n]+)\]\]/g;
			while ((match = wikiLink.exec(line))) {
				const inner = match[1] ?? '';
				const target = inner.split('|', 1)[0].trim();
				if (target) candidates.push({ start: match.index, end: wikiLink.lastIndex, target });
			}

			// Standard Markdown links. This covers the normal Obsidian-generated form;
			// data-href anchors are still preferred when Obsidian renders one.
			const markdownLink = /\[[^\]\n]*\]\(([^)\n]+)\)/g;
			while ((match = markdownLink.exec(line))) {
				const target = cleanMarkdownDestination(match[1]);
				if (target) candidates.push({ start: match.index, end: markdownLink.lastIndex, target });
			}

			const candidate = candidates.find(({ start, end }) => pos.ch >= start && pos.ch <= end);
			if (!candidate) return null;

			const tokenEl = e.target.closest?.(
				'a, [data-href], .cm-hmd-internal-link, .cm-link, .cm-url, .cm-underline, span'
			) ?? e.target;

			return {
				element: tokenEl,
				target: candidate.target,
				isSource: true,
				isAnchor: tokenEl?.matches?.('a, [data-href]') ?? false,
				position: pos
			};
		}

		function isProbablyInternalObsidianLink(link, view = getActiveMarkdownView()) {
			const el = getLinkElement(link);
			if (!el || !view?.file) return false;
			if (!el.closest?.('.markdown-reading-view, .markdown-source-view')) return false;

			const raw = getLinkText(link);
			if (!raw) return false;

			let target = raw;
			try {
				target = decodeURIComponent(raw);
			} catch (_) {
				// Keep raw target if decoding fails.
			}

			// Ignore external/browser-style links and Obsidian URI links.
			if (/^(?:https?:|mailto:|tel:|obsidian:|file:|data:|ftp:|\/\/)/i.test(target)) return false;

			// A source-mode target parsed from the editor line is an internal candidate.
			// Scheme filtering above rejects ordinary external links.
			if (link?.isSource) return true;

			// Obsidian reading mode internal links normally have this class or data-href.
			if (el.classList?.contains('internal-link') || el.hasAttribute?.('data-href')) return true;

			// Markdown same-page anchors rendered as normal anchors.
			if (target.startsWith('#')) return true;

			// Relative Markdown links to .md files.
			if (/\.md($|#)/i.test(target)) return true;

			return false;
		}

		function findInternalLinkFromEvent(e, view = getActiveMarkdownView()) {
			const anchor = e.target.closest?.('a.internal-link, a[data-href], a[href]') ?? null;
			if (anchor) {
				return {
					element: anchor,
					target: getLinkText(anchor),
					isSource: !!anchor.closest?.('.markdown-source-view'),
					isAnchor: true
				};
			}

			return getEditorLinkAtEvent(e, view);
		}

		function recordNavigationSourceFromEvent(e, phase = e.type) {
			if (isRestoringCustomHistory) return;
			if (e.defaultPrevented) return;
			if (typeof e.button === 'number' && e.button !== 0) return;
			if (e.shiftKey || e.altKey) return;

			const view = getActiveMarkdownView();
			const link = findInternalLinkFromEvent(e, view);
			if (!isProbablyInternalObsidianLink(link, view)) return;

			const hasFollowModifier = e.metaKey || e.ctrlKey;
			const isTouchActivation = e.pointerType === 'touch' || e.type === 'touchstart';

			// Reading view follows links with a normal click, so modified clicks should
			// keep their native "open elsewhere" behavior. Desktop Source/Live Preview
			// usually requires Ctrl/Cmd-click; touch devices can follow with a tap.
			if (!link.isSource && hasFollowModifier) return;
			if (link.isSource && !link.isAnchor && !hasFollowModifier && !isTouchActivation) return;

			const sourceEl = getLinkElement(link);
			const now = Date.now();
			const scrollForKey = Math.round(getScrollElement(view)?.scrollTop ?? 0);
			const activationKey = `${view.file.path}|${getLinkText(link)}|${scrollForKey}`;

			// Prevent double-pushes from pointerdown + touchstart + click for the same tap.
			// Different link elements, different scroll positions, or later activations still push normally.
			if (
				lastRecordedActivation &&
				now - lastRecordedActivation.time < 700 &&
				lastRecordedActivation.link === sourceEl &&
				lastRecordedActivation.key === activationKey
			) {
				return;
			}

			const state = getScrollState(view, sourceEl);
			if (!state?.path) return;

			pushStack(backStack, state, { force: true });
			clearForwardStack();
			lastKnownState = state;
			lastKnownPath = state.path;
			lastRecordedActivation = { time: now, link: sourceEl, key: activationKey, phase };
			suppressNextFileOpenPushUntil = now + 1200;
			queueRefreshToolbarButtons();
		}

		// Use early events because some mobile builds/plugins navigate before a normal click bubbles.
		for (const eventName of ['pointerdown', 'touchstart', 'click']) {
			document.addEventListener(eventName, recordNavigationSourceFromEvent, { capture: true, passive: true });
			cleanups.push(() => document.removeEventListener(eventName, recordNavigationSourceFromEvent, true));
		}

		function scrollElementToTop(el, top) {
			if (!el || typeof top !== 'number') return;
			try {
				el.scrollTo({ top, behavior: 'auto' });
			} catch (_) {
				try {
					el.scrollTop = top;
				} catch (_) {}
			}
		}

		function restoreSourceElementPosition(state) {
			const sourceEl = state?.sourceEl;
			if (!sourceEl?.isConnected) return false;

			const scroller = getNearestScrollableAncestor(sourceEl) ?? state.sourceScroller ?? getScrollElement();
			try {
				sourceEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
			} catch (_) {}

			const wantedOffset = typeof state.sourceOffsetTop === 'number' ? state.sourceOffsetTop : 80;
			const currentOffset = getElementOffsetInsideScroller(sourceEl, scroller);
			if (typeof currentOffset !== 'number') return true;

			const delta = currentOffset - wantedOffset;
			if (scroller && Math.abs(delta) > 1) {
				if (scroller === document.scrollingElement || scroller === document.body || scroller === document.documentElement) {
					window.scrollBy(0, delta);
				} else {
					scroller.scrollTop += delta;
				}
			}
			return true;
		}

		function applyScrollStateToCurrentView(state) {
			const view = getActiveMarkdownView();
			if (!state || !view?.file || view.file.path !== state.path) return false;

			const apply = () => {
				// Same-render same-note link jumps are most accurate if we put the tapped
				// source link back where it originally was.
				if (restoreSourceElementPosition(state)) return;

				const mode = view.currentMode;
				if (typeof state.apiScroll === 'number' && typeof mode?.applyScroll === 'function') {
					try {
						mode.applyScroll(state.apiScroll);
					} catch (_) {
						// Fall through to direct DOM scrolling too.
					}
				}

				const candidates = getScrollCandidates(view);
				for (const item of state.scrollTops ?? []) {
					const el = candidates[item.index];
					if (el) scrollElementToTop(el, item.scrollTop);
				}

				const scroller = getScrollElement(view);
				if (scroller) scrollElementToTop(scroller, state.scrollTop);
			};

			requestAnimationFrame(() => {
				apply();
				setTimeout(apply, 60);
				setTimeout(() => {
					apply();
					updateSnapshotNow();
					queueRefreshToolbarButtons();
				}, 160);
			});

			return true;
		}

		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		async function openPathIfNeeded(path) {
			if (!path || getActivePath() === path) return true;

			const file = app.vault?.getAbstractFileByPath?.(path);
			if (!file) return false;

			const leaf = app.workspace.getLeaf?.(false) ?? app.workspace.activeLeaf;
			if (!leaf?.openFile) return false;

			await leaf.openFile(file, { active: true });
			await sleep(40);
			return getActivePath() === path;
		}

		async function restoreState(state) {
			if (!state?.path) return false;

			isRestoringCustomHistory = true;
			suppressNextFileOpenPushUntil = Date.now() + 1200;
			try {
				const opened = await openPathIfNeeded(state.path);
				if (!opened) return false;

				// Give Reading view a moment to render after a cross-note open.
				await sleep(30);
				return applyScrollStateToCurrentView(state);
			} finally {
				setTimeout(() => {
					isRestoringCustomHistory = false;
					updateSnapshotNow();
					queueRefreshToolbarButtons();
				}, 250);
			}
		}

		function canGoCustomBack() {
			return backStack.length > 0;
		}

		function canGoCustomForward() {
			return forwardStack.length > 0;
		}

		function currentStateForStack() {
			return getScrollState() ?? lastKnownState;
		}

		function goCustomBack() {
			if (!canGoCustomBack() || isRestoringCustomHistory) return false;

			const target = backStack.pop();
			const current = currentStateForStack();
			if (current?.path && !stateLooksSamePlace(current, target)) {
				pushStack(forwardStack, current, { force: true });
			}

			restoreState(target).then(() => queueRefreshToolbarButtons());
			queueRefreshToolbarButtons();
			return true;
		}

		function goCustomForward() {
			if (!canGoCustomForward() || isRestoringCustomHistory) return false;

			const target = forwardStack.pop();
			const current = currentStateForStack();
			if (current?.path && !stateLooksSamePlace(current, target)) {
				pushStack(backStack, current, { force: true });
			}

			restoreState(target).then(() => queueRefreshToolbarButtons());
			queueRefreshToolbarButtons();
			return true;
		}

		// Expose dedicated commands without assigning default hotkeys.
		// Users can bind these in Settings > Hotkeys, while Obsidian's native
		// Back/Forward commands are also patched below when custom history exists.
		this.addCommand({
			id: 'go-back',
			name: 'Go back to previous link position',
			checkCallback: (checking) => {
				if (!canGoCustomBack() || isRestoringCustomHistory) return false;
				if (!checking) goCustomBack();
				return true;
			}
		});

		this.addCommand({
			id: 'go-forward',
			name: 'Go forward to next link position',
			checkCallback: (checking) => {
				if (!canGoCustomForward() || isRestoringCustomHistory) return false;
				if (!checking) goCustomForward();
				return true;
			}
		});


		// ---------------------------------------------------------------------
		// Toolbar / mobile navbar Back + Forward support
		// ---------------------------------------------------------------------
		function textForElement(el) {
			if (!el) return '';
			const parts = [
				el.getAttribute?.('aria-label'),
				el.getAttribute?.('title'),
				el.getAttribute?.('data-tooltip'),
				el.getAttribute?.('aria-keyshortcuts'),
				el.dataset?.tooltip,
				el.textContent
			].filter(Boolean);
			return parts.join(' ').trim().toLowerCase();
		}

		function classAndIconText(el) {
			if (!el) return '';
			const classText = typeof el.className === 'string' ? el.className : '';
			const htmlText = el.innerHTML || '';
			return `${classText} ${htmlText}`.toLowerCase();
		}

		function buttonCandidateFromTarget(target) {
			return target.closest?.(
				'button, .clickable-icon, .mobile-navbar-action, .mobile-toolbar-option, [aria-label], [title], [data-tooltip]'
			) ?? null;
		}

		function isInBodyOrPopup(el) {
			return !!el?.closest?.('.markdown-reading-view, .markdown-source-view, .modal, .menu, .suggestion-container');
		}

		function isLikelyToolbar(el) {
			return !!el?.closest?.(
				'.mobile-navbar, .mobile-navbar-actions, .mobile-toolbar, .mobile-toolbar-options, .view-header, .workspace-ribbon, .titlebar-button-container'
			);
		}

		function isToolbarBackElement(el) {
			if (!el || isInBodyOrPopup(el)) return false;

			const label = textForElement(el);
			const iconText = classAndIconText(el);

			if (label && !label.includes('backlink')) {
				if (/^(navigate\s+)?back$/.test(label) || /\bgo\s+back\b/.test(label) || /\bnavigate\s+back\b/.test(label)) return true;
			}

			if (isLikelyToolbar(el)) {
				if (/lucide-(arrow-left|chevron-left)|arrow-left|chevron-left|left-arrow/.test(iconText)) return true;
			}

			return false;
		}

		function isToolbarForwardElement(el) {
			if (!el || isInBodyOrPopup(el)) return false;

			const label = textForElement(el);
			const iconText = classAndIconText(el);

			if (label) {
				if (/^(navigate\s+)?forward$/.test(label) || /\bgo\s+forward\b/.test(label) || /\bnavigate\s+forward\b/.test(label)) return true;
			}

			if (isLikelyToolbar(el)) {
				if (/lucide-(arrow-right|chevron-right)|arrow-right|chevron-right|right-arrow/.test(iconText)) return true;
			}

			return false;
		}

		function consumeEvent(e) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation?.();
		}

		function handleToolbarNav(e) {
			const button = buttonCandidateFromTarget(e.target);
			if (!button) return;

			const now = Date.now();
			const isBack = isToolbarBackElement(button);
			const isForward = !isBack && isToolbarForwardElement(button);
			if (!isBack && !isForward) return;

			if (e.type === 'click' && now - lastToolbarHandledAt < 600) {
				consumeEvent(e);
				return;
			}

			const handled = isBack ? goCustomBack() : goCustomForward();
			if (handled) {
				lastToolbarHandledAt = now;
				consumeEvent(e);
			}
			// If the custom stack is empty, leave the event alone so Obsidian's native
			// document-level Back/Forward behavior still works.
		}

		for (const eventName of ['pointerdown', 'touchstart', 'click']) {
			document.addEventListener(eventName, handleToolbarNav, { capture: true, passive: false });
			cleanups.push(() => document.removeEventListener(eventName, handleToolbarNav, true));
		}

		function queryToolbarCandidates() {
			return Array.from(document.querySelectorAll(
				'button, .clickable-icon, .mobile-navbar-action, .mobile-toolbar-option, [aria-label], [title], [data-tooltip]'
			));
		}

		function setForcedEnabled(el, enabled) {
			if (!el) return;

			if (enabled) {
				if (!forcedToolbarStates.has(el)) {
					forcedToolbarStates.set(el, {
						hadDisabled: el.hasAttribute('disabled'),
						disabledProp: typeof el.disabled === 'boolean' ? el.disabled : undefined,
						ariaDisabled: el.getAttribute('aria-disabled'),
						hadIsDisabled: el.classList?.contains('is-disabled') ?? false,
						pointerEvents: el.style?.pointerEvents ?? ''
					});
				}

				el.removeAttribute('disabled');
				if (typeof el.disabled === 'boolean') el.disabled = false;
				el.setAttribute('aria-disabled', 'false');
				el.classList?.remove('is-disabled');
				if (el.style) el.style.pointerEvents = 'auto';
				return;
			}

			const state = forcedToolbarStates.get(el);
			if (!state) return;

			if (state.hadDisabled) el.setAttribute('disabled', '');
			else el.removeAttribute('disabled');

			if (typeof el.disabled === 'boolean' && typeof state.disabledProp === 'boolean') {
				el.disabled = state.disabledProp;
			}

			if (state.ariaDisabled === null) el.removeAttribute('aria-disabled');
			else el.setAttribute('aria-disabled', state.ariaDisabled);

			if (state.hadIsDisabled) el.classList?.add('is-disabled');
			else el.classList?.remove('is-disabled');

			if (el.style) el.style.pointerEvents = state.pointerEvents;
			forcedToolbarStates.delete(el);
		}

		function refreshToolbarButtonsNow() {
			const backAvailable = canGoCustomBack();
			const forwardAvailable = canGoCustomForward();

			for (const el of queryToolbarCandidates()) {
				if (isToolbarBackElement(el)) setForcedEnabled(el, backAvailable);
				else if (isToolbarForwardElement(el)) setForcedEnabled(el, forwardAvailable);
				else setForcedEnabled(el, false);
			}
		}

		function queueRefreshToolbarButtons() {
			if (refreshQueued) return;
			refreshQueued = true;
			requestAnimationFrame(() => {
				refreshQueued = false;
				refreshToolbarButtonsNow();
			});
		}

		const toolbarObserver = new MutationObserver(() => queueRefreshToolbarButtons());
		toolbarObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['class', 'aria-label', 'title', 'disabled', 'aria-disabled']
		});
		cleanups.push(() => toolbarObserver.disconnect());

		// Best-effort command patches. Some toolbar buttons call these instead of
		// dispatching normal pointer/click events.
		function patchCommand(id, canRun, run) {
			const command = app.commands?.commands?.[id];
			if (!command) return;

			const originalCallback = command.callback;
			const originalCheckCallback = command.checkCallback;

			command.callback = function (...args) {
				if (canRun()) {
					run();
					return true;
				}
				return originalCallback?.apply(this, args);
			};

			if (originalCheckCallback) {
				command.checkCallback = function (checking, ...args) {
					if (canRun()) {
						if (!checking) run();
						return true;
					}
					return originalCheckCallback.apply(this, [checking, ...args]);
				};
			}

			cleanups.push(() => {
				command.callback = originalCallback;
				command.checkCallback = originalCheckCallback;
			});
		}

		patchCommand('app:go-back', canGoCustomBack, goCustomBack);
		patchCommand('app:go-forward', canGoCustomForward, goCustomForward);

		// Extra best-effort: some mobile toolbar buttons call the active leaf's history
		// methods directly.
		const patchedHistories = new WeakMap();

		function patchHistoryMethod(history, methodName, canRun, run) {
			if (!history || typeof history[methodName] !== 'function') return;
			const currentPatch = patchedHistories.get(history) ?? {};
			if (currentPatch[methodName]) return;

			const original = history[methodName];
			history[methodName] = function (...args) {
				if (canRun()) {
					run();
					return true;
				}
				return original.apply(this, args);
			};

			currentPatch[methodName] = original;
			patchedHistories.set(history, currentPatch);

			cleanups.push(() => {
				try {
					history[methodName] = original;
				} catch (_) {}
			});
		}

		function patchLeafHistory(leaf) {
			const history = leaf?.history;
			if (!history) return;

			const isActive = () => leaf === app.workspace.activeLeaf;
			patchHistoryMethod(history, 'back', () => isActive() && canGoCustomBack(), goCustomBack);
			patchHistoryMethod(history, 'goBack', () => isActive() && canGoCustomBack(), goCustomBack);
			patchHistoryMethod(history, 'forward', () => isActive() && canGoCustomForward(), goCustomForward);
			patchHistoryMethod(history, 'goForward', () => isActive() && canGoCustomForward(), goCustomForward);
		}

		function patchAllLeafHistories() {
			try {
				app.workspace.iterateAllLeaves?.((leaf) => patchLeafHistory(leaf));
			} catch (_) {}
			patchLeafHistory(app.workspace.activeLeaf);
			queueRefreshToolbarButtons();
		}

		function handleFileOpen(file) {
			const nextPath = file?.path ?? getActivePath();
			const now = Date.now();

			if (
				lastKnownPath &&
				nextPath &&
				nextPath !== lastKnownPath &&
				!isRestoringCustomHistory &&
				now > suppressNextFileOpenPushUntil &&
				lastKnownState?.path === lastKnownPath
			) {
				pushStack(backStack, lastKnownState, { force: false });
				clearForwardStack();
			}

			lastKnownPath = nextPath ?? lastKnownPath;
			setTimeout(() => {
				patchAllLeafHistories();
				updateSnapshotNow();
				queueRefreshToolbarButtons();
			}, 80);
		}

		try {
			const activeLeafRef = app.workspace.on('active-leaf-change', () => {
				patchAllLeafHistories();
				queueSnapshot();
				queueRefreshToolbarButtons();
			});
			const layoutRef = app.workspace.on('layout-change', () => {
				patchAllLeafHistories();
				queueSnapshot();
				queueRefreshToolbarButtons();
			});
			const fileOpenRef = app.workspace.on('file-open', handleFileOpen);
			cleanups.push(() => app.workspace.offref?.(activeLeafRef));
			cleanups.push(() => app.workspace.offref?.(layoutRef));
			cleanups.push(() => app.workspace.offref?.(fileOpenRef));
		} catch (_) {
			// Safe to ignore in older builds or unusual startup timing.
		}

		// Keep a reasonably fresh position snapshot without attaching fragile scroll
		// listeners to Obsidian's frequently replaced mobile containers.
		const snapshotInterval = window.setInterval(queueSnapshot, 1500);
		cleanups.push(() => window.clearInterval(snapshotInterval));

		updateSnapshotNow();
		lastKnownPath = getActivePath();
		patchAllLeafHistories();
		queueRefreshToolbarButtons();

		window.__linkPositionHistoryCleanup = () => {
			for (const el of queryToolbarCandidates()) setForcedEnabled(el, false);
			while (cleanups.length) {
				try {
					cleanups.pop()();
				} catch (_) {
					// Keep cleaning up the rest.
				}
			}
			delete window.__linkPositionHistoryCleanup;
		};
	}

	onunload() {
		window.__linkPositionHistoryCleanup?.();
	}
}
