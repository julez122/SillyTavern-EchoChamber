// One activation owns every operational resource. Nothing here patches browser globals.
export function createResourceScope(isCurrent = () => true) {
    const controller = new AbortController();
    const timeouts = new Set(), frames = new Set(), bindings = new Set(), native = new Set(), observers = new Set();
    const cleanups = new Set();
    const alive = () => !controller.signal.aborted && isCurrent();
    const abortError = () => new DOMException('EchoChamber operation cancelled', 'AbortError');
    const check = () => { if (!alive()) throw abortError(); };
    const guard = fn => function (...args) {
        if (!alive()) return;
        try {
            const result = fn.apply(this, args);
            if (result?.catch) result.catch(report);
            return result;
        } catch (error) { report(error); }
    };
    const report = error => { if (alive() && error?.name !== 'AbortError') console.error('[EchoChamber]', error); };
    const namespace = events => events.split(/\s+/).map(e => e + '.ecRuntime').join(' ');
    const scope = {
        signal: controller.signal, alive, check, guard,
        own(cleanup) { check(); cleanups.add(cleanup); return () => { cleanups.delete(cleanup); cleanup(); }; },
        timeout(fn, ms, ...args) {
            if (!alive()) return null;
            const id = window.setTimeout(() => { timeouts.delete(id); guard(fn)(...args); }, ms);
            timeouts.add(id); return id;
        },
        clearTimeout(id) { window.clearTimeout(id); timeouts.delete(id); },
        frame(fn) {
            if (!alive()) return null;
            const id = window.requestAnimationFrame(t => { frames.delete(id); guard(fn)(t); });
            frames.add(id); return id;
        },
        clearFrame(id) { window.cancelAnimationFrame(id); frames.delete(id); },
        on(target, events, ...args) {
            check();
            const fn = args.pop(), wrapped = guard(fn), names = namespace(events);
            target.on(names, ...args, wrapped);
            bindings.add({ target, events, names, args, wrapped });
            return target;
        },
        off(target, events, ...args) {
            target.off(events, ...args);
            for (const b of bindings) {
                if (b.target[0] !== target[0]) continue;
                const match = !events || events.split(/\s+/).some(e => b.names.split(/\s+/).some(n =>
                    e.split('.').every((part, i) => i === 0 ? !part || n.split('.')[0] === part : n.split('.').includes(part))));
                if (match && (!args.length || args[0] === b.args[0])) bindings.delete(b);
            }
            return target;
        },
        listen(target, event, fn, options) {
            if (!target || !alive()) return;
            const wrapped = guard(fn);
            target.addEventListener(event, wrapped, options);
            native.add({ target, event, fn, wrapped, options });
        },
        unlisten(target, event, fn, options) {
            for (const b of native) if (b.target === target && b.event === event && b.fn === fn) {
                b.target.removeEventListener(b.event, b.wrapped, b.options); native.delete(b);
            }
        },
        subscribe(source, event, fn) {
            if (!event) return;
            const wrapped = guard(fn); source.on(event, wrapped);
            scope.own(() => source.removeListener(event, wrapped));
        },
        observer(Type) {
            if (!Type) return undefined;
            return class extends Type {
                constructor(fn, ...args) { super(guard(fn), ...args); observers.add(this); }
                disconnect() { super.disconnect(); observers.delete(this); }
            };
        },
        releaseElement(root) {
            if (!root) return;
            for (const b of bindings) if (b.target[0] === root || (b.target[0]?.nodeType && root.contains(b.target[0]))) {
                b.target.off(b.names, ...b.args, b.wrapped); bindings.delete(b);
            }
            for (const b of native) if (b.target === root || (b.target?.nodeType && root.contains(b.target))) {
                b.target.removeEventListener(b.event, b.wrapped, b.options); native.delete(b);
            }
        },
        wait(promise) {
            check();
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (complete, value) => {
                    if (settled) return;
                    settled = true;
                    controller.signal.removeEventListener('abort', abort);
                    complete(value);
                };
                const abort = () => finish(reject, abortError());
                controller.signal.addEventListener('abort', abort, { once: true });
                Promise.resolve(promise).then(value => {
                    try { check(); finish(resolve, value); } catch (error) { finish(reject, error); }
                }, error => finish(reject, error));
            });
        },
        yield() { return scope.wait(new Promise(resolve => scope.timeout(resolve, 0))); },
        async fetch(url, options = {}) {
            check();
            const signals = [controller.signal, options.signal].filter(Boolean);
            // Keep cancellation connected through response-body consumption, not just response headers.
            if (AbortSignal.any) return await scope.wait(window.fetch(url, { ...options, signal: AbortSignal.any(signals) }));
            const request = new AbortController();
            const abort = () => request.abort();
            signals.forEach(signal => signal.addEventListener('abort', abort, { once: true }));
            if (signals.some(s => s.aborted)) request.abort();
            const release = scope.own(() => { request.abort(); signals.forEach(signal => signal.removeEventListener('abort', abort)); });
            try {
                const response = await scope.wait(window.fetch(url, { ...options, signal: request.signal }));
                for (const method of ['json', 'text', 'blob', 'arrayBuffer']) {
                    const read = response[method].bind(response);
                    response[method] = async (...args) => { try { return await read(...args); } finally { release(); } };
                }
                return response;
            } catch (error) { release(); throw error; }
        },
        stats() { return { timers: timeouts.size, frames: frames.size, jquery: bindings.size, native: native.size,
            observers: observers.size, cleanups: cleanups.size, active: alive() }; },
        dispose() {
            if (controller.signal.aborted) return;
            controller.abort();
            timeouts.forEach(id => window.clearTimeout(id)); timeouts.clear();
            frames.forEach(id => window.cancelAnimationFrame(id)); frames.clear();
            bindings.forEach(b => b.target.off(b.names, ...b.args, b.wrapped)); bindings.clear();
            native.forEach(b => b.target.removeEventListener(b.event, b.wrapped, b.options)); native.clear();
            [...observers].forEach(o => o.disconnect()); observers.clear();
            [...cleanups].forEach(fn => { try { fn(); } catch (error) { console.error('[EchoChamber] Cleanup failed', error); } });
            cleanups.clear();
        },
    };
    return scope;
}
