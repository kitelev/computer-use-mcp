import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
	mouse,
	keyboard,
	Point,
	screen,
	Button,
	imageToJimp,
} from '@nut-tree-fork/nut-js';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readFile, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import Jimp from 'jimp';
import sharp from 'sharp';
import {toKeys} from '../xdotoolStringToKeys.js';
import {jsonResult} from '../utils/response.js';

const execFileAsync = promisify(execFile);

function log(message: string): void {
	const timestamp = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
	console.error(`[computer-use ${timestamp}] ${message}`);
}

const TEXT_PREVIEW_MAX = 500;

type TextPreview = {
	preview: string;
	truncated: boolean;
	total: number;
};

/**
 * Build a single preview of a user-supplied string for both stderr logs and
 * tool-result JSON, so the two views can never drift. Keeps up to `max` chars
 * verbatim and appends an explicit `…[+N chars]` tail when longer, so the
 * reader can always recover the total length even when the payload is clipped.
 */
function previewText(text: string, max: number = TEXT_PREVIEW_MAX): TextPreview {
	if (text.length <= max) {
		return {preview: text, truncated: false, total: text.length};
	}

	return {
		preview: `${text.slice(0, max)}…[+${text.length - max} chars]`,
		truncated: true,
		total: text.length,
	};
}

type MacDiagnostics = {
	front_app?: string;
	window_title?: string;
};

/**
 * TTL of the macOS diagnostics cache.
 *
 * `decorate()` runs on EVERY computer action and used to spawn one `osascript`
 * child process per action. Measured 2026-08-21 (interval deltas, four rounds):
 *
 *   execFile('osascript') x1600   -> rss 46.0 -> 62.8 MB  ~= 0.0105 MB/call
 *   native setMousePosition x8000 -> rss 94.0 -> 100.8 MB ~= 0.00085 MB/call
 *
 * The per-action spawn retains twelve times what the native mouse call does, and
 * it is charged to every action. Issue #7 missed it because its measurement was
 * DIFFERENTIAL and both compared branches call `decorate()`, so the common — and
 * larger — term cancelled out.
 *
 * Half a second: long enough to coalesce the burst inside a single action, short
 * enough that a stale front_app cannot outlive the action that changed it.
 */
const MAC_DIAG_TTL_MS = 500;

/**
 * Actions that cannot move focus. Everything else invalidates the cache.
 *
 * Deliberately inverted: listing the FOCUS-CHANGING actions instead would put
 * every future action outside the guard by default, and the failure would be
 * silent — a new action lands, focus moves, and `decorate()` keeps reporting the
 * PREVIOUS front app. Listing the read-only ones makes an unknown action
 * invalidate by construction; the cost is at most one extra `osascript` for an
 * unrecognised action, which is the safe side.
 */
const READ_ONLY_ACTIONS = new Set(['get_screenshot', 'get_cursor_position']);

let macDiagCache: {value: MacDiagnostics; at: number} | undefined;

/**
 * Drop the cached diagnostics. Called after anything that can move focus, so the
 * next `decorate()` reports the NEW frontmost app rather than the previous one.
 */
export function invalidateMacDiagnostics(): void {
	macDiagCache = undefined;
}

/**
 * Query the frontmost macOS application and its focused window title via
 * AppleScript. Bounded timeout, never throws — returns an empty object on
 * any failure so diagnostic decoration is a best-effort enrichment.
 */
