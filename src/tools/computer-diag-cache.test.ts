import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
} from 'vitest';

/**
 `decorate()` runs on EVERY computer action and used to spawn one `osascript`
 child process per action. Measured 2026-08-21 (interval deltas, four rounds):

 execFile('osascript') x1600   →  rss 46.0 → 62.8 MB  ≈ 0.0105 MB/call
 native setMousePosition x8000 →  rss 94.0 → 100.8 MB ≈ 0.00085 MB/call

 The per-action spawn retains twelve times what the native mouse call does, and
 it is charged to every action. Issue #7 missed it because its measurement was
 DIFFERENTIAL and both compared branches call `decorate()`, so the common —
 larger — term cancelled out.
 *
 * ⛔ A2 is the bearing axis: a cache that never invalidates would report the
 * PREVIOUS frontmost app after a click, which is worse than being slow — that
 * field is exactly how a caller learns where the action landed.
 */
const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
	execFileSync: vi.fn(),
}));

vi.mock('@nut-tree-fork/nut-js', () => ({
	mouse: {
		config: {},
		getPosition: vi.fn(async () => ({x: 10, y: 20})),
		setPosition: vi.fn(async () => undefined),
		pressButton: vi.fn(), releaseButton: vi.fn(),
		scrollDown: vi.fn(), scrollUp: vi.fn(), scrollLeft: vi.fn(), scrollRight: vi.fn(),
	},
	keyboard: {
		config: {}, type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn(),
	},
	screen: {grab: vi.fn(), width: vi.fn(async () => 1440), height: vi.fn(async () => 900)},
	Point: class {
		constructor(public x: number, public y: number) {}
	},
	Button: {LEFT: 0, MIDDLE: 1, RIGHT: 2},
	Key: {},
	imageToJimp: vi.fn(() => ({source: 'nut-js'})),
}));

type DiagModule = typeof ComputerModule;
let mod: DiagModule;

// CI runs on ubuntu-latest, where getMacDiagnostics short-circuits on the platform
// guard BEFORE it ever reaches the cache. Without this stub every axis below would
// pass by measuring nothing.
const realPlatform = process.platform;
function stubPlatform(value: string): void {
	Object.defineProperty(process, 'platform', {value, configurable: true});
}

describe('getMacDiagnostics caching', () => {
	beforeEach(async () => {
		// A fresh module per test: the cache is a module-level variable, so reusing the
		// module would let one axis seed the next one's cache. Isolation must not lean on
		// invalidateMacDiagnostics() — that function IS what axis A2 measures.
		stubPlatform('darwin');
		vi.resetModules();
		mod = await import('./computer.js');
		execFileMock.mockReset();
		// Answer as the real osascript would: "<front app>\t<window title>".
		execFileMock.mockImplementation((_bin, _args, _options, cb) => {
			(cb as (e: unknown, out: string) => void)(null, 'Finder\tDesktop\n');
			return {on: vi.fn()};
		});
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		stubPlatform(realPlatform);
	});

	it('A5 off darwin there is no probe at all — the platform guard precedes the cache', async () => {
		stubPlatform('linux');
		vi.resetModules();
		const linuxMod = await import('./computer.js');

		await expect(linuxMod.getMacDiagnostics()).resolves.toEqual({});
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('A1 spawns ONE process for a burst inside the TTL', async () => {
		const a = await mod.getMacDiagnostics();
		const b = await mod.getMacDiagnostics();
		const c = await mod.getMacDiagnostics();

		expect(a).toEqual({front_app: 'Finder', window_title: 'Desktop'});
		expect(b).toEqual(a);
		expect(c).toEqual(a);
		expect(execFileMock).toHaveBeenCalledTimes(1);
	});

	it('A2 invalidation forces a fresh probe — a stale front_app is the real risk', async () => {
		await mod.getMacDiagnostics();
		expect(execFileMock).toHaveBeenCalledTimes(1);

		mod.invalidateMacDiagnostics();
		await mod.getMacDiagnostics();

		expect(execFileMock).toHaveBeenCalledTimes(2);
	});

	it('A3 the cache expires — it is a burst coalescer, not a permanent answer', async () => {
		await mod.getMacDiagnostics();
		expect(execFileMock).toHaveBeenCalledTimes(1);

		// TTL is 500 ms; jump past it without waiting for real time.
		const realNow = Date.now;
		try {
			Date.now = () => realNow() + 5000;
			await mod.getMacDiagnostics();
		} finally {
			Date.now = realNow;
		}

		expect(execFileMock).toHaveBeenCalledTimes(2);
	});

	it('A4 a FAILED probe is not cached — caching it would pin an empty answer', async () => {
		execFileMock.mockImplementation((_bin, _args, _options, cb) => {
			(cb as (e: unknown, out: unknown) => void)(new Error('boom'), undefined);
			return {on: vi.fn()};
		});

		const first = await mod.getMacDiagnostics();
		const second = await mod.getMacDiagnostics();

		expect(first).toEqual({});
		expect(second).toEqual({});
		// Two calls, not one: the failure must not occupy the cache slot.
		expect(execFileMock).toHaveBeenCalledTimes(2);
	});

	/**
	 ⛔ The axes above lock the HELPER; these lock the WIRING. A cache whose
	 invalidator is never called from the dispatcher is exactly as stale as one
	 with no invalidator at all, and A1–A5 cannot tell the two apart.
	 */
	async function toolHandler(): Promise<(args: unknown) => Promise<unknown>> {
		let captured: ((args: unknown) => Promise<unknown>) | undefined = null;
		mod.registerComputer({
			registerTool(_name: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) {
				captured = handler;
			},
		} as never);
		if (captured === null) {
			throw new Error('registerComputer did not register a handler');
		}

		return captured;
	}

	it('A6 a focus-moving action invalidates through the DISPATCHER, not just via the helper', async () => {
		const handler = await toolHandler();

		await mod.getMacDiagnostics();
		expect(execFileMock).toHaveBeenCalledTimes(1);

		await handler({action: 'mouse_move', coordinate: [5, 5]});
		await mod.getMacDiagnostics();

		// >1: the action's own decorate() may probe too; what matters is that the
		// post-action read is NOT answered from the pre-action cache.
		expect(execFileMock.mock.calls.length).toBeGreaterThan(1);
	});

	it('A7 a read-only action does NOT invalidate — otherwise the cache buys nothing', async () => {
		const handler = await toolHandler();

		await mod.getMacDiagnostics();
		const afterFirst = execFileMock.mock.calls.length;

		await handler({action: 'get_cursor_position'});
		await mod.getMacDiagnostics();

		expect(execFileMock.mock.calls.length).toBe(afterFirst);
	});

	it('A8 an UNKNOWN action invalidates by construction — the list names read-only, not mutating', async () => {
		const handler = await toolHandler();

		await mod.getMacDiagnostics();
		const afterFirst = execFileMock.mock.calls.length;

		// A future action the allow-list has never heard of must fall on the safe side.
		await handler({action: 'some_future_action'}).catch(() => undefined);
		await mod.getMacDiagnostics();

		expect(execFileMock.mock.calls.length).toBeGreaterThan(afterFirst);
	});
});
