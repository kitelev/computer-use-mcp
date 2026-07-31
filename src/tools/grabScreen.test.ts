import {
	describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

// Fully mocked: CI runs on ubuntu-latest, where neither nut-js capture nor the macOS
// `screencapture` binary exists. The mocks also let us count probe attempts.
const grabMock = vi.fn();

vi.mock('@nut-tree-fork/nut-js', () => ({
	mouse: {
		config: {},
		getPosition: vi.fn(),
		setPosition: vi.fn(),
		pressButton: vi.fn(),
		releaseButton: vi.fn(),
		scrollDown: vi.fn(),
		scrollUp: vi.fn(),
		scrollLeft: vi.fn(),
		scrollRight: vi.fn(),
	},
	keyboard: {
		config: {}, type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn(),
	},
	screen: {grab: grabMock, width: vi.fn(), height: vi.fn()},
	Point: class {
		constructor(public x: number, public y: number) {}
	},
	Button: {LEFT: 0, MIDDLE: 1, RIGHT: 2},
	Key: {},
	imageToJimp: vi.fn(() => ({source: 'nut-js'})),
}));

// promisify calls fn(...args, callback), so the callback is always the last argument.
const execFileMock = vi.fn((...args: unknown[]) => {
	(args.at(-1) as (e: unknown) => void)(null);
	return {on: vi.fn()};
});

vi.mock('node:child_process', () => ({
	execFile: (...args: unknown[]) => (execFileMock as never)(...(args as never[])),
	execFileSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(async () => Buffer.from('fake-png')),
	unlink: vi.fn(async () => undefined),
}));

vi.mock('jimp', () => ({
	default: {read: vi.fn(async () => ({source: 'screencapture'}))},
}));

type GrabScreen = () => Promise<{source: string}>;

// Fresh module state per test via resetModules. `grabScreen` is exported so the test can
// reach it; the production entrypoint calls it internally.
async function loadGrabScreen(): Promise<GrabScreen> {
	vi.resetModules();
	const mod = await import('./computer.js');
	return mod.grabScreen as unknown as GrabScreen;
}

const realPlatform = process.platform;
function stubPlatform(value: string): void {
	Object.defineProperty(process, 'platform', {value, configurable: true});
}

const capturedTempPaths = (): string[] => execFileMock.mock.calls.map((c) => (c[1] as string[])[1]);

async function callTimes(grabScreen: GrabScreen, n: number): Promise<string[]> {
	const sources: string[] = [];
	for (let i = 0; i < n; i++) {
		// eslint-disable-next-line no-await-in-loop
		sources.push((await grabScreen()).source);
	}

	return sources;
}

describe('grabScreen capability probe', () => {
	beforeEach(() => {
		grabMock.mockReset();
		execFileMock.mockClear();
		stubPlatform('darwin');
	});

	afterEach(() => {
		stubPlatform(realPlatform);
	});

	it('stops probing nut-js after a run of consecutive failures (macOS 26 steady state)', async () => {
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		const sources = await callTimes(grabScreen, 6);

		// Without the latch this is 6 — one thrown-exception round-trip per screenshot.
		expect(grabMock).toHaveBeenCalledTimes(3);
		expect(sources.every((s) => s === 'screencapture')).toBe(true);
		expect(execFileMock).toHaveBeenCalledTimes(6);
	});

	it('keeps using nut-js when it works, without falling back', async () => {
		grabMock.mockResolvedValue({} as never);
		const grabScreen = await loadGrabScreen();

		const sources = await callTimes(grabScreen, 2);

		expect(grabMock).toHaveBeenCalledTimes(2);
		expect(sources.every((s) => s === 'nut-js')).toBe(true);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('does NOT latch when successes keep breaking the failure run (self-heals)', async () => {
		// Regression guard: latching on isolated blips would permanently divert to
		// `screencapture` even though nut-js is healthy.
		grabMock
			.mockRejectedValueOnce(new Error('blip'))
			.mockRejectedValueOnce(new Error('blip'))
			.mockResolvedValueOnce({} as never)
			.mockRejectedValueOnce(new Error('blip'))
			.mockRejectedValueOnce(new Error('blip'))
			.mockResolvedValueOnce({} as never);
		const grabScreen = await loadGrabScreen();

		const sources = await callTimes(grabScreen, 6);

		expect(sources).toEqual([
			'screencapture',
			'screencapture',
			'nut-js',
			'screencapture',
			'screencapture',
			'nut-js',
		]);
		// Every call still probed: the run never reached the threshold.
		expect(grabMock).toHaveBeenCalledTimes(6);
	});

	it('never gives up on nut-js off macOS, where screencapture does not exist', async () => {
		// Latching here would leave no working capture path at all.
		stubPlatform('linux');
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		await callTimes(grabScreen, 6);

		expect(grabMock).toHaveBeenCalledTimes(6);
	});

	it('bounds the screencapture child process with a timeout', async () => {
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		await grabScreen();

		// A callback after the options object proves the async form is used, not execFileSync.
		expect(execFileMock).toHaveBeenCalledTimes(1);
		expect(execFileMock.mock.calls[0][0]).toBe('screencapture');
		expect(execFileMock.mock.calls[0][2]).toMatchObject({timeout: expect.any(Number) as number});
		expect(typeof execFileMock.mock.calls[0][3]).toBe('function');
	});

	it('gives concurrent fallback captures distinct temp paths', async () => {
		// The async exec lets several captures land in the same millisecond, so a
		// Date.now()-based name would collide and the captures would clobber each other.
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		await Promise.all([grabScreen(), grabScreen(), grabScreen()]);

		const paths = capturedTempPaths();
		expect(paths).toHaveLength(3);
		expect(new Set(paths).size).toBe(3);
		// Deterministic guard: uniqueness alone would pass by luck if the names were
		// timestamp-based and the three calls happened to straddle a millisecond.
		expect(paths.every((p) => /computer-use-mcp-[0-9a-f]{8}-[0-9a-f]{4}-/.test(p))).toBe(true);
	});
});
