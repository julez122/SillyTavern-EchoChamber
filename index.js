// Only this settings/bootstrap layer and settings.css load on a disabled cold start.
const MODULE_NAME = 'discord_chat';
const VERSION = '5.4.0';
const BASE_URL = new URL('.', import.meta.url).href.replace(/\/$/, '');
let root, runtime = null, activation = null, serial = 0, state = 'off', desired = false;
let runtimeModule = null, settingsHtml = null;

function context() { return SillyTavern.getContext(); }
function store() { return context().extensionSettings[MODULE_NAME] ??= {}; }
function persistEnabled(enabled) {
    store().enabled = enabled;
    context().saveSettingsDebounced();
}

const minimalSettings = `<div class="discord_settings"><div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>EchoChamber</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content"><div class="ec-s-panel">
    <div class="ec-s-description">Fake chat feed that reacts dynamically to conversation context.</div>
    <label class="ec-s-toggle-row ec-s-global-enable" for="discord_enabled">
    <input id="discord_enabled" type="checkbox" class="checkbox">
    <span class="ec-s-label-text ec-s-label-bold">Enable EchoChamber</span></label>
    </div></div></div></div>`;

function replaceSettings(html) {
    const wasOpen = root.find('.inline-drawer-content').is(':visible');
    root.html(html);
    root.find('.inline-drawer-content').toggle(wasOpen);
    root.find('.inline-drawer-icon').toggleClass('up fa-circle-chevron-up', wasOpen)
        .toggleClass('down fa-circle-chevron-down', !wasOpen);
    root.find('#discord_enabled').prop('checked', desired);
    root.find('.ec-s-global-enable').after('<div id="ec_lifecycle_status" role="status" aria-live="polite"></div>');
    root.attr('data-state', state);
}

function status(message = '') {
    root?.attr('data-state', state);
    root?.find('#discord_enabled').prop('checked', desired);
    root?.find('#ec_lifecycle_status').text(message);
}

function loadStyle(signal) {
    return new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.id = 'ec_runtime_css'; link.rel = 'stylesheet'; link.href = `${BASE_URL}/style.css?v=${VERSION}`;
        const abort = () => { link.remove(); reject(new DOMException('Cancelled', 'AbortError')); };
        link.onload = () => { signal.removeEventListener('abort', abort); resolve(link); };
        link.onerror = () => { signal.removeEventListener('abort', abort); link.remove(); reject(new Error('Could not load EchoChamber styles')); };
        signal.addEventListener('abort', abort, { once: true });
        document.head.appendChild(link);
    });
}

export async function setEnabled(enabled, save = true) {
    enabled = Boolean(enabled);
    if (enabled === desired && (state === 'on' || state === 'loading')) return;
    desired = enabled;
    const ticket = ++serial;
    activation?.abort(); activation = null;
    runtime?.deactivate(); runtime = null;
    document.getElementById('ec_runtime_css')?.remove();
    if (save) persistEnabled(enabled);
    state = enabled ? 'loading' : 'off';
    replaceSettings(minimalSettings);
    status(enabled ? 'Loading EchoChamber…' : '');
    if (!enabled) return;

    const controller = new AbortController(); activation = controller;
    const current = () => desired && ticket === serial && !controller.signal.aborted;
    try {
        const [module, html] = await Promise.all([
            runtimeModule ??= import(`${BASE_URL}/runtime.js?v=${VERSION}`).catch(error => { runtimeModule = null; throw error; }),
            settingsHtml || fetch(`${BASE_URL}/settings.html?v=${VERSION}`, { signal: controller.signal })
                .then(response => { if (!response.ok) throw new Error('Could not load EchoChamber settings'); return response.text(); }),
            loadStyle(controller.signal),
        ]);
        if (!current()) return;
        settingsHtml = html;
        replaceSettings(html);
        status('Loading EchoChamber…');
        const instance = module.createRuntime({ baseUrl: BASE_URL, isCurrent: current,
            setEnabled: value => setEnabled(value), root: root[0] });
        runtime = instance;
        await instance.activate();
        if (!current()) { instance.deactivate(); return; }
        state = 'on'; status();
    } catch (error) {
        if (!current()) return;
        controller.abort(); runtime?.deactivate(); runtime = null;
        document.getElementById('ec_runtime_css')?.remove();
        desired = false; state = 'off'; persistEnabled(false);
        replaceSettings(minimalSettings);
        status('EchoChamber could not load. You can turn it on to retry.');
        console.error('[EchoChamber] Activation failed', error);
    }
}

// Read-only diagnostics never includes settings, credentials, or prompts.
export function getLifecycleState() {
    return { state, enabled: desired, activation: serial, resources: runtime?.diagnostics() || null };
}

function bootstrap() {
    if (document.getElementById('ec_settings_root')) return;
    root = jQuery('<div id="ec_settings_root"></div>').appendTo('#extensions_settings');
    desired = store().enabled !== false;
    replaceSettings(minimalSettings);
    root.on('change.ecBootstrap', '#discord_enabled', function () { void setEnabled(this.checked); });
    if (desired) { desired = false; void setEnabled(true, false); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
else bootstrap();
