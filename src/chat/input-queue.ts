export class InputQueue<T> implements AsyncIterable<T> {
	private readonly items: T[] = [];
	private waiter: ((r: IteratorResult<T>) => void) | undefined;
	private closed = false;

	push(item: T): void {
		if (this.closed) throw new Error('Input queue is closed');
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = undefined;
			w({value: item, done: false});
		} else this.items.push(item);
	}

	close(): void {
		this.closed = true;
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = undefined;
			w({value: undefined, done: true});
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				if (this.items.length > 0) return Promise.resolve({value: this.items.shift() as T, done: false});
				if (this.closed) return Promise.resolve({value: undefined, done: true});
				return new Promise<IteratorResult<T>>(resolve => {
					this.waiter = resolve;
				});
			},
			return: () => {
				this.close();
				return Promise.resolve({value: undefined, done: true});
			},
		};
	}
}
