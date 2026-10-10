import {
	describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

// Fully mocked: CI runs on ubuntu-latest, where neither nut-js capture nor the macOS
// `screencapture` binary exists. The mocks also let us count in-process grab attempts.
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

describe('grabScreen capture path', () => {
	beforeEach(() => {
		grabMock.mockReset();
		// mockReset, not mockClear: G6 queues a once-implementation that a mutant may never
		// consume, and mockClear would leak it into the next test's first exec.
		execFileMock.mockReset();
		stubPlatform('darwin');
	});

	afterEach(() => {
		stubPlatform(realPlatform);
	});

	it('G1 on macOS never captures in-process via nut-js, even when nut-js would work (GitHub #3)', async () => {
		// The in-process grab is proxied through ReplayKit and leaves a persistent connection to
		// replayd. Two long-lived node processes holding one evict each other until one of them
		// exits, and both leak meanwhile. A WORKING nut-js is the case that matters: the old code preferred it.
		grabMock.mockResolvedValue({} as never);
		const grabScreen = await loadGrabScreen();

		const sources = await callTimes(grabScreen, 3);

		expect(grabMock).not.toHaveBeenCalled();
		expect(sources).toEqual(['screencapture', 'screencapture', 'screencapture']);
		expect(execFileMock).toHaveBeenCalledTimes(3);
		expect(execFileMock.mock.calls.every((c) => c[0] === 'screencapture')).toBe(true);
	});

	it('G6 on macOS a failed screencapture surfaces its error and never falls back in-process', async () => {
		// The in-process grab is the ONLY path from this process to replayd, so a fallback to it —
		// however rare — re-opens the ping-pong this file exists to prevent. nut-js would work
		// here; that is the condition under which a "helpful" fallback would be taken.
		grabMock.mockResolvedValue({} as never);
		execFileMock.mockImplementationOnce((...args: unknown[]) => {
			(args.at(-1) as (e: unknown) => void)(new Error('screencapture wedged'));
			return {on: vi.fn()};
		});
		const grabScreen = await loadGrabScreen();

		await expect(grabScreen()).rejects.toThrow('screencapture wedged');
		expect(grabMock).not.toHaveBeenCalled();
	});

	it('G2 off macOS captures via nut-js and never spawns screencapture', async () => {
		stubPlatform('linux');
		grabMock.mockResolvedValue({} as never);
		const grabScreen = await loadGrabScreen();

		const sources = await callTimes(grabScreen, 2);

		expect(grabMock).toHaveBeenCalledTimes(2);
		expect(sources).toEqual(['nut-js', 'nut-js']);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('G3 off macOS a failed grab surfaces its own error instead of a missing-binary one', async () => {
		// `screencapture` is a macOS binary: diverting to it elsewhere could only fail again,
		// with an ENOENT that hides the real reason.
		stubPlatform('linux');
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		await expect(grabScreen()).rejects.toThrow('Failed to capture screen');
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('G4 bounds the screencapture child process with a timeout', async () => {
		// nut-js fails here so this axis observes ONLY the child-process contract: whether
		// macOS reaches `screencapture` at all is G1's concern, not this one's.
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));
		const grabScreen = await loadGrabScreen();

		await grabScreen();

		// A callback after the options object proves the async form is used, not execFileSync.
		expect(execFileMock).toHaveBeenCalledTimes(1);
		expect(execFileMock.mock.calls[0]![0]).toBe('screencapture');
		// > 0: Node treats `timeout: 0` as "no timeout", which would leave a wedged capture unbounded.
		const {timeout} = execFileMock.mock.calls[0]![2] as {timeout: number};
		expect(timeout).toBeGreaterThan(0);
		// Upper bound too: a timeout of days is "no timeout" in practice.
		expect(timeout).toBeLessThanOrEqual(30_000);
		expect(typeof execFileMock.mock.calls[0]![3]).toBe('function');
	});

	it('G5 gives concurrent captures distinct temp paths', async () => {
		// The async exec lets several captures land in the same millisecond, so a
		// Date.now()-based name would collide and the captures would clobber each other.
		// nut-js fails here for the same reason as in G4: the path choice is G1's concern.
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