// Exported for the cache axes in computer-diag-cache.test.ts: the guarantee is about
// how many child processes a burst of actions spawns, and counting that requires
// calling this directly.
export async function getMacDiagnostics(): Promise<MacDiagnostics> {
	if (process.platform !== 'darwin') {
		return {};
	}

	const now = Date.now();
	if (macDiagCache !== undefined && now - macDiagCache.at < MAC_DIAG_TTL_MS) {
		return macDiagCache.value;
	}

	const script = `
tell application "System Events"
	set frontApp to name of first application process whose frontmost is true
	set winTitle to ""
	try
		tell process frontApp
			if (count of windows) > 0 then
				set winTitle to name of front window
			end if
		end tell
	end try
end tell
return frontApp & "\\t" & winTitle
`;

	return new Promise<MacDiagnostics>((resolve) => {
		// Only a SUCCESSFUL answer is cached. Caching a failure would pin an empty
		// diagnostics object for the whole TTL and hide a recovery that already happened.
		const done = (value: MacDiagnostics, cacheable: boolean) => {
			if (cacheable) {
				macDiagCache = {value, at: Date.now()};
			}

			resolve(value);
		};

		const child = execFile(
			'osascript',
			['-e', script],
			{timeout: 500, maxBuffer: 64 * 1024},
			(err, stdout) => {
				if (err || typeof stdout !== 'string') {
					done({}, false);
					return;
				}

				const [front_app, window_title] = stdout.trim().split('\t');
				const out: MacDiagnostics = {};
				if (front_app) out.front_app = front_app;
				if (window_title) out.window_title = window_title;
				done(out, true);
			},
		);
		child.on('error', () => done({}, false));
	});
}

type ActionDiag = {
	action: string;
	ok: boolean;
	duration_ms: number;
	coord_api?: [number, number];
	coord_logical?: [number, number];
	scale?: number;
	display?: {width: number; height: number};
	extra?: Record<string, unknown>;
};

async function decorate(diag: ActionDiag): Promise<Record<string, unknown>> {
	const mac = await getMacDiagnostics();
	return {
		...diag,
		...mac,
		ts: new Date().toISOString(),
	};
}

/**
 * How many consecutive nut-js `screen.grab()` failures we have seen, and whether we have
 * given up probing it for the rest of the process.
 *
 * Motivation: on macOS 26+ `CGDisplayCreateImageForRect` was removed, so `screen.grab()`
 * fails permanently there and re-probing costs a thrown-exception round-trip on every
 * single screenshot, while making the fallback look exceptional when it is the steady state.
 *
 * ⚠ Deliberately NOT the same shape as `hasXdotool()` below, which probes once and can never
 * change its mind. Two guards keep this optimisation from becoming a regression against
 * simply retrying every time:
 *
 * 1. Only a RUN of consecutive failures latches; every success resets the counter. A blip
 *    (display asleep, X11 not up yet, or Screen Recording permission granted only after the
 *    first capture is attempted) therefore self-heals instead of diverting for the whole
 *    process lifetime.
 * 2. Latching happens only where a fallback actually exists. `screencapture` is a macOS
 *    binary, so on other platforms giving up on nut-js would leave no working path at all —
 *    there, re-probing is the only thing that can ever succeed.
 *
 * Not a strict once-per-process guarantee: concurrent calls can each probe before any of them
 * records a result, so the counter may advance by more than one per round, and a burst of
 * failures can cross the threshold while a successful grab is still in flight. That success
 * therefore *un-latches* — safe by construction, because once latched `screen.grab()` is
 * never called again, so the only success that can still arrive is one that started before
 * the latch, and it is proof the capability exists.
 */
const MAX_CONSECUTIVE_NUT_GRAB_FAILURES = 3;
let consecutiveNutGrabFailures = 0;
let nutScreenGrabDisabled = false;

/** How long `screencapture` may run before we treat it as wedged. */
const SCREENCAPTURE_TIMEOUT_MS = 10_000;

/**
 * Capture via the macOS `screencapture` CLI.
 *
 * Asynchronous so the capture does not block the event loop, and bounded by a timeout:
 * `screencapture` can wedge (permission dialog, unresponsive WindowServer), and without one
 * the promise could hang indefinitely with no way to recover. The timeout is a mitigation,
 * not a guarantee — Node sends SIGTERM and the callback fires only once the child exits.
 */
async function captureViaScreencapture(): Promise<ReturnType<typeof imageToJimp>> {
	// randomUUID, not Date.now(): concurrent captures used to be serialised by the blocking
	// execFileSync, but the async exec lets several land in the same millisecond — and the
	// 1s "let the screen settle" sleep before each grab actively aligns them.
	const tmpPath = join(tmpdir(), `computer-use-mcp-${randomUUID()}.png`);
	try {
		await execFileAsync('screencapture', ['-x', tmpPath], {timeout: SCREENCAPTURE_TIMEOUT_MS});
		const buffer = await readFile(tmpPath);
		return (await Jimp.read(buffer)) as unknown as ReturnType<typeof imageToJimp>;
	} finally {
		try {
			await unlink(tmpPath);
		} catch {
			/* ignore cleanup errors */
		}
	}
}

