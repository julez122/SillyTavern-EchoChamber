// Preserve Main API prompt/preset construction while supplying our own cancellation signal.
// These are the same core builders used by generateRawData; no global fetch/stop hooks are installed.
export async function generateDefault(context, messages, signal, extractText) {
    signal.throwIfAborted();
    const core = await import('/script.js');
    signal.throwIfAborted();
    const api = context.mainApi;
    let prompt = core.createRawPrompt(messages, api, false, false, '', '');
    const eventData = Array.isArray(prompt) ? { chat: prompt, dryRun: false } : { prompt, dryRun: false };
    await context.eventSource.emit(Array.isArray(prompt) ? context.eventTypes.CHAT_COMPLETION_PROMPT_READY
        : context.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
    signal.throwIfAborted();
    prompt = Array.isArray(prompt) ? eventData.chat : eventData.prompt;
    let data;
    if (api === 'openai') {
        const { sendOpenAIRequest } = await import('/scripts/openai.js');
        signal.throwIfAborted();
        data = await sendOpenAIRequest('quiet', prompt, signal);
    } else {
        let payload;
        if (api === 'kobold' || api === 'koboldhorde') {
            const k = await import('/scripts/kai-settings.js');
            payload = k.kai_settings.preset_settings === 'gui'
                ? { prompt, gui_settings: true, max_length: core.amount_gen, max_context_length: core.max_context, api_server: k.kai_settings.api_server }
                : k.getKoboldGenerationData(String(prompt), k.koboldai_settings[k.koboldai_setting_names[k.kai_settings.preset_settings]],
                    core.amount_gen, core.max_context, api === 'koboldhorde', 'quiet');
        } else if (api === 'novel') {
            const n = await import('/scripts/nai-settings.js');
            payload = n.getNovelGenerationData(prompt, n.novelai_settings[n.novelai_setting_names[n.nai_settings.preset_settings_novel]],
                core.amount_gen, false, false, null, 'quiet');
        } else if (api === 'textgenerationwebui') {
            const t = await import('/scripts/textgen-settings.js');
            payload = await t.getTextGenGenerationData(prompt, core.amount_gen, false, false, null, 'quiet');
        } else { throw new Error('Unknown Main API: ' + api); }
        signal.throwIfAborted();
        if (api === 'koboldhorde') {
            const { generateHorde } = await import('/scripts/horde.js');
            signal.throwIfAborted();
            data = await generateHorde(String(prompt), payload, signal, false);
        } else {
            const response = await fetch(core.getGenerateUrl(api), { method: 'POST', headers: context.getRequestHeaders(),
                cache: 'no-cache', body: JSON.stringify(payload), signal });
            data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error?.message || data.response || 'Main API request failed');
        }
    }
    signal.throwIfAborted();
    // Retain generateRaw's cleanup and the existing extended-thinking recovery behavior.
    const raw = extractText(data);
    const cleaned = core.cleanUpMessage({ getMessage: core.extractMessageFromData(data, api), isImpersonate: false,
        isContinue: false, displayIncompleteSentences: true, includeUserPromptBias: false, trimNames: true, trimWrongNames: true });
    if (!cleaned?.trim() || raw?.trim().length > cleaned.trim().length + 50) return raw;
    return cleaned;
}
