export type RequestChannel = 'completion' | 'nextEdit';

export interface PendingRequest {
	signal: AbortSignal;
	cancel(): void;
	isCurrent(): boolean;
	finish(): void;
}

/** At most one request per channel; a new request only cancels the previous one on its own channel. */
export class RequestCoordinator {
	private readonly active = new Map<RequestChannel, AbortController>();
	private readonly idleListeners = new Set<() => void>();

	start(channel: RequestChannel): PendingRequest {
		this.active.get(channel)?.abort();
		const controller = new AbortController();
		this.active.set(channel, controller);
		return {
			signal: controller.signal,
			cancel: () => controller.abort(),
			isCurrent: () => this.active.get(channel) === controller && !controller.signal.aborted,
			finish: () => {
				if (this.active.get(channel) === controller) {
					this.release(channel);
				}
			}
		};
	}

	isBusy(channel: RequestChannel): boolean {
		return this.active.has(channel);
	}

	/** Resolves true once no completion is in flight, or false if `signal` aborts first. */
	completionIdle(signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) {
			return Promise.resolve(false);
		}
		if (!this.isBusy('completion')) {
			return Promise.resolve(true);
		}
		return new Promise(resolve => {
			const finish = (ready: boolean) => {
				this.idleListeners.delete(idle);
				signal.removeEventListener('abort', abort);
				resolve(ready);
			};
			const idle = () => finish(true);
			const abort = () => finish(false);
			this.idleListeners.add(idle);
			signal.addEventListener('abort', abort, { once: true });
		});
	}

	cancel(channel?: RequestChannel): void {
		for (const name of channel ? [channel] : [...this.active.keys()]) {
			this.active.get(name)?.abort();
			this.release(name);
		}
	}

	dispose(): void {
		this.cancel();
	}

	private release(channel: RequestChannel): void {
		if (!this.active.delete(channel) || channel !== 'completion') {
			return;
		}
		const listeners = [...this.idleListeners];
		this.idleListeners.clear();
		for (const listener of listeners) {
			listener();
		}
	}
}

export function waitForIdle(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) {
		return Promise.resolve(false);
	}
	return new Promise(resolve => {
		const finish = (ready: boolean) => {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			resolve(ready);
		};
		const abort = () => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}