/**
 * Grab the screen, falling back to the macOS `screencapture` CLI when nut-js capture fails.
 * nut-js stops being probed only after a run of consecutive failures, and only on macOS —
 * see the comment on the counter above.
 */
export async function grabScreen(): Promise<ReturnType<typeof imageToJimp>> {
	if (!nutScreenGrabDisabled) {
		try {
			const image = imageToJimp(await screen.grab());
			consecutiveNutGrabFailures = 0;
			// Undo a latch that a concurrent failure burst set while this grab was in flight:
			// a success is proof the capability exists.
			nutScreenGrabDisabled = false;
			return image;
		} catch (error) {
			consecutiveNutGrabFailures += 1;
			const canFallBackPermanently = process.platform === 'darwin';
			if (canFallBackPermanently && consecutiveNutGrabFailures >= MAX_CONSECUTIVE_NUT_GRAB_FAILURES) {
				nutScreenGrabDisabled = true;
				log(`  nut-js screen.grab() failed ${consecutiveNutGrabFailures}x in a row, using screencapture from now on: ${String(error)}`);
			} else {
				log(`  nut-js screen.grab() failed, using screencapture for this capture: ${String(error)}`);
			}
		}
	}

	return captureViaScreencapture();
}

// Configure nut-js
mouse.config.autoDelayMs = 100;
mouse.config.mouseSpeed = 1000;
keyboard.config.autoDelayMs = 10;

/**
 * Check if xdotool is available on this system.
 * Cached after first check.
 */
let xdotoolAvailable: boolean | undefined;
function hasXdotool(): boolean {
	if (xdotoolAvailable === undefined) {
		try {
			execFileSync('which', ['xdotool'], {stdio: 'ignore'});
			xdotoolAvailable = true;
		} catch {
			xdotoolAvailable = false;
		}
	}

	return xdotoolAvailable;
}

/**
 * Type text using xdotool, which correctly respects the X11 keyboard layout.
 *
 * nut-js's keyboard.type() uses libnut's typeString which maps characters to
 * X keycodes using a hardcoded US QWERTY lookup. This breaks when the X server's
 * keyboard layout differs, causing characters like : and ; to be swapped.
 * xdotool type uses XSendEvent with proper keymap lookups, so it works regardless
 * of the active keyboard layout.
 */
function xdotoolType(text: string): void {
	execFileSync('xdotool', [
		'type',
		'--clearmodifiers',
		'--delay',
		String(keyboard.config.autoDelayMs),
		'--',
		text,
	], {
		env: {...process.env, DISPLAY: process.env.DISPLAY || ':1'},
	});
}

// The Claude API automatically downsamples images larger than ~1.15MP or 1568px on the long edge.
// We already downsampled screenshots to fit these limits and reported the original screen
// dimensions via display_width_px/display_height_px, but Claude wasn't correctly using those
// reported dimensions - it was using coordinates from the downsampled image space directly.
// As a workaround, we now report the actual image dimensions and scale Claude's coordinates
// back up to logical screen coordinates.
// See: https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
const maxLongEdge = 1568;
const maxPixels = 1.15 * 1024 * 1024; // 1.15 megapixels

/**
 * Calculate the scale factor to downsample an image to fit API limits.
 * Returns a value <= 1 representing how much to shrink the image.
 */
function getSizeToApiScale(width: number, height: number): number {
	const longEdge = Math.max(width, height);
	const totalPixels = width * height;

	const longEdgeScale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const pixelScale = totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;

	return Math.min(longEdgeScale, pixelScale);
}

/**
 * Get the scale factor from API image coordinates to logical screen coordinates.
 * This is the inverse of the downsampling we apply to fit API limits.
 */
async function getApiToLogicalScale(): Promise<number> {
	const logicalWidth = await screen.width();
	const logicalHeight = await screen.height();
	const apiScaleFactor = getSizeToApiScale(logicalWidth, logicalHeight);
	return 1 / apiScaleFactor;
}

