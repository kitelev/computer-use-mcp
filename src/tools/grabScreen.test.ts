import {
	describe, it, expect, vi, beforeEach,
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

const execFileMock = vi.fn((_cmd: string, _args: string[], cb: (e: unknown) => void) => {
	cb(null);
	return {on: vi.fn()};
});

vi.mock('node:child_process', () => ({
	execFile: (...args: unknown[]) => (execFileMock as never)(...(args as never[])),
	execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
	readFileSync: vi.fn(() => Buffer.from('fake-png')),
	unlinkSync: vi.fn(),
}));

vi.mock('jimp', () => ({
	default: {read: vi.fn(async () => ({source: 'screencapture'}))},
}));

type GrabScreen = () => Promise<{source: string}>;

// Fresh module state per test via resetModules — no production export exists purely for tests.
async function loadGrabScreen(): Promise<GrabScreen> {
	vi.resetModules();
	const mod = await import('./computer.js');
	return mod.grabScreen as unknown as GrabScreen;
}

const capturedTempPaths = (): string[] => execFileMock.mock.calls.map((c) => (c[1])[1]);

describe('grabScreen capability probe', () => {
	beforeEach(() => {
		grabMock.mockReset();
		execFileMock.mockClear();
	});

	it('probes nut-js only ONCE when it has never worked, then goes straight to the fallback', async () => {
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		const results = [await grabScreen(), await grabScreen(), await grabScreen()];

		// Without caching this is 3 — one thrown-exception round-trip per screenshot.
		expect(grabMock).toHaveBeenCalledTimes(1);
		expect(results.every((r) => r.source === 'screencapture')).toBe(true);
		expect(execFileMock).toHaveBeenCalledTimes(3);
	});

	it('keeps using nut-js when it works, without falling back', async () => {
		grabMock.mockResolvedValue({} as never);
		const grabScreen = await loadGrabScreen();

		const results = [await grabScreen(), await grabScreen()];

		expect(grabMock).toHaveBeenCalledTimes(2);
		expect(results.every((r) => r.source === 'nut-js')).toBe(true);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('does NOT latch a transient failure once nut-js has proven to work (self-heals)', async () => {
		// Regression guard: latching here would permanently divert to `screencapture`,
		// which does not exist on Linux/Windows at all.
		grabMock
			.mockResolvedValueOnce({} as never)
			.mockResolvedValueOnce({} as never)
			.mockRejectedValueOnce(new Error('transient blip'))
			.mockResolvedValueOnce({} as never)
			.mockResolvedValueOnce({} as never);
		const grabScreen = await loadGrabScreen();

		const sources: string[] = [];
		for (let i = 0; i < 5; i++) {
			// eslint-disable-next-line no-await-in-loop
			sources.push((await grabScreen()).source);
		}

		expect(sources).toEqual(['nut-js', 'nut-js', 'screencapture', 'nut-js', 'nut-js']);
		expect(grabMock).toHaveBeenCalledTimes(5);
	});

	it('uses the async execFile so the event loop is not blocked during capture', async () => {
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		await grabScreen();

		// A callback as the 3rd argument proves the async form is used, not execFileSync.
		expect(execFileMock).toHaveBeenCalledTimes(1);
		expect(typeof execFileMock.mock.calls[0][2]).toBe('function');
		expect(execFileMock.mock.calls[0][0]).toBe('screencapture');
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
	});
});
