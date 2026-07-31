import {
	describe, it, expect, vi, beforeEach,
} from 'vitest';

// Fully mocked: CI runs on ubuntu-latest, where neither nut-js screen capture nor the
// macOS `screencapture` binary exists. These mocks also let us count probe attempts.
const grabMock = vi.fn();

vi.mock('@nut-tree-fork/nut-js', () => ({
	mouse: {
		config: {}, getPosition: vi.fn(), setPosition: vi.fn(), pressButton: vi.fn(), releaseButton: vi.fn(), scrollDown: vi.fn(), scrollUp: vi.fn(), scrollLeft: vi.fn(), scrollRight: vi.fn(),
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

const {grabScreen, resetScreenGrabProbe} = await import('./computer.js');

describe('grabScreen capability probe', () => {
	beforeEach(() => {
		resetScreenGrabProbe();
		grabMock.mockReset();
		execFileMock.mockClear();
	});

	it('probes nut-js only ONCE when it is unavailable, then goes straight to the fallback', async () => {
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));

		const results = [await grabScreen(), await grabScreen(), await grabScreen()];

		// The regression: without caching this is 3 — one thrown-exception round-trip per screenshot.
		expect(grabMock).toHaveBeenCalledTimes(1);
		// All three still succeed via the screencapture fallback.
		expect(results.every((r) => (r as {source: string}).source === 'screencapture')).toBe(true);
		expect(execFileMock).toHaveBeenCalledTimes(3);
	});

	it('keeps using nut-js when it works, without falling back', async () => {
		grabMock.mockResolvedValue({} as never);

		const results = [await grabScreen(), await grabScreen()];

		expect(grabMock).toHaveBeenCalledTimes(2);
		expect(results.every((r) => (r as {source: string}).source === 'nut-js')).toBe(true);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('uses the async execFile so the event loop is not blocked during capture', async () => {
		grabMock.mockRejectedValue(new Error('Failed to capture screen'));

		await grabScreen();

		// A callback as the 3rd argument proves the async form is used, not execFileSync.
		expect(execFileMock).toHaveBeenCalledTimes(1);
		expect(typeof execFileMock.mock.calls[0][2]).toBe('function');
		expect(execFileMock.mock.calls[0][0]).toBe('screencapture');
	});
});