// Define the action enum values
const ActionEnum = z.enum([
	'key',
	'type',
	'mouse_move',
	'left_click',
	'left_click_drag',
	'right_click',
	'middle_click',
	'double_click',
	'scroll',
	'get_screenshot',
	'get_cursor_position',
]);

const actionDescription = `The action to perform. The available actions are:
* key: Press a key or key-combination on the keyboard.
* type: Type a string of text on the keyboard.
* get_cursor_position: Get the current (x, y) pixel coordinate of the cursor on the screen.
* mouse_move: Move the cursor to a specified (x, y) pixel coordinate on the screen.
* left_click: Click the left mouse button. If coordinate is provided, moves to that position first.
* left_click_drag: Click and drag the cursor to a specified (x, y) pixel coordinate on the screen.
* right_click: Click the right mouse button. If coordinate is provided, moves to that position first.
* middle_click: Click the middle mouse button. If coordinate is provided, moves to that position first.
* double_click: Double-click the left mouse button. If coordinate is provided, moves to that position first.
* scroll: Scroll the screen in a specified direction. Requires coordinate (moves there first) and text parameter with direction: "up", "down", "left", or "right". Optionally append ":N" to scroll N pixels (default 300), e.g. "down:500".
* get_screenshot: Take a screenshot of the screen.`;

const toolDescription = `Use a mouse and keyboard to interact with a computer, and take screenshots.
* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.
* Always prefer using keyboard shortcuts rather than clicking, where possible.
* If you see boxes with two letters in them, typing these letters will click that element. Use this instead of other shortcuts or clicking, where possible.
* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn't open, try taking another screenshot.
* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.

Using the crosshair:
* Screenshots show a red crosshair at the current cursor position.
* After clicking, check where the crosshair appears vs your target. If it missed, adjust coordinates proportionally to the distance - start with large adjustments and refine. Avoid small incremental changes when the crosshair is far from the target (distances are often further than you expect).
* Consider display dimensions when estimating positions. E.g. if it's 90% to the bottom of the screen, the coordinates should reflect this.`;

const coordinateSchema = z
	.array(z.number())
	.length(2)
	.describe('(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates');

export function registerComputer(server: McpServer): void {
	server.registerTool(
		'computer',
		{
			title: 'Computer Control',
			description: toolDescription,
			inputSchema: z.object({
				action: ActionEnum.describe(actionDescription),
				coordinate: coordinateSchema.optional(),
				text: z.string().optional().describe('Text to type or key command to execute'),
			}).strict(),
			// Note: No outputSchema because this tool returns varying content types including images
			annotations: {
				readOnlyHint: false,
			},
		},
		async (args) => {
			const {action, coordinate, text} = args as {action: z.infer<typeof ActionEnum>; coordinate?: [number, number]; text?: string};
			const startTime = Date.now();

			// Build a concise description of the incoming call.
			// Text uses the same preview helper as the action-level logs and the
			// tool-result JSON, so a reader can always see exactly what the model
			// asked to type (up to the cap) and the total length.
			const parts: string[] = [action];
			if (coordinate) parts.push(`coord=(${coordinate[0]},${coordinate[1]})`);
			if (text) {
				const p = previewText(text);
				parts.push(`text=${JSON.stringify(p.preview)} (len=${p.total}${p.truncated ? ', truncated' : ''})`);
			}

			log(`→ ${parts.join(' ')}`);

			// Scale coordinates from API image space to logical screen space
			let scaledCoordinate = coordinate;
			if (coordinate) {
				const scale = await getApiToLogicalScale();
				scaledCoordinate = [
					Math.round(coordinate[0] * scale),
					Math.round(coordinate[1] * scale),
				];
				log(`  scaled coord: (${coordinate[0]},${coordinate[1]}) → (${scaledCoordinate[0]},${scaledCoordinate[1]}) (scale=${scale.toFixed(3)})`);

				// Validate coordinates are within display bounds
				const [x, y] = scaledCoordinate;
				const [width, height] = [await screen.width(), await screen.height()];
				if (x < 0 || x >= width || y < 0 || y >= height) {
					log(`  ✗ out of bounds: (${x},${y}) display=${width}x${height}`);
					throw new Error(`Coordinates (${x}, ${y}) are outside display bounds of ${width}x${height}`);
				}
			}

			// Reusable diag builder closing over current action inputs
			const buildDiag = (extra?: Record<string, unknown>): ActionDiag => ({
				action,
				ok: true,
				duration_ms: Date.now() - startTime,
				...(coordinate ? {coord_api: coordinate} : {}),
				...(scaledCoordinate ? {coord_logical: scaledCoordinate} : {}),
				...(extra ? {extra} : {}),
			});

			// Implement system actions using nut-js
			// Anything that is not read-only can move focus, so the cached front_app must
			// not survive it. One point, before dispatch — a per-branch call would go stale
			// the moment someone adds a branch.
			if (!READ_ONLY_ACTIONS.has(action)) {
				invalidateMacDiagnostics();
			}

			switch (action) {
				case 'key': {
					if (!text) {
						throw new Error('Text required for key');
					}

					const keys = toKeys(text);
					const keyPreview = previewText(text);
					log(`  key combo: ${JSON.stringify(keyPreview.preview)} → ${keys.length} key(s)`);
					await keyboard.pressKey(...keys);
					await keyboard.releaseKey(...keys);

					log(`  ✓ key done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag({
						key: keyPreview.preview,
						key_truncated: keyPreview.truncated,
						key_length: keyPreview.total,
						key_count: keys.length,
					})));
				}

				case 'type': {
					if (!text) {
						throw new Error('Text required for type');
					}

					const method = (process.platform === 'linux' && hasXdotool()) ? 'xdotool' : 'nut-js';
					const typedPreview = previewText(text);
					log(`  type: ${JSON.stringify(typedPreview.preview)} (${typedPreview.total} chars${typedPreview.truncated ? ', truncated' : ''}) via ${method}`);
					if (method === 'xdotool') {
						xdotoolType(text);
					} else {
						await keyboard.type(text);
					}

					log(`  ✓ type done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag({
						text: typedPreview.preview,
						text_truncated: typedPreview.truncated,
						chars: typedPreview.total,
						method,
					})));
				}

				case 'get_cursor_position': {
					const pos = await mouse.getPosition();
					const scale = await getApiToLogicalScale();
					const apiX = Math.round(pos.x / scale);
					const apiY = Math.round(pos.y / scale);
					log(`  cursor: logical=(${pos.x},${pos.y}) api=(${apiX},${apiY}) (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag({x: apiX, y: apiY, cursor_logical: [pos.x, pos.y]})));
				}

				case 'mouse_move': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for mouse_move');
					}

					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					log(`  ✓ mouse_move done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag()));
				}

				case 'left_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.leftClick();
					log(`  ✓ left_click done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag()));
				}

				case 'left_click_drag': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for left_click_drag');
					}

					await mouse.pressButton(Button.LEFT);
					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					await mouse.releaseButton(Button.LEFT);
					log(`  ✓ left_click_drag done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag()));
				}

				case 'right_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.rightClick();
					log(`  ✓ right_click done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag()));
				}

				case 'middle_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.click(Button.MIDDLE);
					log(`  ✓ middle_click done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag()));
				}

				case 'double_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					}

					await mouse.doubleClick(Button.LEFT);
					log(`  ✓ double_click done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag()));
				}

				case 'scroll': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for scroll');
					}

					if (!text) {
						throw new Error('Text required for scroll (direction like "up", "down:5")');
					}

					// Parse direction and optional amount from text (e.g. "down" or "down:5")
					const parts = text.split(':');
					const direction = parts[0];
					const amountStr = parts[1];
					const amount = amountStr ? parseInt(amountStr, 10) : 300;

					if (!direction) {
						throw new Error('Scroll direction required');
					}

					if (amountStr !== undefined && (isNaN(amount) || amount <= 0)) {
						throw new Error(`Invalid scroll amount: ${amountStr}`);
					}

					// Move to position first
					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));

					// Scroll in the specified direction
					switch (direction.toLowerCase()) {
						case 'up':
							await mouse.scrollUp(amount);
							break;
						case 'down':
							await mouse.scrollDown(amount);
							break;
						case 'left':
							await mouse.scrollLeft(amount);
							break;
						case 'right':
							await mouse.scrollRight(amount);
							break;
						default:
							throw new Error(`Invalid scroll direction: ${direction}. Use "up", "down", "left", or "right"`);
					}

					log(`  ✓ scroll ${direction} ${amount}px done (${Date.now() - startTime}ms)`);
					return jsonResult(await decorate(buildDiag({direction: direction.toLowerCase(), amount})));
				}

				case 'get_screenshot': {
					log(`  waiting 1s for screen to settle…`);
					await setTimeout(1000);

					// Get cursor position in logical coordinates
					const cursorPos = await mouse.getPosition();

					// Capture the entire screen (may be at Retina resolution)
					const captureStart = Date.now();
					const image = await grabScreen();
					log(`  captured ${image.getWidth()}x${image.getHeight()} (${Date.now() - captureStart}ms)`);

					// Then resize to fit within API limits
					const apiScaleFactor = getSizeToApiScale(image.getWidth(), image.getHeight());
					if (apiScaleFactor < 1) {
						image.resize(
							Math.floor(image.getWidth() * apiScaleFactor),
							Math.floor(image.getHeight() * apiScaleFactor),
						);
					}

					// Calculate cursor position in API image coordinates
					// cursor is in logical coords, need to convert to API image coords
					const scale = await getApiToLogicalScale();
					const cursorInImageX = Math.floor(cursorPos.x / scale);
					const cursorInImageY = Math.floor(cursorPos.y / scale);

					// Draw a crosshair at cursor position (red color)
					const crosshairSize = 20;
					const crosshairColor = 0xFF0000FF; // Red with full opacity (RGBA)
					const imageWidth = image.getWidth();
					const imageHeight = image.getHeight();

					// Draw horizontal line
					for (let x = Math.max(0, cursorInImageX - crosshairSize); x <= Math.min(imageWidth - 1, cursorInImageX + crosshairSize); x++) {
						if (cursorInImageY >= 0 && cursorInImageY < imageHeight) {
							image.setPixelColor(crosshairColor, x, cursorInImageY);
							// Make it thicker
							if (cursorInImageY > 0) {
								image.setPixelColor(crosshairColor, x, cursorInImageY - 1);
							}

							if (cursorInImageY < imageHeight - 1) {
								image.setPixelColor(crosshairColor, x, cursorInImageY + 1);
							}
						}
					}

					// Draw vertical line
					for (let y = Math.max(0, cursorInImageY - crosshairSize); y <= Math.min(imageHeight - 1, cursorInImageY + crosshairSize); y++) {
						if (cursorInImageX >= 0 && cursorInImageX < imageWidth) {
							image.setPixelColor(crosshairColor, cursorInImageX, y);
							// Make it thicker
							if (cursorInImageX > 0) {
								image.setPixelColor(crosshairColor, cursorInImageX - 1, y);
							}

							if (cursorInImageX < imageWidth - 1) {
								image.setPixelColor(crosshairColor, cursorInImageX + 1, y);
							}
						}
					}

					// Get PNG buffer from Jimp
					const pngBuffer = await image.getBufferAsync('image/png');

					// Compress PNG using sharp, to fit size limits
					const optimizedBuffer = await sharp(pngBuffer)
						.png({quality: 80, compressionLevel: 9})
						.toBuffer();

					// Convert optimized buffer to base64
					const base64Data = optimizedBuffer.toString('base64');
					log(`  ✓ screenshot ${imageWidth}x${imageHeight} → ${(optimizedBuffer.length / 1024).toFixed(0)}KB base64 (${Date.now() - startTime}ms)`);

					const screenshotDiag = await decorate({
						action,
						ok: true,
						duration_ms: Date.now() - startTime,
						extra: {
							image_width: imageWidth,
							image_height: imageHeight,
							display: {
								width: await screen.width(),
								height: await screen.height(),
							},
							cursor_logical: [cursorPos.x, cursorPos.y],
							cursor_image: [cursorInImageX, cursorInImageY],
							scale: Number(scale.toFixed(4)),
							png_kb: Math.round(optimizedBuffer.length / 1024),
						},
					});

					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify(screenshotDiag, null, 2),
							},
							{
								type: 'image',
								data: base64Data,
								mimeType: 'image/png',
							},
						],
					};
				}
			}
		},
	);
}
