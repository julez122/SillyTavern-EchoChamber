// EchoChamber Extension - Import-free version using SillyTavern.getContext()
// No ES6 imports - uses the stable SillyTavern global object

(function () {
    'use strict';

    // Module identification
    const MODULE_NAME = 'discord_chat';
    const EXTENSION_NAME = 'EchoChamber';

    // Get BASE_URL from script tag
    const scripts = document.querySelectorAll('script[src*="index.js"]');
    let BASE_URL = '';
    for (const script of scripts) {
        if (script.src.includes('EchoChamber') || script.src.includes('DiscordChat')) {
            BASE_URL = script.src.split('/').slice(0, -1).join('/');
            break;
        }
    }

    const defaultSettings = {
        enabled: true,
        paused: false,
        source: 'default',
        preset: '',
        url: 'http://localhost:11434',
        model: '',
        openai_url: 'http://localhost:1234/v1',
        openai_key: '',
        openai_model: 'local-model',
        openai_preset: 'custom',
        userCount: 5,
        fontSize: 15,
        chatHeight: 250,
        style: 'twitch',
        position: 'bottom',
        panelWidth: 350,
        opacity: 85,
        collapsed: false,
        autoUpdateOnMessages: true,
        includeUserInput: false,
        contextDepth: 4,
        includePastEchoChambers: false,
        includePersona: false,
        includeAuthorsNote: false,
        includeCharacterDescription: false,
        includeSummary: false,
        includeWorldInfo: false,
        wiBudget: 0,
        livestream: false,
        livestreamBatchSize: 20,
        livestreamMode: 'manual',
        livestreamMinWait: 5,
        livestreamMaxWait: 60,
        livestreamAutoScroll: true,
        custom_styles: {},
        deleted_styles: [],
        style_order: null,
        chatEnabled: true,
        chatUsername: 'Streamer (You)',
        chatAvatarColor: '#3b82f6',
        chatReplyCount: 3,
        floatLeft: null,
        floatTop: null,
        floatWidth: null,
        floatHeight: null,
        floatOpen: false,
        messageOrder: 'oldest-first',
    };

    let settings = JSON.parse(JSON.stringify(defaultSettings));
    let discordBar = null;
    let discordContent = null;
    let discordQuickBar = null;
    let abortController = null;
    let generateTimeout = null;
    let debounceTimeout = null;
    let eventsBound = false;  // Prevent duplicate event listener registration
    let userCancelled = false; // Track user-initiated cancellations
    let isLoadingChat = false; // Track when we're loading/switching chats to prevent auto-generation
    let isGenerating = false; // Track when generation is in progress to prevent concurrent requests

    // Livestream state
    let livestreamQueue = []; // Queue of messages to display
    let livestreamTimer = null; // Timer for displaying next message
    let livestreamActive = false; // Whether livestream is currently displaying messages

    // Floating panel state (replaces cross-window pop-out approach)
    let floatingPanelOpen = false;   // Whether the in-page floating panel is visible
    let popoutDiscordContent = null; // Points to #ec_float_content when panel is open

    function isMobileLayout() {
        return window.innerWidth <= 768 || Boolean(SillyTavern.getContext().isMobile?.());
    }

    function getVisibleViewport() {
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft || 0;
        const top = viewport?.offsetTop || 0;
        const width = viewport?.width || window.innerWidth;
        const height = viewport?.height || window.innerHeight;
        return { left, top, width, height, right: left + width, bottom: top + height };
    }

    function getFixedPositionOrigin() {
        const root = document.documentElement;
        // A transformed root is the containing block for these body portals,
        // and can itself scroll when ST leaves its fixed-body mobile layout.
        if (getComputedStyle(root).transform !== 'none') {
            const rect = root.getBoundingClientRect();
            return { left: rect.left, top: rect.top };
        }
        return { left: 0, top: 0 };
    }

    function resetModalViewport(modal) {
        modal?.css({ top: '', left: '', right: '', bottom: '', width: '', height: '', '--ec-viewport-height': '' });
    }

    // ST's transformed html can be zero-height on mobile. Explicit dimensions
    // keep fixed overlays tied to the visible viewport, including the keyboard.
    function trackModalViewport(modal, onResize = () => { }) {
        const update = () => {
            const viewport = getVisibleViewport();
            const origin = getFixedPositionOrigin();
            modal.css({
                top: viewport.top - origin.top, left: viewport.left - origin.left, right: 'auto', bottom: 'auto',
                width: viewport.width, height: viewport.height, '--ec-viewport-height': viewport.height + 'px'
            });
            onResize();
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update);
        window.visualViewport?.addEventListener('resize', update);
        window.visualViewport?.addEventListener('scroll', update);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update);
            window.visualViewport?.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('scroll', update);
        };
    }

    let stopStyleMenuTracking = null;

    function closeStyleIndicatorMenu() {
        stopStyleMenuTracking?.();
        stopStyleMenuTracking = null;
        jQuery('#ec_style_menu_body').hide();
        jQuery('.ec_style_dropdown_trigger').removeClass('active');
    }

    function openStyleIndicatorMenu(trigger, menu) {
        const update = () => {
            if (!trigger[0].isConnected || !trigger.hasClass('active') || settings.collapsed || !settings.enabled) {
                closeStyleIndicatorMenu();
                return;
            }
            const viewport = getVisibleViewport();
            const origin = getFixedPositionOrigin();
            const rect = trigger[0].getBoundingClientRect();
            const panelBottom = discordBar[0].getBoundingClientRect().bottom;
            const upward = !isMobileLayout() && settings.position === 'bottom';
            const available = upward ? rect.top - viewport.top - 8
                : Math.min(viewport.bottom, panelBottom) - rect.bottom - 8;
            const width = Math.min(Math.max(rect.width, 200), viewport.width - 16);
            const left = Math.max(viewport.left + 8, Math.min(rect.left, viewport.right - width - 8));
            menu.css({
                position: 'fixed', top: rect.bottom - origin.top, bottom: 'auto', left: left - origin.left, right: 'auto', width,
                display: 'block', marginTop: 0, maxHeight: Math.max(0, Math.min(300, available)), overflowY: 'auto'
            });
            if (upward) menu.css('top', rect.top - menu.outerHeight() - origin.top);
        };
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        window.visualViewport?.addEventListener('resize', update);
        window.visualViewport?.addEventListener('scroll', update);
        const observer = new ResizeObserver(update);
        observer.observe(discordBar[0]);
        observer.observe(trigger[0]);
        stopStyleMenuTracking = () => {
            observer.disconnect();
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
            window.visualViewport?.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('scroll', update);
        };
        update();
    }

    // ============================================================
    // CONFIRMATION MODAL (replaces native browser confirm())
    // ============================================================

    /**
     * Shows a custom glassmorphism confirmation modal.
     * Returns a Promise<boolean> — resolves true on Confirm, false on Cancel.
     */
    let cancelConfirmModal = null;

    function showConfirmModal(message) {
        return new Promise((resolve) => {
            // Remove any existing modal
            cancelConfirmModal?.();
            jQuery('#ec_confirm_modal').remove();

            const modalHtml = `
            <div id="ec_confirm_modal" class="ec_confirm_modal_overlay" role="dialog" aria-modal="true" aria-label="Clear EchoChamber messages">
                <div class="ec_confirm_modal_card">
                    <div class="ec_confirm_modal_icon">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <div class="ec_confirm_modal_message">${message}</div>
                    <div class="ec_confirm_modal_actions">
                        <button class="ec_confirm_modal_btn ec_confirm_cancel" id="ec_confirm_cancel">Cancel</button>
                        <button class="ec_confirm_modal_btn ec_confirm_ok" id="ec_confirm_ok">Clear</button>
                    </div>
                </div>
            </div>`;

            jQuery('body').append(modalHtml);
            const overlay = jQuery('#ec_confirm_modal');
            const stopViewport = trackModalViewport(overlay);
            let settled = false;

            // Animate in
            requestAnimationFrame(() => {
                if (!settled) overlay.addClass('ec_confirm_visible');
            });

            const cleanup = (result) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKey);
                stopViewport();
                cancelConfirmModal = null;
                overlay.removeClass('ec_confirm_visible');
                setTimeout(() => overlay.remove(), 200);
                resolve(result);
            };

            jQuery('#ec_confirm_ok').on('click', () => cleanup(true));
            jQuery('#ec_confirm_cancel').on('click', () => cleanup(false));
            // Click backdrop to cancel
            jQuery('#ec_confirm_modal').on('click', function (e) {
                if (e.target === this) cleanup(false);
            });
            // ESC key to cancel
            const onKey = (e) => {
                if (e.key === 'Escape') cleanup(false);
                if (e.key === 'Enter') cleanup(true);
            };
            cancelConfirmModal = () => cleanup(false);
            document.addEventListener('keydown', onKey);
        });
    }

    // Simple debounce
    function debounce(func, wait) {
        return function (...args) {
            clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    const generateDebounced = debounce(() => generateDiscordChat(), 500);

    function updateReplyButtonState(isGen) {
        const btns = jQuery('#ec_reply_submit, #ec_float_reply_submit');
        if (isGen) {
            btns.addClass('ec_reply_stop').attr('title', 'Stop action (cancel generation)');
            btns.html('<i class="fa-solid fa-hourglass"></i>');
        } else {
            btns.removeClass('ec_reply_stop').attr('title', 'Send message');
            btns.html('<i class="fa-solid fa-paper-plane"></i>');
        }
    }

    function cancelGenerationContext() {
        log('Cancel generation triggered');
        clearTimeout(debounceTimeout);
        if (abortController) {
            log('Aborting generation...');
            userCancelled = true;
            jQuery('#ec_cancel_btn').html('<i class="fa-solid fa-hourglass"></i> Stopping...').css('pointer-events', 'none');
            jQuery('.ec_reply_stop').html('<i class="fa-solid fa-hourglass"></i>');
            abortController.abort();
            log('AbortController.abort() called, signal.aborted:', abortController.signal.aborted);

            // Also trigger SillyTavern's built-in stop generation
            const stopButton = jQuery('#mes_stop');
            if (stopButton.length && !stopButton.is('.disabled')) {
                log('Triggering SillyTavern stop button');
                stopButton.trigger('click');
            }
        } else {
            log('No abortController, showing cancel message');
            userCancelled = true;
            setStatus('');
            setDiscordText(`<div class="discord_status ec_cancelled"><i class="fa-solid fa-hand"></i> Processing cancelled</div>`);
            setTimeout(() => {
                const cancelledMsg = jQuery('.ec_cancelled');
                if (cancelledMsg.length) {
                    cancelledMsg.addClass('fade-out');
                    setTimeout(() => cancelledMsg.remove(), 500);
                }
            }, 3000);
            updateReplyButtonState(false);
        }
    }

    // ============================================================
    // UTILITY FUNCTIONS
    // ============================================================

    // Debug logging disabled for production
    // Enable by uncommenting the console calls below
    function log(...args) { /* console.log(`[${EXTENSION_NAME}]`, ...args); */ }
    function warn(...args) { /* console.warn(`[${EXTENSION_NAME}]`, ...args); */ }
    function error(...args) { console.error(`[${EXTENSION_NAME}]`, ...args); } // Keep errors visible

    /**
     * Resolve a SillyTavern macro string to its current value BEFORE embedding
     * it in prompts sent to external APIs (Ollama, OpenAI, Profile).
     * Those code paths bypass ST's internal substituteParams pipeline and would
     * forward the literal macro token (e.g. "{{persona}}") to the remote model.
     *
     * Resolution order:
     *  1. context.substituteParams(macro) — stable public ST API, covers all macros.
     *  2. Source-specific fallbacks for {{persona}} and {{authorsNote}}.
     *  3. Empty string (graceful degradation — never crashes).
     */
    function resolveSTMacro(context, macro) {
        // 1. ST's own substituteParams — handles every registered macro
        if (typeof context.substituteParams === 'function') {
            try {
                const resolved = context.substituteParams(macro);
                // substituteParams returns the literal token when no value is registered
                if (resolved !== macro) return resolved || '';
            } catch (e) {
                log('substituteParams failed for', macro, e);
            }
        }

        // 2. Source-specific fallbacks
        try {
            if (macro === '{{persona}}') {
                // powerUser.personas is a dict keyed by persona name;
                // default_persona holds the currently active persona name.
                const pu = context.powerUser;
                if (pu && pu.personas) {
                    const activeKey = pu.default_persona || context.name1 || '';
                    const desc = pu.personas[activeKey] && pu.personas[activeKey].description;
                    if (desc) return desc;
                    // Last resort: first persona that has a description
                    for (const key of Object.keys(pu.personas)) {
                        if (pu.personas[key] && pu.personas[key].description)
                            return pu.personas[key].description;
                    }
                }
            }

            if (macro === '{{authorsNote}}') {
                // '{{authorsNote}}' IS a registered substituteParams macro in ST.
                // substituteParams resolves it directly (macro names are case-insensitive),
                // so this fallback branch is a safety net for edge cases only.
                //
                // ST's Author's Note extension (MODULE_NAME = 'note_to_self') stores
                // per-chat text in chatMetadata as an OBJECT:
                //   chatMetadata['note_to_self'] = { note: "text", position, depth, interval }
                // The actual text is at .note — not the object itself (which would
                // stringify to '[object Object]' and make .trim() throw a TypeError).
                //
                // The default/global Author's Note (applied to all chats) lives in:
                //   extensionSettings['note_to_self'].default_note
                const cm = context.chatMetadata;
                if (cm) {
                    // Per-chat Author's Note object
                    if (cm.note_to_self && typeof cm.note_to_self === 'object' && cm.note_to_self.note) {
                        return cm.note_to_self.note;
                    }
                    // Some ST versions may store it as a plain string directly
                    if (cm.note_to_self && typeof cm.note_to_self === 'string' && cm.note_to_self.trim()) {
                        return cm.note_to_self;
                    }
                    // Alternate key used in some older builds
                    if (cm.authornote_prompt && typeof cm.authornote_prompt === 'string') {
                        return cm.authornote_prompt;
                    }
                }
                // Global default Author's Note (extensionSettings fallback)
                const es = context.extensionSettings;
                if (es && es.note_to_self) {
                    if (typeof es.note_to_self === 'object') {
                        return es.note_to_self.default_note || es.note_to_self.note || es.note_to_self.content || '';
                    }
                    if (typeof es.note_to_self === 'string') return es.note_to_self;
                }
                return '';
            }
        } catch (e) {
            log('Fallback macro resolution failed for', macro, e);
        }

        return '';
    }

    /**
     * Extract text content from any API response format.
     * Handles: Anthropic content arrays (extended thinking), OpenAI format,
     * raw strings, and unknown shapes with deep extraction.
     */
    function extractTextFromResponse(response) {
        if (!response) return '';

        // 1. Response is already a plain string
        if (typeof response === 'string') return response;

        // 2. Response itself is an array of content blocks (e.g. extractData returned the content array directly)
        if (Array.isArray(response)) {
            const textParts = response
                .filter(block => block && block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text);
            if (textParts.length > 0) return textParts.join('\n');
            // Fallback: maybe it's an array of strings
            const stringParts = response.filter(item => typeof item === 'string');
            if (stringParts.length > 0) return stringParts.join('\n');
            return JSON.stringify(response);
        }

        // 3. response.content exists
        if (response.content !== undefined && response.content !== null) {
            // 3a. content is a string
            if (typeof response.content === 'string') return response.content;
            // 3b. content is an array of content blocks (Anthropic extended thinking format)
            if (Array.isArray(response.content)) {
                const textParts = response.content
                    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
                    .map(block => block.text);
                if (textParts.length > 0) return textParts.join('\n');
            }
        }

        // 4. OpenAI choices format
        if (response.choices?.[0]?.message?.content) {
            const choiceContent = response.choices[0].message.content;
            if (typeof choiceContent === 'string') return choiceContent;
            if (Array.isArray(choiceContent)) {
                const textParts = choiceContent
                    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
                    .map(block => block.text);
                if (textParts.length > 0) return textParts.join('\n');
            }
        }

        // 4b. OpenAI text-completion format (KoboldCpp, llama.cpp, vLLM, etc.)
        if (typeof response.choices?.[0]?.text === 'string') return response.choices[0].text;

        // 5. Other common fields
        if (typeof response.text === 'string') return response.text;
        if (typeof response.message === 'string') return response.message;
        if (response.message?.content && typeof response.message.content === 'string') return response.message.content;

        // 6. Last resort - stringify
        console.error('[EchoChamber] Could not extract text from response, stringifying:', response);
        return JSON.stringify(response);
    }

    function setDiscordText(html) {
        if (!discordContent) return;

        const chatBlock = jQuery('#chat');
        const originalScrollBottom = chatBlock.length ?
            chatBlock[0].scrollHeight - (chatBlock.scrollTop() + chatBlock.outerHeight()) : 0;

        discordContent.html(html);

        // Scroll to appropriate end based on message order setting
        if (discordContent[0]) {
            if (settings.messageOrder === 'newest-first') {
                discordContent[0].scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                // oldest-first: scroll to bottom so the newest message is visible
                discordContent[0].scrollTo({ top: discordContent[0].scrollHeight, behavior: 'smooth' });
            }
        }

        if (chatBlock.length) {
            const newScrollTop = chatBlock[0].scrollHeight - (chatBlock.outerHeight() + originalScrollBottom);
            chatBlock.scrollTop(newScrollTop);
        }

        // Sync to floating panel if open
        if (floatingPanelOpen && popoutDiscordContent) {
            popoutDiscordContent.innerHTML = html;
            if (settings.messageOrder === 'newest-first') {
                popoutDiscordContent.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                popoutDiscordContent.scrollTo({ top: popoutDiscordContent.scrollHeight, behavior: 'smooth' });
            }
        }
    }

    function setStatus(html) {
        // Target both main panel and floating panel overlays
        const overlays = jQuery('.ec_status_overlay');
        if (overlays.length > 0) {
            if (html) {
                overlays.html(html).addClass('active');
            } else {
                overlays.removeClass('active');
                setTimeout(() => {
                    overlays.each(function () {
                        if (!jQuery(this).hasClass('active')) jQuery(this).empty();
                    });
                }, 200);
            }
        }
    }

    function applyFontSize(size) {
        let styleEl = jQuery('#discord_font_size_style');
        if (styleEl.length === 0) {
            styleEl = jQuery('<style id="discord_font_size_style"></style>').appendTo('head');
        }
        styleEl.text(`
            .discord_container { font-size: ${size}px !important; }
            .discord_username { font-size: ${size / 15}rem !important; }
            .discord_content { font-size: ${(size / 15) * 0.95}rem !important; }
            .discord_timestamp { font-size: ${(size / 15) * 0.75}rem !important; }
        `);
    }

    /**
     * Hide Pop Out option on mobile devices
     */
    function updatePopoutVisibility() {
        const isMobile = window.innerWidth <= 768;

        // Hide in settings dropdown
        const positionSelect = jQuery('#discord_position');
        if (positionSelect.length) {
            positionSelect.find('option[value="popout"]').prop('hidden', isMobile).toggleClass('mobile-hidden', isMobile);
        }

        // Hide in toolbar layout menu
        jQuery('.ec_layout_menu .ec_menu_item[data-val="popout"]').toggle(!isMobile);

        // Hide in overflow menu
        jQuery('.ec_of_pos_chip[data-val="popout"]').toggle(!isMobile);
    }

    function syncUserMenu(count) {
        settings.userCount = count;
        const countNum = parseInt(count);
        jQuery('.ec_user_menu .ec_menu_item').each(function () {
            const itemVal = parseInt(jQuery(this).data('val'));
            jQuery(this).toggleClass('selected', itemVal === countNum);
        });
        jQuery('#discord_user_count').val(count);
        // Also update the overflow menu selection if present
        jQuery('.ec_of_chip[data-action="users"]').each(function () {
            const chipVal = parseInt(jQuery(this).data('val'));
            jQuery(this).toggleClass('ec_of_selected', chipVal === countNum);
        });
    }

    function syncFontMenu(size) {
        settings.fontSize = size;
        applyFontSize(size);
        jQuery('.ec_font_menu .ec_menu_item').each(function () {
            jQuery(this).toggleClass('selected', jQuery(this).data('val') == size);
        });
        jQuery('#discord_font_size').val(size);
    }

    function applyAvatarColor(color) {
        // Set the CSS variable on the document root so all user-message elements pick it up
        document.documentElement.style.setProperty('--ec-user-avatar-color', color);
    }

    /**
     * Reorder the currently displayed messages to match settings.messageOrder
     * without requiring a regeneration. Reverses the DOM order of all
     * .discord_message elements inside .discord_container and scrolls to the
     * appropriate end.
     */
    function applyMessageOrder() {
        // Reorder in main panel
        const container = jQuery('#discordContent .discord_container');
        if (container.length) {
            const messages = container.find('.discord_message').get();
            if (messages.length > 1) {
                container.find('.discord_message').detach();
                messages.reverse().forEach(el => container.append(el));
            }
        }

        // Scroll to show the newest message at the correct end
        const dcEl = document.getElementById('discordContent');
        if (dcEl) {
            if (settings.messageOrder === 'newest-first') {
                dcEl.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                dcEl.scrollTo({ top: dcEl.scrollHeight, behavior: 'smooth' });
            }
        }

        // Mirror to floating panel if open
        if (floatingPanelOpen && popoutDiscordContent) {
            const floatContainer = jQuery('#ec_float_content .discord_container');
            if (floatContainer.length) {
                const floatMessages = floatContainer.find('.discord_message').get();
                if (floatMessages.length > 1) {
                    floatContainer.find('.discord_message').detach();
                    floatMessages.reverse().forEach(el => floatContainer.append(el));
                }
            }
            if (settings.messageOrder === 'newest-first') {
                popoutDiscordContent.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                popoutDiscordContent.scrollTo({ top: popoutDiscordContent.scrollHeight, behavior: 'smooth' });
            }
        }
    }

    function formatMessage(username, content, isUser = false) {
        // Use DOMPurify from SillyTavern's shared libraries
        const { DOMPurify } = SillyTavern.libs;

        let color;
        if (isUser) {
            // Use the user's configured avatar color (CSS variable set on body)
            color = settings.chatAvatarColor || '#3b82f6';
        } else {
            let hash = 0;
            for (let i = 0; i < username.length; i++) {
                hash = username.charCodeAt(i) + ((hash << 5) - hash);
            }
            color = `hsl(${Math.abs(hash) % 360}, 75%, 70%)`;
        }
        const now = new Date();
        const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Sanitize both username and content using DOMPurify
        const safeUsername = DOMPurify.sanitize(username, { ALLOWED_TAGS: [] });
        const safeContent = DOMPurify.sanitize(content, { ALLOWED_TAGS: [] });

        // Apply markdown-style formatting after sanitization
        const formattedContent = safeContent
            .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/__(.*?)__/g, '<u>$1</u>')
            .replace(/_(.*?)_/g, '<em>$1</em>')
            .replace(/~~(.*?)~~/g, '<del>$1</del>')
            .replace(/`(.+?)`/g, '<code>$1</code>');

        const userClass = isUser ? ' ec_user_message' : '';

        return `
        <div class="discord_message${userClass}">
            <div class="discord_avatar" style="background-color: ${color};">${safeUsername.substring(0, 1).toUpperCase()}</div>
            <div class="discord_body">
                <div class="discord_header">
                    <span class="discord_username" style="color: ${color};">${safeUsername}</span>
                    <span class="discord_timestamp">${time}</span>
                </div>
                <div class="discord_content">${formattedContent}</div>
            </div>
        </div>`;
    }

    function onChatEvent(clear, autoGenerate = true) {
        if (clear) {
            setDiscordText('');
            clearCachedCommentary();
            stopLivestream();
        }
        // Cancel any pending generation
        if (abortController) abortController.abort();
        clearTimeout(debounceTimeout);

        // Only auto-generate if triggered by a new message, not by loading a chat
        if (autoGenerate) {
            if (settings.livestream && settings.livestreamMode === 'onMessage') {
                // New ST turn always triggers a fresh EchoChamber batch.
                // generateDiscordChat → startLivestream will call stopLivestream() first,
                // cleanly interrupting any in-progress drip and replacing it with new content.
                generateDebounced();
            } else if (!settings.livestream) {
                // Regular mode
                generateDebounced();
            }
            // If livestream is in onComplete mode, it handles its own generation cycle
        } else {
            // When loading a chat, restore cached commentary
            stopLivestream();
            restoreCachedCommentary();
        }
    }

    // ============================================================
    // METADATA MANAGEMENT FOR PERSISTENCE
    // ============================================================

    function getChatMetadata() {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;
        if (!chatId) return null;

        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = {};
        }
        if (!context.extensionSettings[MODULE_NAME].chatMetadata) {
            context.extensionSettings[MODULE_NAME].chatMetadata = {};
        }

        return context.extensionSettings[MODULE_NAME].chatMetadata[chatId] || null;
    }

    function saveChatMetadata(data) {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;
        if (!chatId) {
            log('Cannot save metadata: no chatId');
            return;
        }

        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = {};
        }
        if (!context.extensionSettings[MODULE_NAME].chatMetadata) {
            context.extensionSettings[MODULE_NAME].chatMetadata = {};
        }

        context.extensionSettings[MODULE_NAME].chatMetadata[chatId] = data;
        log('Saved metadata for chatId:', chatId, 'data keys:', Object.keys(data));
        context.saveSettingsDebounced();
    }

    function clearCachedCommentary() {
        saveChatMetadata(null);
        log('Cleared cached commentary for current chat');
    }

    function restoreCachedCommentary() {
        const metadata = getChatMetadata();
        log('Attempting to restore cached commentary, metadata:', metadata);

        if (!metadata) {
            setDiscordText('');
            log('No cached commentary found');
            return;
        }

        // Check if we need to resume a livestream that was interrupted
        if (settings.livestream && metadata.fullGeneratedHtml && !metadata.livestreamComplete) {
            // Livestream was in progress - figure out what's been shown vs what's remaining
            const fullMessages = parseLivestreamMessages(metadata.fullGeneratedHtml);
            const displayedHtml = metadata.generatedHtml || '';
            const displayedMessages = displayedHtml ? parseLivestreamMessages(displayedHtml) : [];

            log('Livestream restore check: full messages:', fullMessages.length, 'displayed:', displayedMessages.length);

            if (fullMessages.length > displayedMessages.length) {
                // There are remaining messages to show
                // First, display what was already shown (if any)
                if (displayedHtml) {
                    setDiscordText(displayedHtml);
                }

                // Calculate remaining messages (they're at the end of fullMessages since we prepend)
                // Messages are prepended, so displayed ones are at the start of the container
                // We need to find which ones from fullMessages haven't been shown yet
                const remainingCount = fullMessages.length - displayedMessages.length;
                const remainingMessages = fullMessages.slice(0, remainingCount); // First N are the ones not yet shown

                log('Resuming livestream with', remainingMessages.length, 'remaining messages');

                // Resume the livestream with remaining messages
                livestreamQueue = remainingMessages;
                livestreamActive = true;

                // Start displaying remaining messages
                displayNextLivestreamMessage();
                return;
            }
        }

        // Normal restore - either not livestream mode, or livestream was complete, or no fullGeneratedHtml
        if (metadata.generatedHtml) {
            setDiscordText(metadata.generatedHtml);
            log('Restored cached commentary from metadata, length:', metadata.generatedHtml.length);
        } else if (metadata.fullGeneratedHtml) {
            // Livestream complete but generatedHtml not set - use full
            setDiscordText(metadata.fullGeneratedHtml);
            log('Restored from fullGeneratedHtml, length:', metadata.fullGeneratedHtml.length);
        } else {
            setDiscordText('');
            log('No commentary to restore');
        }
    }

    function getActiveCharacters(includeDisabled = false) {
        const context = SillyTavern.getContext();

        // Check if we're in a group chat
        if (context.groupId && context.groups) {
            const group = context.groups.find(g => g.id === context.groupId);
            if (group && group.members) {
                const characters = group.members
                    .map(memberId => context.characters.find(c => c.avatar === memberId))
                    .filter(char => char !== undefined);

                if (includeDisabled) {
                    return characters;
                }

                // Filter out disabled characters
                return characters.filter(char => !group.disabled_members?.includes(char.avatar));
            }
        }

        // Single character chat - return character at current index
        if (context.characterId !== undefined && context.characters[context.characterId]) {
            return [context.characters[context.characterId]];
        }

        return [];
    }

    // ============================================================
    // CHARACTER NAME SNAPPING (prevents hallucinated surnames)
    // ============================================================

    /**
     * Snaps a generated username to a known canonical character name.
     * Resolution order: exact → case-insensitive exact → first-name-only match.
     * Returns the canonical name if a match is found, otherwise the original name.
     */
    function snapToKnownCharacters(name, knownNames) {
        if (!knownNames || knownNames.length === 0) return name;
        const nameTrimmed = name.trim();
        const nameLower = nameTrimmed.toLowerCase();

        // 1. Exact match
        if (knownNames.includes(nameTrimmed)) return nameTrimmed;

        // 2. Case-insensitive exact match
        const caseMatch = knownNames.find(n => n.toLowerCase() === nameLower);
        if (caseMatch) return caseMatch;

        // 3. First-name match — model often gets first name right but hallucinates the surname
        const generatedFirst = nameLower.split(/\s+/)[0];
        const firstNameMatch = knownNames.find(n => n.toLowerCase().split(/\s+/)[0] === generatedFirst);
        if (firstNameMatch) return firstNameMatch;

        return null; // No match — unknown character, caller should discard this message
    }

    /**
     * Returns the list of canonical character names to use for post-processing name snapping,
     * or null if snapping should not apply (e.g. Story style in a single-char chat where
     * the card name is a world/story title rather than a speaking character).
     */
    function getKnownCharactersForSnap() {
        if (settings.style !== 'sillytavern' && settings.style !== 'sillytavern_story') return null;
        const ctx = SillyTavern.getContext();
        const chars = getActiveCharacters();

        if (settings.style === 'sillytavern') {
            if (chars.length > 0) return chars.map(c => c.name);
            const fallback = ctx.characterName || ctx.name2;
            return fallback ? [fallback] : null;
        }

        if (settings.style === 'sillytavern_story') {
            // Group chat: we know the cast — snap is safe
            if (ctx.groupId && chars.length > 0) return chars.map(c => c.name);
            // Single-char chat: card name is the story title, cast inferred from content — cannot snap
            return null;
        }

        return null;
    }

    // ============================================================
    // LIVESTREAM FUNCTIONS
    // ============================================================

    function stopLivestream() {
        if (livestreamTimer || livestreamQueue.length > 0) {
            console.warn(`[EchoChamber] stopLivestream called! Queue had ${livestreamQueue.length} messages remaining. Caller:`, new Error().stack?.split('\n')[2]?.trim());
        }
        if (livestreamTimer) {
            clearTimeout(livestreamTimer);
            livestreamTimer = null;
        }
        livestreamQueue = [];
        livestreamActive = false;
        log('Livestream stopped');
    }

    // Pauses the livestream ticker without clearing the queue — safe to resume from
    function pauseLivestream() {
        if (livestreamTimer) {
            clearTimeout(livestreamTimer);
            livestreamTimer = null;
        }
    }

    // Resumes the livestream ticker if messages remain in the queue
    function resumeLivestream() {
        if (livestreamActive && livestreamQueue.length > 0) {
            const minWait = (settings.livestreamMinWait || 5) * 1000;
            const maxWait = (settings.livestreamMaxWait || 60) * 1000;
            const delay = Math.random() * (maxWait - minWait) + minWait;
            log('Resuming livestream after reply. Next message in', (delay / 1000).toFixed(1), 's. Queue:', livestreamQueue.length);
            livestreamTimer = setTimeout(() => displayNextLivestreamMessage(), delay);
        }
    }

    function startLivestream(messages) {
        stopLivestream(); // Clear any existing livestream

        if (!messages || messages.length === 0) {
            log('No messages to livestream');
            return;
        }

        livestreamQueue = [...messages];
        livestreamActive = true;

        log('Starting livestream with', livestreamQueue.length, 'messages');

        // Display first message immediately
        displayNextLivestreamMessage();
    }

    function displayNextLivestreamMessage() {
        if (livestreamQueue.length === 0) {
            livestreamActive = false;
            console.warn('[EchoChamber] Livestream completed - all messages displayed');
            log('Livestream completed');

            // Mark livestream as complete in metadata
            const metadata = getChatMetadata();
            if (metadata) {
                metadata.livestreamComplete = true;
                saveChatMetadata(metadata);
            }

            // If in onComplete mode, trigger next batch generation
            if (settings.livestream && settings.livestreamMode === 'onComplete') {
                log('Livestream onComplete mode: triggering next batch');
                generateDebounced();
            }
            return;
        }

        try {
            const message = livestreamQueue.shift();
            console.warn(`[EchoChamber] Displaying livestream message. Remaining in queue: ${livestreamQueue.length}`);

            // Get or create the container
            let container = discordContent ? discordContent.find('.discord_container') : null;

            if (!container || !container.length) {
                // No container exists yet — create a fresh empty one.
                // Do NOT wrap existing panel content: it belongs to a previous turn
                // and wrapping it would cause stale messages to appear alongside new ones.
                discordContent.html('<div class="discord_container" style="padding-top: 10px;"></div>');
                container = discordContent.find('.discord_container');
            }

            // Remove animation class from existing messages first
            container.find('.ec_livestream_message, .ec_livestream_message_bottom').removeClass('ec_livestream_message ec_livestream_message_bottom');

            // Create and insert new message — prepend for newest-first, append for oldest-first
            const isNewestFirst = settings.messageOrder === 'newest-first';
            const lsAnimClass = isNewestFirst ? 'ec_livestream_message' : 'ec_livestream_message_bottom';
            const tempWrapper = jQuery(`<div class="${lsAnimClass}"></div>`).append(jQuery(message));
            if (isNewestFirst) {
                container.prepend(tempWrapper);
                // Scroll to top so the newest message is visible (when auto-scroll is on).
                // rAF is sufficient here — top:0 is a fixed target, not layout-dependent.
                if (settings.livestreamAutoScroll !== false && discordContent && discordContent[0]) {
                    requestAnimationFrame(() => discordContent[0].scrollTo({ top: 0, behavior: 'smooth' }));
                }
            } else {
                container.append(tempWrapper);
                // Scroll to bottom after the slide-in animation completes (300ms).
                // Reading scrollHeight before then gives 0 because max-height starts at 0.
                if (settings.livestreamAutoScroll !== false && discordContent && discordContent[0]) {
                    const el = discordContent[0];
                    setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 310);
                }
            }

            // Sync to floating panel if open
            if (floatingPanelOpen && popoutDiscordContent) {
                try {
                    let popoutContainer = popoutDiscordContent.querySelector('.discord_container');
                    if (!popoutContainer) {
                        // Create container in popout too
                        const wrapper = document.createElement('div');
                        wrapper.className = 'discord_container';
                        wrapper.style.paddingTop = '10px';
                        wrapper.innerHTML = popoutDiscordContent.innerHTML;
                        popoutDiscordContent.innerHTML = '';
                        popoutDiscordContent.appendChild(wrapper);
                        popoutContainer = wrapper;
                    }

                    // Remove animation class from popout messages
                    popoutContainer.querySelectorAll('.ec_livestream_message, .ec_livestream_message_bottom').forEach(el => {
                        el.classList.remove('ec_livestream_message', 'ec_livestream_message_bottom');
                    });

                    // Create clone for popout — mirror same insert direction as main panel
                    const isNewestFirstPop = settings.messageOrder === 'newest-first';
                    const popAnimClass = isNewestFirstPop ? 'ec_livestream_message' : 'ec_livestream_message_bottom';
                    const popoutWrapper = document.createElement('div');
                    popoutWrapper.className = popAnimClass;
                    popoutWrapper.innerHTML = message;
                    if (isNewestFirstPop) {
                        popoutContainer.insertBefore(popoutWrapper, popoutContainer.firstChild);
                        // Scroll to top for newest-first (when auto-scroll is on)
                        if (settings.livestreamAutoScroll !== false) {
                            requestAnimationFrame(() => popoutDiscordContent.scrollTo({ top: 0, behavior: 'smooth' }));
                        }
                    } else {
                        popoutContainer.appendChild(popoutWrapper);
                        // Scroll to bottom after animation completes (when auto-scroll is on)
                        if (settings.livestreamAutoScroll !== false) {
                            setTimeout(() => popoutDiscordContent.scrollTo({ top: popoutDiscordContent.scrollHeight, behavior: 'smooth' }), 310);
                        }
                    }
                } catch (popoutErr) {
                    // Ignore popout errors, don't let them break the livestream
                    log('Popout sync error (ignored):', popoutErr);
                }
            }

            // Update saved HTML with current displayed state (don't let this break livestream)
            try {
                const currentDisplayedHtml = discordContent.html();
                const metadata = getChatMetadata();
                if (metadata) {
                    metadata.generatedHtml = currentDisplayedHtml;
                    // Keep fullGeneratedHtml and livestreamComplete status
                    saveChatMetadata(metadata);
                }
            } catch (metaErr) {
                log('Metadata save error (ignored):', metaErr);
            }

        } catch (err) {
            error('Error displaying livestream message:', err);
            // Continue to next message even if this one failed
        }

        // Schedule next message with random delay between user-configured min/max seconds
        const minWait = (settings.livestreamMinWait || 5) * 1000;
        const maxWait = (settings.livestreamMaxWait || 60) * 1000;
        const randomValue = Math.random();
        const delay = randomValue * (maxWait - minWait) + minWait;
        log('Next livestream message in', (delay / 1000).toFixed(1), 'seconds (random:', randomValue.toFixed(3), '). Queue:', livestreamQueue.length, 'remaining');

        livestreamTimer = setTimeout(() => displayNextLivestreamMessage(), delay);
    }

    function parseLivestreamMessages(html) {
        // Parse the generated HTML to extract individual messages
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        const messages = [];
        const messageElements = tempDiv.querySelectorAll('.discord_message');

        messageElements.forEach(el => {
            messages.push(el.outerHTML);
        });

        log('Parsed', messages.length, 'messages from generated HTML');
        return messages;
    }

    // ============================================================
    // FLOATING PANEL FUNCTIONS
    // ============================================================

    /**
     * Makes a jQuery element draggable within the viewport using a designated handle.
     */
    function makeDraggable(element, handle) {
        let isDragging = false;
        let startX, startY, origLeft, origTop;

        handle[0].addEventListener('mousedown', (e) => {
            // Only drag on primary button; ignore clicks on interactive children
            if (e.button !== 0) return;
            if (e.target.closest('select, input, button, .ec_float_btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = element[0].getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const panelW = element[0].offsetWidth;
            const panelH = element[0].offsetHeight;
            const newLeft = Math.max(0, Math.min(window.innerWidth - panelW, origLeft + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - 40, origTop + dy));
            element.css({ left: newLeft + 'px', top: newTop + 'px' });
        }

        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            // Persist final position so it can be restored on next open / reload
            settings.floatLeft = parseInt(element.css('left')) || 0;
            settings.floatTop = parseInt(element.css('top')) || 0;
            saveSettings();
        }
    }

    /**
     * Attaches resize logic to all four corner handles of the floating panel.
     * Each handle element carries a data-corner attribute: nw, ne, sw, se.
     */
    function makeFloatingPanelResizable(panel) {
        panel.find('.ec_float_resize_handle').each(function () {
            const handle = this;
            const corner = handle.dataset.corner;
            let active = false;
            let startX, startY, startW, startH, startLeft, startTop;

            handle.addEventListener('mousedown', (e) => {
                active = true;
                startX = e.clientX;
                startY = e.clientY;
                startW = panel[0].offsetWidth;
                startH = panel[0].offsetHeight;
                startLeft = parseInt(panel.css('left')) || 0;
                startTop = parseInt(panel.css('top')) || 0;
                e.preventDefault();
                e.stopPropagation();
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });

            function onMove(e) {
                if (!active) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                const MIN_W = 300, MIN_H = 200;
                const MAX_W = window.innerWidth - 20;
                const MAX_H = window.innerHeight - 20;

                let newW = startW, newH = startH, newL = startLeft, newT = startTop;

                if (corner === 'se') {
                    newW = Math.max(MIN_W, Math.min(MAX_W, startW + dx));
                    newH = Math.max(MIN_H, Math.min(MAX_H, startH + dy));
                } else if (corner === 'sw') {
                    newW = Math.max(MIN_W, Math.min(MAX_W, startW - dx));
                    newH = Math.max(MIN_H, Math.min(MAX_H, startH + dy));
                    newL = startLeft + (startW - newW);
                } else if (corner === 'ne') {
                    newW = Math.max(MIN_W, Math.min(MAX_W, startW + dx));
                    newH = Math.max(MIN_H, Math.min(MAX_H, startH - dy));
                    newT = startTop + (startH - newH);
                } else if (corner === 'nw') {
                    newW = Math.max(MIN_W, Math.min(MAX_W, startW - dx));
                    newH = Math.max(MIN_H, Math.min(MAX_H, startH - dy));
                    newL = startLeft + (startW - newW);
                    newT = startTop + (startH - newH);
                }

                panel.css({
                    width: newW + 'px', height: newH + 'px',
                    left: newL + 'px', top: newT + 'px'
                });
            }

            function onUp() {
                if (!active) return;
                active = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                // Persist final size and position so they can be restored on next open / reload
                settings.floatLeft = parseInt(panel.css('left')) || 0;
                settings.floatTop = parseInt(panel.css('top')) || 0;
                settings.floatWidth = parseInt(panel.css('width')) || 420;
                settings.floatHeight = parseInt(panel.css('height')) || 620;
                saveSettings();
            }
        });
    }

    /**
     * Opens the in-page floating EchoChamber panel.
     * Lives in the same document as ST so all CSS variables, dynamic styles,
     * and DOM references work without any cross-window plumbing.
     */
    function openPopoutWindow() {
        // If panel is already open, bring it to the front
        if (floatingPanelOpen && jQuery('#ec_floating_panel').length) {
            jQuery('#ec_floating_panel').css('z-index', 9999);
            return;
        }

        const currentContent = discordContent ? discordContent.html() : '';

        const chatInputHtml = settings.chatEnabled ? `
            <div class="ec_reply_container ec_float_reply_bar" id="ec_float_reply_bar">
                <div class="ec_reply_wrapper">
                    <input type="search" class="ec_reply_input" placeholder="Type a message to participate..." id="ec_float_reply_field" autocomplete="off">
                    <div class="ec_reply_send" id="ec_float_reply_submit" title="Send message"><i class="fa-solid fa-paper-plane"></i></div>
                </div>
            </div>` : '';

        const panelHtml = `
        <div id="ec_floating_panel" class="ec_floating_panel">

            <!-- Row 1: drag handle — title, live indicator, dock button -->
            <div class="ec_float_header" id="ec_float_drag_handle">
                <div class="ec_float_header_left">
                    <span class="ec_float_title">EchoChamber</span>
                    <div class="ec_live_indicator" id="ec_float_live_indicator">
                        <i class="fa-solid fa-circle"></i> LIVE
                    </div>
                </div>
                <div class="ec_float_header_right">
                    <div class="ec_float_btn" id="ec_float_dock_btn" title="Dock — close floating panel">
                        <i class="fa-solid fa-arrow-up-right-from-square" style="transform:rotate(180deg)"></i>
                    </div>
                </div>
            </div>

            <!-- Row 2: toolbar — style selector left (50%), icon buttons right (50%) -->
            <div class="ec_float_toolbar">
                <div class="ec_float_toolbar_left">
                    <div class="ec_btn ec_float_style_btn" id="ec_float_style_indicator" title="Change Style">
                        <i class="fa-solid fa-masks-theater"></i>
                        <span class="ec_float_style_label">Style</span>
                        <i class="fa-solid fa-caret-down ec_dropdown_arrow"></i>
                        <div class="ec_popup_menu ec_style_menu ec_float_style_menu"></div>
                    </div>
                </div>
                <div class="ec_float_toolbar_right">
                    <div class="ec_btn ec_float_tool" title="Regenerate Chat">
                        <i class="fa-solid fa-rotate-right"></i>
                    </div>
                    <div class="ec_btn ec_float_tool" title="User Count">
                        <i class="fa-solid fa-users"></i>
                        <div class="ec_popup_menu ec_user_menu"></div>
                    </div>
                    <div class="ec_btn ec_float_tool" title="Font Size">
                        <i class="fa-solid fa-font"></i>
                        <div class="ec_popup_menu ec_font_menu"></div>
                    </div>
                    <div class="ec_btn ec_float_tool" title="Clear Chat &amp; Cache">
                        <i class="fa-solid fa-trash-can"></i>
                    </div>
                    <div class="ec_btn ec_float_tool" title="Settings">
                        <i class="fa-solid fa-gear"></i>
                    </div>
                </div>
            </div>

            <!-- Chat content and overlay -->
            <div id="ec_float_status_overlay" class="ec_status_overlay"></div>
            <div id="ec_float_content" class="ec_float_content">${currentContent}</div>

            ${chatInputHtml}

            <!-- Four-corner resize handles -->
            <div class="ec_float_resize_handle" data-corner="nw"></div>
            <div class="ec_float_resize_handle" data-corner="ne"></div>
            <div class="ec_float_resize_handle" data-corner="sw"></div>
            <div class="ec_float_resize_handle" data-corner="se"></div>
        </div>`;

        jQuery('body').append(panelHtml);

        const panel = jQuery('#ec_floating_panel');

        // Position and size panel — restore saved values, or fall back to defaults
        const panelW = settings.floatWidth || 420;
        const panelH = settings.floatHeight || 620;
        const defaultLeft = Math.max(20, window.innerWidth - panelW - 24);
        const defaultTop = 60;
        // Clamp restored position so the panel stays fully on-screen even after a viewport resize
        const restoredLeft = settings.floatLeft != null ? settings.floatLeft : defaultLeft;
        const restoredTop = settings.floatTop != null ? settings.floatTop : defaultTop;
        const startLeft = Math.max(0, Math.min(window.innerWidth - panelW, restoredLeft));
        const startTop = Math.max(0, Math.min(window.innerHeight - 40, restoredTop));
        panel.css({ left: startLeft + 'px', top: startTop + 'px', width: panelW + 'px', height: panelH + 'px' });

        // Register as the sync target for setDiscordText / displayNextLivestreamMessage
        floatingPanelOpen = true;
        popoutDiscordContent = document.getElementById('ec_float_content');

        // Persist that the floating panel is open so it can be restored after reload
        settings.floatOpen = true;
        saveSettings();

        // Attach drag and resize
        makeDraggable(panel, jQuery('#ec_float_drag_handle'));
        makeFloatingPanelResizable(panel);

        // ---- Populate toolbar popup menus ----

        // User Count menu — same items as main panel, same ec_menu_item delegation handles clicks
        const floatUserMenu = panel.find('.ec_float_toolbar .ec_user_menu');
        const currentUsers = parseInt(settings.userCount) || 5;
        for (let i = 1; i <= 20; i++) {
            floatUserMenu.append(`<div class="ec_menu_item${i === currentUsers ? ' selected' : ''}" data-val="${i}">${i} users</div>`);
        }

        // Font Size menu
        const floatFontMenu = panel.find('.ec_float_toolbar .ec_font_menu');
        const currentFont = settings.fontSize || 15;
        for (let i = 8; i <= 24; i++) {
            floatFontMenu.append(`<div class="ec_menu_item${i === currentFont ? ' selected' : ''}" data-val="${i}">${i}px</div>`);
        }

        // Style button — populate its popup menu and show the current style name
        const floatStyleMenu = jQuery('#ec_float_style_indicator .ec_float_style_menu');
        populateStyleMenu(floatStyleMenu);
        updateFloatStyleLabel();

        // ---- Float style button: use a body-appended fixed-position menu to escape overflow:hidden ----
        jQuery('#ec_float_style_menu_body').remove();
        const floatStyleMenuBody = jQuery('<div id="ec_float_style_menu_body" class="ec_popup_menu ec_style_menu ec_indicator_menu"></div>');
        jQuery('body').append(floatStyleMenuBody);
        populateStyleMenu(floatStyleMenuBody);

        jQuery('#ec_float_style_indicator').on('click.floatstyle', function (e) {
            e.stopPropagation();
            const trigger = jQuery(this);
            const wasActive = trigger.hasClass('active');

            // Close all other menus
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide().css({ top: '', bottom: '', left: '', right: '', position: '' });
            jQuery('#ec_style_menu_body').hide();
            jQuery('.ec_style_dropdown_trigger').removeClass('active');

            if (!wasActive) {
                trigger.addClass('active open');
                const rect = trigger[0].getBoundingClientRect();
                // Open downward (floating panel is not at bottom position)
                floatStyleMenuBody.css({
                    position: 'fixed',
                    top: rect.bottom + 'px',
                    bottom: 'auto',
                    left: rect.left + 'px',
                    width: Math.max(rect.width, 180) + 'px',
                    display: 'block',
                    maxHeight: Math.min(300, window.innerHeight - rect.bottom - 10) + 'px',
                    overflowY: 'auto'
                });
            } else {
                trigger.removeClass('active open');
                floatStyleMenuBody.hide();
            }
        });


        // Collapse the main panel when floating panel opens (it's now redundant)
        if (discordBar && !settings.collapsed) {
            settings.collapsed = true;
            discordBar.addClass('ec_collapsed');
            updatePanelIcons();
            saveSettings();
        }

        // Sync live indicator to current state
        updateLiveIndicator();

        // Live indicator click — mirrors main panel behaviour
        jQuery('#ec_float_live_indicator').on('click', function () {
            if (jQuery(this).hasClass('ec_live_loading')) {
                userCancelled = true;
                clearTimeout(debounceTimeout);
                if (abortController) abortController.abort();
                updateLiveIndicator();
            } else {
                toggleLivestream(!settings.livestream);
            }
        });

        // Dock / close button
        jQuery('#ec_float_dock_btn').on('click', closePopoutWindow);

        // Chat Participation
        if (settings.chatEnabled) {
            const handleFloatSubmit = async () => {
                if (isGenerating) {
                    cancelGenerationContext();
                    return;
                }
                const input = jQuery('#ec_float_reply_field');
                const text = input.val().trim();
                if (!text) return;
                input.val('');

                const myMsg = formatMessage(settings.chatUsername || 'Streamer (You)', text, true);
                const isNewestFirstFloat = settings.messageOrder === 'newest-first';

                // Insert into floating panel respecting message order
                const floatContainer = jQuery('#ec_float_content .discord_container');
                if (floatContainer.length) {
                    if (isNewestFirstFloat) floatContainer.prepend(myMsg);
                    else floatContainer.append(myMsg);
                } else {
                    jQuery('#ec_float_content').html(`<div class="discord_container">${myMsg}</div>`);
                }
                const floatEl = jQuery('#ec_float_content')[0];
                if (floatEl) {
                    if (isNewestFirstFloat) floatEl.scrollTo({ top: 0, behavior: 'smooth' });
                    else floatEl.scrollTo({ top: floatEl.scrollHeight, behavior: 'smooth' });
                }

                // Mirror to main panel so they stay in sync
                const mainContainer = jQuery('#discordContent .discord_container');
                if (mainContainer.length) {
                    if (isNewestFirstFloat) mainContainer.prepend(myMsg);
                    else mainContainer.append(myMsg);
                } else {
                    jQuery('#discordContent').html(`<div class="discord_container">${myMsg}</div>`);
                }
                const mainEl = document.getElementById('discordContent');
                if (mainEl) {
                    if (isNewestFirstFloat) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
                    else mainEl.scrollTo({ top: mainEl.scrollHeight, behavior: 'smooth' });
                }

                // Parse @mention and generate targeted reply
                const atMatch = text.match(/^@([^\s]+)/);
                await generateSingleReply(text, atMatch ? atMatch[1] : null);
            };

            jQuery('#ec_float_reply_submit').on('click', handleFloatSubmit);
            jQuery('#ec_float_reply_field').on('keypress', function (e) {
                if (e.which === 13) handleFloatSubmit();
            });

            // Clicking a username in the float panel tags them in the float input
            jQuery('#ec_float_content').on('click', '.discord_username', function () {
                jQuery('#ec_float_reply_field').val('@' + jQuery(this).text() + ' ').focus();
            });
        }

        log('Floating panel opened');
    }

    /**
     * Closes and removes the floating panel, and re-expands the main panel.
     */
    function closePopoutWindow() {
        jQuery('#ec_floating_panel').remove();
        jQuery('#ec_float_style_menu_body').remove(); // cleanup body-appended float style menu
        floatingPanelOpen = false;
        popoutDiscordContent = null;

        // Persist that the floating panel is now closed
        settings.floatOpen = false;
        saveSettings();

        // Re-expand the main panel when floating panel is docked/closed
        if (discordBar && settings.collapsed) {
            settings.collapsed = false;
            discordBar.removeClass('ec_collapsed');
            updatePanelIcons();
            saveSettings();
        }

        log('Floating panel closed');
    }

    /**
     * Updates the style label inside the floating panel's style button.
     * Reads the current style name from settings and updates the button span text.
     * Also refreshes the body-appended fixed-position menu's selection highlight.
     */
    function updateFloatStyleLabel() {
        const floatBtn = jQuery('#ec_float_style_indicator');
        if (!floatBtn.length) return;
        const styles = getAllStyles();
        const currentStyle = styles.find(s => s.val === settings.style);
        const styleName = currentStyle ? currentStyle.label : (settings.style || 'Default');
        floatBtn.find('.ec_float_style_label').text(styleName);
        // Refresh selection highlight in the body-appended float style menu
        jQuery('#ec_float_style_menu_body .ec_menu_item').each(function () {
            jQuery(this).toggleClass('selected', jQuery(this).data('val') === settings.style);
        });
    }

    // ============================================================
    // GENERATION FUNCTIONS
    // ============================================================

    function saveGeneratedCommentary(html, messageCommentaries, fullHtml = null, livestreamComplete = true) {
        const chatId = SillyTavern.getContext().chatId;
        log('Saving generated commentary for chatId:', chatId, 'html length:', html?.length);
        const metadata = {
            generatedHtml: html,
            messageCommentaries: messageCommentaries || {},
            timestamp: Date.now(),
            livestreamComplete: livestreamComplete
        };
        // Save fullGeneratedHtml for livestream resume capability
        if (fullHtml) {
            metadata.fullGeneratedHtml = fullHtml;
        }
        saveChatMetadata(metadata);
        log('Saved generated commentary to metadata, livestreamComplete:', livestreamComplete);
    }

    // ============================================================
    // SINGLE REPLY GENERATION (targeted user interaction)
    // ============================================================

    let isReplying = false;

    async function generateSingleReply(replyText, targetUsername) {
        if (isReplying) return;
        isReplying = true;

        // Pause any active livestream so reply messages slot in cleanly without racing
        const wasLivestreaming = settings.livestream && livestreamActive;
        if (wasLivestreaming) pauseLivestream();

        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) { isReplying = false; return; }

        const cleanMessage = (text) => {
            if (!text) return '';
            // Strip all thinking/reasoning tags: thinking, think, thought, reasoning, reason
            let cleaned = text.replace(/<(thinking|think|thought|reasoning|reason)>[\s\S]*?<\/\1>/gi, '').trim();
            cleaned = cleaned.replace(/<[^>]*>/g, '');
            const txt = document.createElement("textarea");
            txt.innerHTML = cleaned;
            return txt.value;
        };

        // Build context history based on settings
        let historyMessages;

        if (settings.includeUserInput) {
            const depth = Math.max(2, Math.min(500, settings.contextDepth || 4));
            const visibleChat = chat.filter(msg => !msg.is_system);
            let startIdx = visibleChat.length - 1;

            for (let i = visibleChat.length - 1; i >= 0 && (visibleChat.length - i) <= depth; i--) { startIdx = i; }
            for (let i = startIdx; i >= 0; i--) {
                if (visibleChat[i].is_user) { startIdx = i; break; }
            }

            historyMessages = visibleChat.slice(startIdx);
            if (historyMessages.length > depth) historyMessages = historyMessages.slice(-depth);
        } else {
            const visibleChat = chat.filter(msg => !msg.is_system);
            historyMessages = visibleChat.slice(-1);
        }

        const metadata = getChatMetadata();
        const messageCommentaries = (metadata && metadata.messageCommentaries) || {};

        // Extract recent EchoChamber conversation from the DOM for conversational continuity.
        // oldest-first: newest messages are at the BOTTOM — read last 8, already chronological.
        // newest-first: newest messages are at the TOP — read first 8, then reverse to chronological.
        const ecMessages = [];
        const allDomMsgs = jQuery('#discordContent .discord_message');
        const isNewestFirstCtx = settings.messageOrder === 'newest-first';
        const recentDomMsgs = isNewestFirstCtx ? allDomMsgs.slice(0, 8) : allDomMsgs.slice(-8);
        recentDomMsgs.each(function () {
            const uname = jQuery(this).find('.discord_username').first().text().trim();
            const content = jQuery(this).find('.discord_content').first().text().trim();
            if (uname && content) ecMessages.push(`${uname}: ${content}`);
        });
        // ecHistory must be in chronological order (oldest first) for the prompt.
        // newest-first DOM order is newest→oldest so reverse; oldest-first is already chronological.
        const ecHistory = isNewestFirstCtx ? ecMessages.reverse().join('\n') : ecMessages.join('\n');

        const stylePrompt = await loadChatStyle(settings.style || 'twitch');
        const chatUsername = settings.chatUsername || 'Streamer (You)';
        const atUsername = `@${chatUsername}`;
        const replyCount = Math.max(1, Math.min(12, settings.chatReplyCount || 3));
        const baseMaxTok = targetUsername ? 200 : Math.max(200, replyCount * 80);
        const maxTok = settings.chatOverrideTokens ? (settings.chatMaxTokens || 3000) : baseMaxTok;

        let additionalSystemContext = '';
        const systemContextParts = [];

        if (settings.includePersona) {
            const personaName = context.name1 || 'User';
            // Resolve macro here so Ollama/OpenAI/Profile sources receive the actual
            // text, not the literal '{{persona}}' token which they cannot substitute.
            const personaText = resolveSTMacro(context, '{{persona}}');
            if (personaText.trim()) {
                systemContextParts.push(`<user_persona name="${personaName}">\n${personaText}\n</user_persona>`);
            }
        }

        if (settings.includeAuthorsNote) {
            const anText = resolveSTMacro(context, '{{authorsNote}}');
            if (anText.trim()) {
                systemContextParts.push(`<authors_note>\n${anText}\n</authors_note>`);
            }
        }

        if (settings.includeCharacterDescription) {
            const activeCharacters = getActiveCharacters();
            if (activeCharacters.length > 0) {
                const charDescriptions = activeCharacters
                    .filter(char => char.description)
                    .map(char => `<character name="${char.name}">\n${char.description}\n</character>`)
                    .join('\n\n');
                if (charDescriptions) systemContextParts.push(charDescriptions);
            }
        }

        if (settings.includeSummary) {
            try {
                const memorySettings = context.extensionSettings?.memory;
                if (memorySettings) {
                    const chatWithSummary = context.chat?.slice().reverse().find(m => m.extra?.memory);
                    if (chatWithSummary?.extra?.memory) {
                        systemContextParts.push(`<summary>\n${chatWithSummary.extra.memory}\n</summary>`);
                    }
                }
            } catch (e) { log('Could not get summary:', e); }
        }

        if (settings.includeWorldInfo) {
            try {
                const getWorldInfoFn = context.getWorldInfoPrompt || (typeof window !== 'undefined' && window.getWorldInfoPrompt);
                const currentChat = context.chat || chat;
                if (typeof getWorldInfoFn === 'function' && currentChat && currentChat.length > 0) {
                    const chatForWI = currentChat.map(x => x.mes || x.message || x).filter(m => m && typeof m === 'string');
                    const wiBudgetValue = (settings.wiBudget && settings.wiBudget > 0) ? settings.wiBudget : Number.MAX_SAFE_INTEGER;
                    const result = await getWorldInfoFn(chatForWI, wiBudgetValue, false);
                    const worldInfoString = result?.worldInfoString || result;
                    if (worldInfoString && typeof worldInfoString === 'string' && worldInfoString.trim()) {
                        systemContextParts.push(`<world_info>\n${worldInfoString.trim()}\n</world_info>`);
                    }
                } else if (context.activatedWorldInfo && Array.isArray(context.activatedWorldInfo) && context.activatedWorldInfo.length > 0) {
                    const worldInfoContent = context.activatedWorldInfo.filter(entry => entry && entry.content).map(entry => entry.content).join('\n\n');
                    if (worldInfoContent.trim()) systemContextParts.push(`<world_info>\n${worldInfoContent.trim()}\n</world_info>`);
                }
            } catch (e) { log('Error getting world info:', e); }
        }

        if (systemContextParts.length > 0) {
            additionalSystemContext = '\n\n<lore>\n' + systemContextParts.join('\n\n') + '\n</lore>';
        }

        const isSillyTavernStyle = settings.style === 'sillytavern' || settings.style === 'sillytavern_story';
        const systemMessage = targetUsername
            ? (isSillyTavernStyle
                ? `<role>\nYou are "${targetUsername}", a character from this SillyTavern roleplay/story. ${atUsername} has just spoken directly to you. Respond fully in character — use your established voice, personality, relationships, and knowledge from the story. Respond naturally in 1–2 sentences max. STRICTLY follow the provided chat style format.\n</role>${additionalSystemContext}\n\n<chat_history>`
                : `<role>\nYou are "${targetUsername}", a viewer in an active chatroom who was just directly addressed. Focus tightly on what "${atUsername}" just said to you — that is the primary context. Respond naturally in 1 sentence max. Use "${atUsername}" when addressing them. STRICTLY follow the provided chat style format.\n</role>${additionalSystemContext}\n\n<chat_history>`)
            : (isSillyTavernStyle
                ? `<role>\nYou voice the characters from this SillyTavern roleplay/story as they react in character to what ${atUsername} just said. Each character responds with their own voice, personality, and perspective. Keep responses brief and authentic. STRICTLY follow the provided chat style format.\n</role>${additionalSystemContext}\n\n<chat_history>`
                : `<role>\nYou write short chatroom messages from different viewers reacting to "${atUsername}" (the streamer) and the ongoing conversation. Focus on the most recent exchange. Keep messages brief and casual. STRICTLY follow the provided chat style format.\n</role>${additionalSystemContext}\n\n<chat_history>`);

        const chatHistoryMessages = [];
        if (settings.includePastEchoChambers && metadata && metadata.messageCommentaries) {
            for (let i = 0; i < historyMessages.length; i++) {
                const msg = historyMessages[i];
                const msgIndex = chat.indexOf(msg);
                const role = msg.is_user ? 'user' : 'assistant';
                let content = cleanMessage(msg.mes);
                if (messageCommentaries[msgIndex]) content += `\n\n[Previous EchoChamber commentary: ${messageCommentaries[msgIndex]}]`;
                chatHistoryMessages.push({ role, content });
            }
        } else {
            for (const msg of historyMessages) {
                const role = msg.is_user ? 'user' : 'assistant';
                const content = cleanMessage(msg.mes);
                chatHistoryMessages.push({ role, content });
            }
        }

        const userPrompt = targetUsername
            ? `</chat_history>\n\n<recent_chatroom_history>\n${ecHistory}\n</recent_chatroom_history>\n\n<streamer_reply>\n"${atUsername}" just said to you: "${replyText}"\n</streamer_reply>\n\n<instructions>\nChat style format:\n${stylePrompt}\n\nWrite EXACTLY 1 short reply from "${targetUsername}" reacting to what "${atUsername}" just said. Your reply MUST begin by addressing them as "${atUsername}". No other chatters.\n\nFormat (follow exactly):\n${targetUsername}: ${atUsername} [your reply here]\n\nOutput only that single line.\n</instructions>`
            : `</chat_history>\n\n<recent_chatroom_history>\n${ecHistory}\n</recent_chatroom_history>\n\n<streamer_reply>\n"${atUsername}" posted: "${replyText}"\n</streamer_reply>\n\n<instructions>\nChat style format:\n${stylePrompt}\n\nWrite EXACTLY ${replyCount} short repl${replyCount === 1 ? 'y' : 'ies'} from different chatters reacting to the MOST RECENT context above. Some may address "${atUsername}" directly using "${atUsername}".\n\nFormat:\nusername: message\n\nOutput only the messages, nothing else.\n</instructions>`;

        abortController = new AbortController();
        userCancelled = false;
        isGenerating = true;
        updateReplyButtonState(true);

        const typingName = targetUsername || 'Chat';
        // In Livestream mode: use the LIVE indicator turning orange instead of a status popup
        if (settings.livestream) {
            updateLiveIndicator('loading');
        } else {
            setStatus(`<span><i class="fa-solid fa-circle-notch fa-spin"></i> ${typingName} is typing...</span>`);
        }

        const messagesPayload = [{ role: 'system', content: systemMessage }, ...chatHistoryMessages, { role: 'user', content: userPrompt }];

        try {
            let result = '';

            if (settings.source === 'ollama') {
                const baseUrl = settings.url.replace(/\/$/, '');
                const modelToUse = settings.model;
                if (!modelToUse) { setStatus(''); isReplying = false; return; }
                const resp = await fetch(`${baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelToUse,
                        messages: messagesPayload,
                        stream: false,
                        options: { num_ctx: context.main?.context_size || 4096, num_predict: maxTok }
                    }),
                    signal: abortController.signal
                });
                if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
                const data = await resp.json();
                result = data.message?.content || data.response || '';

            } else if (settings.source === 'openai') {
                const baseUrl = settings.openai_url.replace(/\/$/, '');
                const resp = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(settings.openai_key ? { 'Authorization': `Bearer ${settings.openai_key}` } : {})
                    },
                    body: JSON.stringify({
                        model: settings.openai_model || 'local-model',
                        messages: messagesPayload,
                        temperature: 0.85,
                        max_tokens: maxTok,
                        stream: false
                    }),
                    signal: abortController.signal
                });
                if (!resp.ok) throw new Error(`OpenAI error: ${resp.status}`);
                const data = await resp.json();
                result = extractTextFromResponse(data);

            } else if (settings.source === 'profile') {
                const cm = context.extensionSettings?.connectionManager;
                // settings.preset stores profile ID; fall back to name match for older saved settings
                const profile = cm?.profiles?.find(p => p.id === settings.preset) || cm?.profiles?.find(p => p.name === settings.preset);
                if (!profile || !context.ConnectionManagerRequestService) throw new Error('Profile not available');
                const resp = await context.ConnectionManagerRequestService.sendRequest(
                    profile.id,
                    messagesPayload,
                    maxTok,
                    { stream: false, signal: abortController.signal, extractData: true, includePreset: true, includeInstruct: true }
                );
                result = extractTextFromResponse(resp);

            } else {
                // Default ST generateRaw
                const { generateRaw } = context;
                if (generateRaw) {
                    result = await generateRaw({
                        prompt: messagesPayload,
                        quietToLoud: false
                    });
                }
            }

            setStatus('');
            if (!result || !result.trim()) { isReplying = false; return; }

            // Parse "username: message" lines and insert into existing chat
            const lines = result.trim().split('\n').filter(l => l.trim() && l.includes(':'));
            const container = jQuery('#discordContent .discord_container');
            const isNewestFirst = settings.messageOrder === 'newest-first';

            // Snap generated names to canonical character names to prevent hallucinated surnames
            const replyKnownChars = getKnownCharactersForSnap();

            if (isNewestFirst) {
                // newest-first: AI replies are newer than the user's message, so prepend
                // above it in forward order — last reply ends up at the very top.
                lines.forEach(line => {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx < 1) return;
                    let uname = line.substring(0, colonIdx).trim();
                    const content = line.substring(colonIdx + 1).trim();
                    if (!uname || !content) return;
                    if (replyKnownChars) {
                        uname = snapToKnownCharacters(uname, replyKnownChars);
                        if (!uname) return;
                    }
                    const msgHtml = formatMessage(uname, content);
                    if (container.length) {
                        container.prepend(msgHtml);
                    } else {
                        jQuery('#discordContent').html(`<div class="discord_container">${msgHtml}</div>`);
                    }
                });
            } else {
                // oldest-first: append in forward order so replies land at the bottom
                lines.forEach(line => {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx < 1) return;
                    let uname = line.substring(0, colonIdx).trim();
                    const content = line.substring(colonIdx + 1).trim();
                    if (!uname || !content) return;
                    if (replyKnownChars) {
                        uname = snapToKnownCharacters(uname, replyKnownChars);
                        if (!uname) return;
                    }
                    const msgHtml = formatMessage(uname, content);
                    if (container.length) {
                        container.append(msgHtml);
                    } else {
                        jQuery('#discordContent').html(`<div class="discord_container">${msgHtml}</div>`);
                    }
                });
            }

            // Scroll to show newest message
            const dcEl = document.getElementById('discordContent');
            if (dcEl) {
                if (isNewestFirst) dcEl.scrollTo({ top: 0, behavior: 'smooth' });
                else dcEl.scrollTo({ top: dcEl.scrollHeight, behavior: 'smooth' });
            }

            // Mirror AI replies into the floating panel if it is open
            if (floatingPanelOpen && popoutDiscordContent) {
                const floatContainer = jQuery('#ec_float_content .discord_container');
                if (isNewestFirst) {
                    lines.forEach(line => {
                        const colonIdx = line.indexOf(':');
                        if (colonIdx < 1) return;
                        let uname = line.substring(0, colonIdx).trim();
                        const content = line.substring(colonIdx + 1).trim();
                        if (!uname || !content) return;
                        if (replyKnownChars) {
                            uname = snapToKnownCharacters(uname, replyKnownChars);
                            if (!uname) return;
                        }
                        const msgHtml = formatMessage(uname, content);
                        if (floatContainer.length) {
                            floatContainer.prepend(msgHtml);
                        } else {
                            jQuery('#ec_float_content').html(`<div class="discord_container">${msgHtml}</div>`);
                        }
                    });
                } else {
                    lines.forEach(line => {
                        const colonIdx = line.indexOf(':');
                        if (colonIdx < 1) return;
                        let uname = line.substring(0, colonIdx).trim();
                        const content = line.substring(colonIdx + 1).trim();
                        if (!uname || !content) return;
                        if (replyKnownChars) {
                            uname = snapToKnownCharacters(uname, replyKnownChars);
                            if (!uname) return;
                        }
                        const msgHtml = formatMessage(uname, content);
                        if (floatContainer.length) {
                            floatContainer.append(msgHtml);
                        } else {
                            jQuery('#ec_float_content').html(`<div class="discord_container">${msgHtml}</div>`);
                        }
                    });
                }
                const floatEl = jQuery('#ec_float_content')[0];
                if (floatEl) {
                    if (isNewestFirst) floatEl.scrollTo({ top: 0, behavior: 'smooth' });
                    else floatEl.scrollTo({ top: floatEl.scrollHeight, behavior: 'smooth' });
                }
            }

            // Persist the updated panel HTML to the cache so it survives page refresh
            savePanelState();

        } catch (e) {
            if (e.name !== 'AbortError' && !userCancelled) error('generateSingleReply error:', e);
            setStatus('');
            if (settings.livestream) updateLiveIndicator();
        } finally {
            isReplying = false;
            isGenerating = false;
            updateReplyButtonState(false);
            // Resume the livestream ticker now that the reply exchange is complete
            if (wasLivestreaming) resumeLivestream();
            // Ensure indicator is restored after reply (whether livestream or not)
            if (settings.livestream) updateLiveIndicator();
        }
    }

    // GENERATION
    // ============================================================

    // Saves the current panel HTML to chat metadata so user replies survive reload
    function savePanelState() {
        if (!discordContent) return;
        const currentHtml = discordContent.html();
        if (!currentHtml || !currentHtml.trim()) return;
        const existing = getChatMetadata();
        const messageCommentaries = (existing && existing.messageCommentaries) || {};
        saveChatMetadata({
            generatedHtml: currentHtml,
            messageCommentaries,
            timestamp: Date.now(),
            livestreamComplete: true
        });
        log('Panel state saved after reply exchange');
    }

    async function generateDiscordChat(showOverlay = false) {
        if (!settings.enabled) {
            if (discordBar) discordBar.hide();
            return;
        }

        // If paused, don't generate but keep panel visible
        if (settings.paused) {
            return;
        }

        // If already generating, abort the previous request first
        if (isGenerating && abortController) {
            abortController.abort();
            // Wait a tiny bit for the abort to process
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        if (discordBar) discordBar.show();

        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return;

        // Mark generation as in progress
        isGenerating = true;
        updateReplyButtonState(true);

        // Create new AbortController BEFORE setting up the Cancel button
        userCancelled = false;
        abortController = new AbortController();

        // In Livestream mode (background auto-generation): suppress the Processing/Cancel popup
        // overlay — the LIVE indicator turning orange provides the visual feedback instead.
        // When triggered explicitly by the user (showOverlay=true, e.g. Regenerate Chat button),
        // always show the full overlay regardless of Livestream state.
        if (settings.livestream && !showOverlay) {
            updateLiveIndicator('loading');
        } else {
            setStatus(`
                <span><i class="fa-solid fa-circle-notch fa-spin"></i> Processing...</span>
                <div class="ec_status_btn" id="ec_cancel_btn" title="Cancel Generation">
                     <i class="fa-solid fa-ban"></i> Cancel
                </div>
            `);
        }

        // Use event delegation to ensure the handler works even if button is recreated
        jQuery(document).off('click', '#ec_cancel_btn').on('click', '#ec_cancel_btn', function (e) {
            e.preventDefault();
            e.stopPropagation();
            log('Cancel button clicked');

            // Clear debounce timeout in case generation hasn't started yet
            clearTimeout(debounceTimeout);

            if (abortController) {
                log('Aborting generation...');
                userCancelled = true;
                jQuery('#ec_cancel_btn').html('<i class="fa-solid fa-hourglass"></i> Stopping...').css('pointer-events', 'none');
                abortController.abort();
                log('AbortController.abort() called, signal.aborted:', abortController.signal.aborted);

                // Also trigger SillyTavern's built-in stop generation
                const stopButton = jQuery('#mes_stop');
                if (stopButton.length && !stopButton.is('.disabled')) {
                    log('Triggering SillyTavern stop button');
                    stopButton.trigger('click');
                }
            } else {
                log('No abortController, showing cancel message');
                // If abortController doesn't exist yet, just clear the status
                userCancelled = true;
                setStatus('');
                setDiscordText(`<div class="discord_status ec_cancelled"><i class="fa-solid fa-hand"></i> Processing cancelled</div>`);
                setTimeout(() => {
                    const cancelledMsg = jQuery('.ec_cancelled');
                    if (cancelledMsg.length) {
                        cancelledMsg.addClass('fade-out');
                        setTimeout(() => cancelledMsg.remove(), 500);
                    }
                }, 3000);
            }
        });

        const cleanMessage = (text) => {
            if (!text) return '';
            // Strip all thinking/reasoning tags: thinking, think, thought, reasoning, reason
            let cleaned = text.replace(/<(thinking|think|thought|reasoning|reason)>[\s\S]*?<\/\1>/gi, '').trim();
            cleaned = cleaned.replace(/<[^>]*>/g, '');
            const txt = document.createElement("textarea");
            txt.innerHTML = cleaned;
            return txt.value;
        };

        // Build context history based on settings
        // includeUserInput OFF: Only the last message (AI response)
        // includeUserInput ON: Use contextDepth to include multiple exchanges
        // Note: Filter out hidden messages (is_system === true)
        let historyMessages;

        if (settings.includeUserInput) {
            // Allow context depth up to 500 messages (no artificial cap)
            const depth = Math.max(2, Math.min(500, settings.contextDepth || 4));
            // Filter out hidden messages first
            const visibleChat = chat.filter(msg => !msg.is_system);

            // Find the starting user message based on depth
            let startIdx = visibleChat.length - 1;

            // Walk backwards to find how far back we need to go
            for (let i = visibleChat.length - 1; i >= 0 && (visibleChat.length - i) <= depth; i--) {
                startIdx = i;
            }

            // Now find the nearest user message at or before startIdx
            for (let i = startIdx; i >= 0; i--) {
                if (visibleChat[i].is_user) {
                    startIdx = i;
                    break;
                }
            }

            historyMessages = visibleChat.slice(startIdx);
            // Limit to depth messages
            if (historyMessages.length > depth) {
                historyMessages = historyMessages.slice(-depth);
            }
            log('includeUserInput ON - depth:', depth, 'startIdx:', startIdx, 'count:', historyMessages.length, '(excluding hidden)');
        } else {
            // Only the last message (AI response), excluding hidden messages
            const visibleChat = chat.filter(msg => !msg.is_system);
            historyMessages = visibleChat.slice(-1);
            log('includeUserInput OFF - using last visible message only');
        }

        // Build history with past commentary if enabled
        const metadata = getChatMetadata();
        const messageCommentaries = (metadata && metadata.messageCommentaries) || {};

        log('History messages:', historyMessages.map(m => ({ name: m.name, is_user: m.is_user })), 'count:', historyMessages.length);

        // Determine user count and message count
        const isNarratorStyle = ['nsfw_ava', 'nsfw_kai', 'hypebot'].includes(settings.style);

        let actualUserCount; // Number of different users
        let messageCount; // Number of messages to generate

        if (settings.livestream && !showOverlay) {
            // Background auto-generation in livestream mode: use batch size for the queue
            // Narrator styles (single character) still generate multiple messages in livestream mode
            actualUserCount = 1; // Always 1 user for narrator styles; for others use userCount
            if (isNarratorStyle) {
                // Narrator styles: single character but generate multiple messages for livestream
                actualUserCount = 1;
                messageCount = Math.max(5, Math.min(50, parseInt(settings.livestreamBatchSize) || 20));
            } else {
                actualUserCount = Math.max(1, Math.min(20, parseInt(settings.userCount) || 5));
                messageCount = Math.max(5, Math.min(50, parseInt(settings.livestreamBatchSize) || 20));
            }
            log('Livestream mode - users:', actualUserCount, 'messages:', messageCount);
        } else {
            // Regular mode (or explicit regen in livestream mode): user count determines both
            actualUserCount = isNarratorStyle ? 1 : (parseInt(settings.userCount) || 5);
            messageCount = actualUserCount;
        }

        const userCount = Math.max(1, Math.min(50, messageCount));
        log('generateDiscordChat - userCount:', userCount, isNarratorStyle ? '(narrator style)' : '', settings.livestream ? '(livestream batch)' : '');

        const stylePrompt = await loadChatStyle(settings.style || 'twitch');

        // Build additional context for system message (persona, characters, summary, world info)
        let additionalSystemContext = '';
        const systemContextParts = [];

        // Include persona if enabled — resolve macro eagerly so Ollama/OpenAI/Profile
        // sources receive the actual text, not the unresolved '{{persona}}' token.
        if (settings.includePersona) {
            const personaName = context.name1 || 'User';
            const personaText = resolveSTMacro(context, '{{persona}}');
            if (personaText.trim()) {
                systemContextParts.push(`<user_persona name="${personaName}">\n${personaText}\n</user_persona>`);
                log('Added persona text to system message, length:', personaText.length);
            } else {
                log('Persona enabled but no text found — check ST persona settings');
            }
        }

        // Include Author's Note if enabled
        if (settings.includeAuthorsNote) {
            const anText = resolveSTMacro(context, '{{authorsNote}}');
            if (anText.trim()) {
                systemContextParts.push(`<authors_note>\n${anText}\n</authors_note>`);
                log('Added authors note to system message, length:', anText.length);
            } else {
                log("Authors note enabled but no text found — check Author's Note extension");
            }
        }

        // Include character descriptions if enabled
        if (settings.includeCharacterDescription) {
            const activeCharacters = getActiveCharacters();
            if (activeCharacters.length > 0) {
                const charDescriptions = activeCharacters
                    .filter(char => char.description)
                    .map(char => `<character name="${char.name}">\n${char.description}\n</character>`)
                    .join('\n\n');
                if (charDescriptions) {
                    systemContextParts.push(charDescriptions);
                    log('Added character descriptions for', activeCharacters.length, 'characters');
                }
            }
        }

        // Include summary if enabled (from Summarize extension)
        if (settings.includeSummary) {
            try {
                // Try to get summary from chat metadata or extension settings
                const memorySettings = context.extensionSettings?.memory;
                if (memorySettings) {
                    // Look for summary in recent chat messages
                    const chatWithSummary = context.chat?.slice().reverse().find(m => m.extra?.memory);
                    if (chatWithSummary?.extra?.memory) {
                        systemContextParts.push(`<summary>\n${chatWithSummary.extra.memory}\n</summary>`);
                        log('Added summary from chat memory');
                    }
                }
            } catch (e) {
                log('Could not get summary:', e);
            }
        }

        // Include world info (lorebook) if enabled - fetch using getWorldInfoPrompt like RPG Companion
        if (settings.includeWorldInfo) {
            try {
                // Use SillyTavern's getWorldInfoPrompt to get activated lorebook entries
                const getWorldInfoFn = context.getWorldInfoPrompt || (typeof window !== 'undefined' && window.getWorldInfoPrompt);
                const currentChat = context.chat || chat;

                if (typeof getWorldInfoFn === 'function' && currentChat && currentChat.length > 0) {
                    const chatForWI = currentChat.map(x => x.mes || x.message || x).filter(m => m && typeof m === 'string');
                    // Use user-configured budget; 0 means "let SillyTavern decide" (pass a huge value so ST's own budget applies)
                    const wiBudgetValue = (settings.wiBudget && settings.wiBudget > 0) ? settings.wiBudget : Number.MAX_SAFE_INTEGER;
                    const result = await getWorldInfoFn(chatForWI, wiBudgetValue, false);
                    const worldInfoString = result?.worldInfoString || result;

                    if (worldInfoString && typeof worldInfoString === 'string' && worldInfoString.trim()) {
                        systemContextParts.push(`<world_info>\n${worldInfoString.trim()}\n</world_info>`);
                        log('Added world info, length:', worldInfoString.length);
                    } else {
                        log('World info enabled but getWorldInfoPrompt returned empty');
                    }
                } else {
                    // Fallback to activatedWorldInfo
                    if (context.activatedWorldInfo && Array.isArray(context.activatedWorldInfo) && context.activatedWorldInfo.length > 0) {
                        const worldInfoContent = context.activatedWorldInfo
                            .filter(entry => entry && entry.content)
                            .map(entry => entry.content)
                            .join('\n\n');
                        if (worldInfoContent.trim()) {
                            systemContextParts.push(`<world_info>\n${worldInfoContent.trim()}\n</world_info>`);
                            log('Added world info from activatedWorldInfo, entries:', context.activatedWorldInfo.length);
                        }
                    } else {
                        log('World info enabled but no getWorldInfoPrompt function and no activatedWorldInfo');
                    }
                }
            } catch (e) {
                log('Error getting world info:', e);
            }
        }

        if (systemContextParts.length > 0) {
            additionalSystemContext = '\n\n<lore>\n' + systemContextParts.join('\n\n') + '\n</lore>';
        }

        // Build the system message with base prompt and additional context
        const isSillyTavernStyle = settings.style === 'sillytavern' || settings.style === 'sillytavern_story';
        const systemMessage = isSillyTavernStyle
            ? `<role>
You voice the actual characters from this SillyTavern roleplay as they react to the unfolding story in a live chat feed. Each character speaks authentically in their own established voice and personality — they are not random internet users, they are the story's cast.
</role>${additionalSystemContext}

<chat_history>`
            : `<role>
You are an excellent creator of fake chat feeds that react dynamically to the user's conversation context.
</role>${additionalSystemContext}

<chat_history>`;

        // Build dynamic count instruction based on style type and mode
        let countInstruction = '';
        if (isNarratorStyle && settings.livestream && !showOverlay) {
            // Narrator styles in livestream mode: single character but multiple messages
            countInstruction = `IMPORTANT: You MUST generate EXACTLY ${messageCount} messages. Not fewer, not more - exactly ${messageCount} messages from the same narrator/character.\n\n`;
        } else if (!isNarratorStyle) {
            if (settings.livestream && !showOverlay) {
                countInstruction = `IMPORTANT: You MUST generate EXACTLY ${messageCount} chat messages from EXACTLY ${actualUserCount} different users. Each user can post multiple messages. Not fewer, not more - exactly ${messageCount} messages from ${actualUserCount} users.\n\n`;
            } else {
                countInstruction = `IMPORTANT: You MUST generate EXACTLY ${userCount} chat messages. Not fewer, not more - exactly ${userCount}.\n\n`;
            }
        }

        // Build the chat history as proper message array for APIs that support it
        // This creates user/assistant turns from the conversation
        const chatHistoryMessages = [];

        if (settings.includePastEchoChambers && metadata && metadata.messageCommentaries) {
            // Include past generated commentary interleaved with messages
            for (let i = 0; i < historyMessages.length; i++) {
                const msg = historyMessages[i];
                const msgIndex = chat.indexOf(msg);
                const role = msg.is_user ? 'user' : 'assistant';
                let content = cleanMessage(msg.mes);

                // Add commentary if it exists for this message
                if (messageCommentaries[msgIndex]) {
                    content += `\n\n[Previous EchoChamber commentary: ${messageCommentaries[msgIndex]}]`;
                }

                chatHistoryMessages.push({ role, content });
            }
            log('Including past EchoChambers commentary in chat history');
        } else {
            // Build chat history with proper user/assistant roles (no names, just message content)
            for (const msg of historyMessages) {
                const role = msg.is_user ? 'user' : 'assistant';
                const content = cleanMessage(msg.mes);
                chatHistoryMessages.push({ role, content });
            }
        }

        // Build the final user prompt (instructions only, context is in chat history)
        let userReplyContext = "";
        if (window.lastEchoReply) {
            userReplyContext = `\n\n<streamer_reply>\nIMPORTANT: The streamer (the user who controls this character) has just directly replied to the chat: "${window.lastEchoReply}". The chat reactions you generate MUST acknowledge and react to this reply. Some chatters should respond directly to the streamer's message.\n</streamer_reply>`;
            window.lastEchoReply = null; // Clear it so it doesn't repeat
        }
        const instructionsPrompt = `</chat_history>${userReplyContext}

        <instructions>
${countInstruction}${stylePrompt}
</instructions>

<task>
Based on the chat history above, generate fake chat feed reactions. Remember to think about them step-by-step first.
STRICTLY follow the format defined in the instruction. ${isNarratorStyle && settings.livestream && !showOverlay ? `Output exactly ${messageCount} messages.` : isNarratorStyle ? '' : settings.livestream && !showOverlay ? `Output exactly ${messageCount} messages from ${actualUserCount} users.` : `Output exactly ${userCount} messages.`} Do NOT continue the story or roleplay as the characters. The created by you people are allowed to interact with each other over your generated feed. Do NOT output preamble like "Here are the messages". Just output the content directly.
</task>`;

        // Calculate appropriate max_tokens based on message count
        // Each message typically needs 50-100 tokens, so we allocate ~200 per message with a minimum of 2048 for safety
        const calculatedMaxTokens = Math.max(2048, userCount * 200 + 1024);
        log('Calculated max_tokens:', calculatedMaxTokens, 'for', userCount, 'messages');

        try {
            let result = '';

            if (settings.source === 'profile' && settings.preset) {
                // PROFILE GENERATION - Build proper message array with chat history
                const cm = context.extensionSettings?.connectionManager;
                // settings.preset stores profile ID; fall back to name match for older saved settings
                const profile = cm?.profiles?.find(p => p.id === settings.preset) || cm?.profiles?.find(p => p.name === settings.preset);
                if (!profile) throw new Error(`Profile '${settings.preset}' not found`);

                // Use ConnectionManagerRequestService
                if (!context.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService not available');

                // Build message array: system, chat history, then instructions
                const messages = [
                    { role: 'system', content: systemMessage }
                ];

                // Add chat history as proper user/assistant turns
                for (const histMsg of chatHistoryMessages) {
                    messages.push({ role: histMsg.role, content: histMsg.content });
                }

                // Add final instruction as user message
                messages.push({ role: 'user', content: instructionsPrompt });

                log(`Generating with profile: ${profile.name}, max_tokens: ${calculatedMaxTokens}, messages: ${messages.length}`);
                const response = await context.ConnectionManagerRequestService.sendRequest(
                    profile.id,
                    messages,
                    calculatedMaxTokens, // Dynamic max_tokens based on message count
                    {
                        stream: false,
                        signal: abortController.signal,
                        extractData: true,
                        includePreset: true,
                        includeInstruct: true
                    }
                );

                // Parse response - handle all possible formats from different API backends
                result = extractTextFromResponse(response);

            } else if (settings.source === 'ollama') {
                const baseUrl = settings.url.replace(/\/$/, '');
                let modelToUse = settings.model;
                if (!modelToUse) {
                    warn('No Ollama model selected');
                    return;
                }

                // Build message array for Ollama chat endpoint (multi-turn)
                const messages = [
                    { role: 'system', content: systemMessage }
                ];

                // Add chat history as proper user/assistant turns
                for (const histMsg of chatHistoryMessages) {
                    messages.push({ role: histMsg.role, content: histMsg.content });
                }

                // Add final instruction as user message
                messages.push({ role: 'user', content: instructionsPrompt });

                log(`Generating with Ollama: ${modelToUse}, messages: ${messages.length}`);

                // Use Ollama's chat endpoint for proper multi-turn conversation
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: modelToUse,
                        messages: messages,
                        stream: false,
                        options: { num_ctx: context.main?.context_size || 4096, num_predict: calculatedMaxTokens }
                    }),
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`Ollama API Error(${response.status})`);
                const data = await response.json();
                result = data.message?.content || data.response || '';
            } else if (settings.source === 'openai') {
                const baseUrl = settings.openai_url.replace(/\/$/, '');
                const targetEndpoint = `${baseUrl}/chat/completions`;

                // Build message array: system, chat history, then instructions
                const messages = [
                    { role: 'system', content: systemMessage }
                ];

                // Add chat history as proper user/assistant turns
                for (const histMsg of chatHistoryMessages) {
                    messages.push({ role: histMsg.role, content: histMsg.content });
                }

                // Add final instruction as user message
                messages.push({ role: 'user', content: instructionsPrompt });

                const payload = {
                    model: settings.openai_model || 'local-model',
                    messages: messages,
                    temperature: 0.7,
                    max_tokens: calculatedMaxTokens,
                    stream: false
                };

                log(`Generating with OpenAI compatible: ${settings.openai_model}, messages: ${messages.length}`);
                const response = await fetch(targetEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(settings.openai_key ? { 'Authorization': `Bearer ${settings.openai_key}` } : {})
                    },
                    body: JSON.stringify(payload),
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`API Error: ${response.status}`);
                const data = await response.json();
                result = extractTextFromResponse(data);
            } else {
                // Default ST generation using context - build message array like RPG Companion
                const { generateRaw } = context;
                if (generateRaw) {
                    // Build message array: system, chat history, then instructions
                    const messages = [
                        { role: 'system', content: systemMessage }
                    ];

                    // Add chat history as proper user/assistant turns
                    for (const histMsg of chatHistoryMessages) {
                        messages.push({ role: histMsg.role, content: histMsg.content });
                    }

                    // Add final instruction as user message
                    messages.push({ role: 'user', content: instructionsPrompt });

                    log(`Generating with ST generateRaw, messages: ${messages.length}`);

                    // Temporarily intercept fetch to capture the raw API response.
                    // This is needed because SillyTavern's generateRaw uses extractMessageFromData
                    // which calls .find() to get the FIRST type:'text' block. With Claude extended
                    // thinking, the first text block is just '\n\n' (empty), and the actual content
                    // is in a later text block. generateRaw then throws "No message generated".
                    // By capturing the raw response, we can extract the text ourselves on failure.
                    let capturedRawData = null;
                    const originalFetch = window.fetch;
                    window.fetch = async function (...args) {
                        const response = await originalFetch.apply(this, args);
                        try {
                            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                            if (url.includes('/api/backends/chat-completions/generate') ||
                                url.includes('/api/backends/') && url.includes('/generate')) {
                                const clone = response.clone();
                                capturedRawData = await clone.json();
                            }
                        } catch (e) { /* ignore clone/parse errors */ }
                        return response;
                    };

                    try {
                        result = await generateRaw({ prompt: messages, quietToLoud: false });

                        // generateRaw's cleanUpMessage may mangle our output or return near-empty
                        // content when extended thinking is used (first text block is just '\n\n').
                        // Always check if captured raw data has more content.
                        if (capturedRawData) {
                            const rawExtracted = extractTextFromResponse(capturedRawData);
                            const rawTrimmed = rawExtracted?.trim() || '';
                            const resultTrimmed = result?.trim() || '';
                            if (rawTrimmed.length > resultTrimmed.length + 50) {
                                console.warn('[EchoChamber] generateRaw returned truncated/mangled result (' +
                                    resultTrimmed.length + ' chars). Using raw API data instead (' + rawTrimmed.length + ' chars).');
                                result = rawExtracted;
                            }
                        }
                    } catch (genErr) {
                        if (genErr.message?.includes('No message generated') && capturedRawData) {
                            console.warn('[EchoChamber] generateRaw failed to parse response (likely extended thinking format). Extracting from raw API data.');
                            result = extractTextFromResponse(capturedRawData);
                            if (!result || !result.trim()) {
                                throw new Error('Could not extract text from API response');
                            }
                        } else {
                            throw genErr;
                        }
                    } finally {
                        window.fetch = originalFetch; // Always restore original fetch
                    }
                } else {
                    throw new Error('generateRaw not available in context');
                }
            }

            // Check if generation was aborted before parsing
            if (abortController.signal.aborted || userCancelled) {
                log('Generation was cancelled, skipping result parsing');
                throw new Error('Generation cancelled by user');
            }

            // Safety: ensure result is a string before string operations
            if (typeof result !== 'string') {
                error('result is not a string after extraction! Type:', typeof result, 'Value:', result);
                result = extractTextFromResponse(result) || String(result);
            }

            // Parse result - strip thinking/reasoning tags and discordchat wrapper
            let cleanResult = result
                .replace(/<(thinking|think|thought|reasoning|reason)>[\s\S]*?<\/\1>/gi, '')
                .replace(/<\/?discordchat>/gi, '')
                .trim();
            const lines = cleanResult.split('\n');
            let htmlBuffer = '<div class="discord_container" style="padding-top: 10px;">';
            let messageCount = 0;
            let currentMsg = null;
            let parsedMessages = [];

            // Build known character list once for post-processing name snapping
            const knownCharsForSnap = getKnownCharactersForSnap();

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) {
                    if (currentMsg && !currentMsg.content.endsWith('\n\n')) currentMsg.content += '\n\n';
                    continue;
                }
                if (/^[\.\…\-\_]+$/.test(trimmedLine)) continue;

                // More flexible regex: matches "Name: Msg", "Name (Info): Msg", "@Name: Msg", etc.
                // Captures everything before the LAST colon followed by optional space as the username
                const match = trimmedLine.match(/^(?:[\d\.\-\*]*\s*)?(.+?):\s*(.+)$/);
                if (match) {
                    let name = match[1].trim().replace(/[\*_\"`]/g, '');
                    // Limit displayed name to reasonable length
                    if (name.length > 40) name = name.substring(0, 40);
                    // Snap to canonical character name; null means unknown — skip the message
                    if (knownCharsForSnap) {
                        name = snapToKnownCharacters(name, knownCharsForSnap);
                        if (!name) continue;
                    }
                    let content = match[2].trim();
                    currentMsg = { name, content };
                    parsedMessages.push(currentMsg);
                } else if (currentMsg) {
                    currentMsg.content += ' ' + trimmedLine;
                } else {
                    // Last resort: use entire line as content with generic name.
                    // Skip in SillyTavern styles — malformed lines with no known speaker
                    // must not slip through the character filter as a generic 'User' entry.
                    if (!knownCharsForSnap) {
                        currentMsg = { name: 'User', content: trimmedLine };
                        parsedMessages.push(currentMsg);
                    }
                }
            }

            // Reverse order for newest-first display
            const orderedMessages = settings.messageOrder === 'newest-first'
                ? [...parsedMessages].reverse()
                : parsedMessages;

            for (const msg of orderedMessages) {
                if (messageCount >= userCount) break;
                if (msg.content.trim().length < 2) continue;
                htmlBuffer += formatMessage(msg.name, msg.content.trim());
                messageCount++;
            }

            console.warn(`[EchoChamber] Parsed ${parsedMessages.length} messages, displayed ${messageCount}/${userCount}`);
            log(`Parsed ${parsedMessages.length} messages, displayed ${messageCount}/${userCount}`);

            htmlBuffer += '</div>';
            setStatus('');

            if (messageCount === 0) {
                setDiscordText('<div class=\"discord_status\">No valid chat lines generated.</div>');
            } else {
                // Use livestream queue only for background auto-generation (not explicit regen)
                if (settings.livestream && !showOverlay) {
                    // Parse individual messages for livestream queue
                    const messages = parseLivestreamMessages(htmlBuffer);
                    console.warn('[EchoChamber] Livestream mode: queuing', messages.length, 'messages for display');
                    log('Livestream mode: queuing', messages.length, 'messages');

                    // Save to metadata for persistence - save full html and mark as incomplete
                    const lastMsgIndex = chat.length - 1;
                    const updatedCommentaries = { ...(messageCommentaries || {}) };
                    updatedCommentaries[lastMsgIndex] = cleanResult;
                    saveGeneratedCommentary('', updatedCommentaries, htmlBuffer, false);

                    // Start livestream display — new messages will prepend on top of any
                    // existing panel content (previous turns remain visible below new ones).
                    startLivestream(messages);

                    // Generation phase complete. Switch indicator from orange (loading)
                    // back to red (live/active). The queue will continue to drip messages.
                    updateLiveIndicator();
                } else {
                    // Regular mode OR explicit regen in livestream mode: display all at once.
                    // If livestream was running, stop it cleanly first so the queue doesn't interfere.
                    if (settings.livestream) stopLivestream();

                    setDiscordText(htmlBuffer);

                    // Save to metadata for persistence
                    const lastMsgIndex = chat.length - 1;
                    const updatedCommentaries = { ...(messageCommentaries || {}) };
                    updatedCommentaries[lastMsgIndex] = cleanResult;
                    saveGeneratedCommentary(htmlBuffer, updatedCommentaries);
                }
            }

            // Mark generation as complete
            isGenerating = false;
            updateReplyButtonState(false);

        } catch (err) {
            // Mark generation as complete (even on error)
            isGenerating = false;
            updateReplyButtonState(false);
            // Only clear status overlay if we were using it (non-livestream or explicit overlay)
            if (!settings.livestream || showOverlay) setStatus('');
            if (settings.livestream && !showOverlay) updateLiveIndicator();
            const isAbort = err.name === 'AbortError' || err.message?.includes('aborted') || userCancelled;
            if (isAbort || userCancelled) {
                // User cancelled - show toast notification, keep previous content
                if (typeof toastr !== 'undefined') {
                    toastr.info('Generation cancelled', 'EchoChamber');
                }
                log('Generation cancelled by user');
            } else {
                // Actual error occurred - show error toast, keep previous content
                error('Generation failed:', err);
                if (typeof toastr !== 'undefined') {
                    toastr.error(err.message || 'Unknown error occurred', 'EchoChamber Generation Error');
                }
            }
        }
    }

    // ============================================================
    // PROMPT LOADING
    // ============================================================

    let promptCache = {};
    const STYLE_FILES = {
        'sillytavern': 'sillytavern.md',
        'sillytavern_story': 'sillytavern_story.md',
        'twitch': 'discordtwitch.md', 'verbose': 'thoughtfulverbose.md', 'twitter': 'twitterx.md', 'news': 'breakingnews.md',
        'mst3k': 'mst3k.md', 'nsfw_ava': 'nsfwava.md', 'nsfw_kai': 'nsfwkai.md', 'hypebot': 'hypebot.md',
        'doomscrollers': 'doomscrollers.md', 'darkroast': 'darkroast.md', 'dumbanddumber': 'dumbanddumber.md', 'ao3wattpad': 'ao3wattpad.md'
    };
    const BUILT_IN_STYLES = [
        { val: 'sillytavern', label: 'SillyTavern (Roleplay)' },
        { val: 'sillytavern_story', label: 'SillyTavern (Story)' },
        { val: 'twitch', label: 'Discord / Twitch' }, { val: 'verbose', label: 'Thoughtful' },
        { val: 'twitter', label: 'Twitter / X' }, { val: 'news', label: 'Breaking News' },
        { val: 'mst3k', label: 'MST3K' }, { val: 'nsfw_ava', label: 'Ava NSFW' },
        { val: 'nsfw_kai', label: 'Kai NSFW' }, { val: 'hypebot', label: 'HypeBot' },
        { val: 'doomscrollers', label: 'Doomscrollers' }, { val: 'darkroast', label: 'Dark Roast' },
        { val: 'dumbanddumber', label: 'Dumb & Dumber' },
        { val: 'ao3wattpad', label: 'AO3 / Wattpad' }
    ];

    // Default order: SillyTavern styles first, then generic styles; nsfw at the bottom
    const DEFAULT_STYLE_ORDER = [
        'sillytavern', 'sillytavern_story',
        'twitch', 'verbose', 'twitter', 'news', 'mst3k',
        'hypebot', 'doomscrollers', 'darkroast', 'dumbanddumber', 'ao3wattpad',
        'nsfw_ava', 'nsfw_kai'
    ];

    function getAllStyles() {
        // Build a map of all available style id -> style object
        const styleMap = {};
        BUILT_IN_STYLES.forEach(s => { styleMap[s.val] = s; });
        if (settings.custom_styles) {
            Object.keys(settings.custom_styles).forEach(id => {
                styleMap[id] = { val: id, label: settings.custom_styles[id].name };
            });
        }

        // Determine the order to use
        const savedOrder = Array.isArray(settings.style_order) && settings.style_order.length
            ? settings.style_order
            : DEFAULT_STYLE_ORDER;

        // Start with styles that appear in the saved order (skip deleted)
        const result = [];
        const seen = new Set();
        for (const id of savedOrder) {
            if (styleMap[id] && !(settings.deleted_styles && settings.deleted_styles.includes(id))) {
                result.push(styleMap[id]);
                seen.add(id);
            }
        }

        // Append any remaining styles not yet in the order (e.g. newly added custom styles)
        for (const id of Object.keys(styleMap)) {
            if (!seen.has(id) && !(settings.deleted_styles && settings.deleted_styles.includes(id))) {
                result.push(styleMap[id]);
            }
        }

        // Ensure 'sillytavern' is always at position 0 and 'sillytavern_story' at position 1,
        // even for users with a pre-existing saved style_order that pre-dates these styles.
        const stIdx = result.findIndex(s => s.val === 'sillytavern');
        if (stIdx > 0) {
            const [st] = result.splice(stIdx, 1);
            result.unshift(st);
        }
        const stStoryIdx = result.findIndex(s => s.val === 'sillytavern_story');
        if (stStoryIdx !== -1 && stStoryIdx !== 1) {
            const [stStory] = result.splice(stStoryIdx, 1);
            result.splice(1, 0, stStory);
        }

        return result;
    }

    // Reads the current visual order from the style editor list and saves it to settings.
    function saveStyleOrder() {
        const order = [];
        jQuery('#ec_style_list .ec_style_item').each(function () {
            const id = jQuery(this).data('id');
            if (id) order.push(id);
        });
        if (order.length) {
            settings.style_order = order;
            saveSettings();
        }
    }

    // Resolves SillyTavern macro tokens in a style prompt string.
    // Called fresh every time a style is loaded so {{user}}/{{char}} always
    // reflect the currently active persona and character.
    function resolveMacros(text) {
        if (!text) return text;
        try {
            const ctx = SillyTavern.getContext();
            const userName = ctx.name1 || 'User';
            const charName = ctx.characterName || ctx.name2 || 'Character';
            // {{characters}} resolves to a bullet-list of all active character names (one per line).
            // Used by the SillyTavern style to inject actual character names into the prompt.
            const characterList = (() => {
                const chars = getActiveCharacters();
                if (chars.length > 0) return chars.map(c => `- ${c.name}`).join('\n');
                return `- ${charName}`;
            })();
            // {{story_characters_block}} — for the SillyTavern (Story) style.
            // In a group chat: same named-character constraint as the Roleplay style.
            // In a single-character chat: the card name is the story/world title, NOT a character,
            // so we instruct the AI to infer cast names from the story content instead.
            const storyCharactersBlock = (() => {
                const chars = getActiveCharacters();
                if (ctx.groupId && chars.length > 0) {
                    const nameList = chars.map(c => `- ${c.name}`).join('\n');
                    return `<characters>\nThe ONLY chatters in this feed are the characters listed below. You MUST use each name EXACTLY as written — full surname included. Do NOT change, shorten, alter, or invent any part of any name. Do NOT add new characters not on this list:\n${nameList}\n</characters>`;
                }
                // Single-character chat: card name is the story title, not a speaking character
                return `<characters>\nIdentify the speaking characters from the story content itself — do NOT use "${charName}" as a username, as that is the story or world name, not a character. Use the names of characters who actually appear and speak within the narrative. Each character should speak with the voice and personality they demonstrate in the story.\n</characters>`;
            })();
            return text
                .replace(/\{\{user\}\}/gi, userName)
                .replace(/\{\{char\}\}/gi, charName)
                .replace(/\{\{characters\}\}/gi, characterList)
                .replace(/\{\{story_characters_block\}\}/gi, storyCharactersBlock);
        } catch (e) {
            return text;
        }
    }

    async function loadChatStyle(style) {
        let prompt;
        if (settings.custom_styles && settings.custom_styles[style]) {
            prompt = settings.custom_styles[style].prompt;
        } else if (promptCache[style]) {
            prompt = promptCache[style];
        } else {
            const filename = STYLE_FILES[style] || 'discordtwitch.md';
            try {
                const response = await fetch(`${BASE_URL}/chat-styles/${filename}?v=${Date.now()}`);
                if (!response.ok) throw new Error('Fetch failed');
                prompt = await response.text();
                promptCache[style] = prompt; // cache raw text; macros resolved at call time
            } catch (e) {
                warn('Failed to load style:', style, e);
                prompt = `Generate chat messages. Output: username: message`;
            }
        }
        return resolveMacros(prompt);
    }

    // ============================================================
    // SETTINGS MANAGEMENT
    // ============================================================

    function saveSettings() {
        const context = SillyTavern.getContext();
        // Preserve chatMetadata when saving settings
        const existingMetadata = context.extensionSettings[MODULE_NAME]?.chatMetadata;

        // Create a clean copy of settings without chatMetadata
        const settingsToSave = Object.assign({}, settings);
        delete settingsToSave.chatMetadata;

        context.extensionSettings[MODULE_NAME] = settingsToSave;
        if (existingMetadata) {
            context.extensionSettings[MODULE_NAME].chatMetadata = existingMetadata;
        }
        context.saveSettingsDebounced();
    }

    function loadSettings() {
        const context = SillyTavern.getContext();

        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultSettings));
        }

        // Don't copy chatMetadata into settings - it should stay in extensionSettings only
        const savedSettings = Object.assign({}, context.extensionSettings[MODULE_NAME]);
        delete savedSettings.chatMetadata;

        settings = Object.assign({}, defaultSettings, savedSettings);
        settings.userCount = parseInt(settings.userCount) || 5;
        settings.opacity = parseInt(settings.opacity) || 85;

        // Update UI
        jQuery('#discord_enabled').prop('checked', settings.enabled);
        jQuery('#discord_user_count').val(settings.userCount);
        jQuery('#discord_source').val(settings.source);
        jQuery('#discord_url').val(settings.url);
        jQuery('#discord_openai_url').val(settings.openai_url);
        jQuery('#discord_openai_key').val(settings.openai_key);
        jQuery('#discord_openai_model').val(settings.openai_model);
        jQuery('#discord_openai_preset').val(settings.openai_preset || 'custom');
        jQuery('#discord_preset_select').val(settings.preset || '');
        jQuery('#discord_font_size').val(settings.fontSize || 15);
        jQuery('#discord_position').val(settings.position || 'bottom');
        jQuery('#discord_style').val(settings.style || 'twitch');
        jQuery('#discord_opacity').val(settings.opacity);
        jQuery('#discord_opacity_val').text(settings.opacity + '%');
        jQuery('#discord_auto_update').prop('checked', settings.autoUpdateOnMessages !== false);
        jQuery('#discord_include_user').prop('checked', settings.includeUserInput);
        jQuery('#discord_context_depth').val(settings.contextDepth || 4);
        jQuery('#discord_include_past_echo').prop('checked', settings.includePastEchoChambers || false);
        jQuery('#discord_include_persona').prop('checked', settings.includePersona || false);
        jQuery('#discord_include_authors_note').prop('checked', settings.includeAuthorsNote || false);
        jQuery('#discord_include_character_description').prop('checked', settings.includeCharacterDescription || false);
        jQuery('#discord_include_summary').prop('checked', settings.includeSummary || false);
        jQuery('#discord_include_world_info').prop('checked', settings.includeWorldInfo || false);
        jQuery('#discord_wi_budget').val(settings.wiBudget || 0);
        jQuery('#discord_wi_budget_container').toggle(settings.includeWorldInfo || false);

        // Livestream settings
        jQuery('#discord_livestream').prop('checked', settings.livestream || false);
        jQuery('#discord_livestream_auto_scroll').prop('checked', settings.livestreamAutoScroll !== false);
        jQuery('#discord_livestream_batch_size').val(settings.livestreamBatchSize || 20);
        jQuery('#discord_livestream_min_wait').val(settings.livestreamMinWait || 5);
        jQuery('#discord_livestream_max_wait').val(settings.livestreamMaxWait || 60);
        jQuery('#discord_livestream_settings').toggle(settings.livestream || false);

        // Set livestream mode radio button
        const livestreamMode = settings.livestreamMode || 'manual';
        if (livestreamMode === 'manual') {
            jQuery('#discord_livestream_manual').prop('checked', true);
        } else if (livestreamMode === 'onMessage') {
            jQuery('#discord_livestream_onmessage').prop('checked', true);
        } else {
            jQuery('#discord_livestream_oncomplete').prop('checked', true);
        }

        // Show/hide context depth based on include user input setting
        jQuery('#discord_context_depth_container').toggle(settings.includeUserInput);

        // Chat Participation settings
        jQuery('#discord_chat_enabled').prop('checked', settings.chatEnabled !== false);
        jQuery('#discord_chat_username').val(settings.chatUsername || 'Streamer (You)');
        jQuery('#discord_chat_avatar_color').val(settings.chatAvatarColor || '#3b82f6');
        jQuery('#discord_chat_reply_count').val(settings.chatReplyCount || 3);
        jQuery('.ec_reply_container').toggle(settings.chatEnabled !== false);
        applyAvatarColor(settings.chatAvatarColor || '#3b82f6');

        // Message order
        jQuery('#discord_message_order').val(settings.messageOrder || 'oldest-first');

        applyFontSize(settings.fontSize || 15);
        updateSourceVisibility();
        updateAllDropdowns();

        if (discordBar) {
            updateApplyLayout();
            updateToggleIcon();
        }
    }

    function updateSourceVisibility() {
        jQuery('#discord_ollama_settings').hide();
        jQuery('#discord_openai_settings').hide();
        jQuery('#discord_profile_settings').hide();

        const source = settings.source || 'default';
        if (source === 'ollama') jQuery('#discord_ollama_settings').show();
        else if (source === 'openai') jQuery('#discord_openai_settings').show();
        else if (source === 'profile') jQuery('#discord_profile_settings').show();
    }

    function updateAllDropdowns() {
        const styles = getAllStyles();

        // Update settings panel dropdown
        const sSelect = jQuery('#discord_style');
        const currentVal = sSelect.val();
        sSelect.empty();
        styles.forEach(s => sSelect.append(`<option value="${s.val}">${s.label}</option>`));
        sSelect.val(currentVal || settings.style);

        // Update QuickBar style menu if exists
        const styleMenu = jQuery('.ec_style_menu');
        if (styleMenu.length) {
            populateStyleMenu(styleMenu);
        }

        // Populate connection profiles dropdown
        populateConnectionProfiles();
    }

    function populateConnectionProfiles() {
        const select = jQuery('#discord_preset_select');
        if (!select.length) return;

        select.empty();
        select.append('<option value="">-- Select Profile --</option>');

        try {
            const context = SillyTavern.getContext();
            const connectionManager = context.extensionSettings?.connectionManager;

            if (connectionManager?.profiles?.length) {
                connectionManager.profiles.forEach(profile => {
                    // Use profile ID as the option value; match existing saved settings that stored the name
                    const isSelected = (settings.preset === profile.id || settings.preset === profile.name) ? ' selected' : '';
                    select.append(`<option value="${profile.id}"${isSelected}>${profile.name}</option>`);
                });
                log(`Loaded ${connectionManager.profiles.length} connection profiles`);
            } else {
                select.append('<option value="" disabled>No profiles found</option>');
                log('No connection profiles available');
            }
        } catch (err) {
            warn('Error loading connection profiles:', err);
            select.append('<option value="" disabled>Error loading profiles</option>');
        }
    }

    // ============================================================
    // STYLE EDITOR MODAL
    // ============================================================

    let styleEditorModal = null;
    let currentEditingStyle = null;
    let stopStyleEditorViewport = null;
    let cancelStyleTouchDrag = null;

    function setStyleEditorCollapsed(collapsed) {
        styleEditorModal.toggleClass('ec_prompt_collapsed', collapsed);
        const showActions = Boolean(currentEditingStyle) && (!isMobileLayout() || !collapsed);
        jQuery('#ec_style_save, #ec_style_export').toggle(showActions);
        jQuery('#ec_style_delete').toggle(showActions && Boolean(settings.custom_styles?.[currentEditingStyle]));
        styleEditorModal.find('.ec_style_item').each(function () {
            this.setAttribute('aria-expanded', String(this.dataset.id === currentEditingStyle && !collapsed));
        });
    }

    function revealSelectedStyle() {
        const list = document.getElementById('ec_style_list');
        const item = Array.from(list.children).find(el => el.dataset.id === currentEditingStyle);
        if (!item) return;
        const bounds = list.getBoundingClientRect();
        const rect = item.getBoundingClientRect();
        if (rect.top < bounds.top) list.scrollTop += rect.top - bounds.top;
        else if (rect.bottom > bounds.bottom) list.scrollTop += rect.bottom - bounds.bottom;
    }

    // Keep native mouse dragging; touch/pen grips use pointer capture so normal
    // vertical swipes on the labels still scroll the list.
    function bindStyleTouchReorder(list) {
        let drag = null;
        let frame = 0;
        const moveRow = () => {
            const target = Array.from(list.children).find(item => item !== drag.item &&
                drag.y < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2);
            list.insertBefore(drag.item, target || null);
        };
        const tick = () => {
            const rect = list.getBoundingClientRect();
            const step = drag.y < rect.top + 32 ? -Math.min(12, (rect.top + 32 - drag.y) / 3)
                : drag.y > rect.bottom - 32 ? Math.min(12, (drag.y - rect.bottom + 32) / 3) : 0;
            list.scrollTop += step;
            moveRow();
            frame = requestAnimationFrame(tick);
        };
        const finish = (cancelled) => {
            if (!drag) return;
            const completed = drag;
            drag = null;
            cancelAnimationFrame(frame);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onCancel);
            list.removeEventListener('lostpointercapture', onCancel);
            if (list.hasPointerCapture(completed.pointerId)) list.releasePointerCapture(completed.pointerId);
            completed.item.classList.remove('ec_dragging');
            if (cancelled) {
                completed.order.forEach(item => list.appendChild(item));
                list.scrollTop = completed.scrollTop;
            } else if (completed.active && completed.order.some((item, index) => list.children[index] !== item)) {
                saveStyleOrder();
                updateAllDropdowns();
            }
        };
        const onMove = (e) => {
            if (!drag || e.pointerId !== drag.pointerId) return;
            e.preventDefault();
            drag.y = e.clientY;
            if (!drag.active && Math.abs(drag.y - drag.startY) < 8) return;
            if (!drag.active) {
                drag.active = true;
                drag.item.classList.add('ec_dragging');
                frame = requestAnimationFrame(tick);
            }
            moveRow();
        };
        const onUp = (e) => {
            if (drag && e.pointerId === drag.pointerId) { e.preventDefault(); finish(false); }
        };
        const onCancel = (e) => {
            if (drag && e.pointerId === drag.pointerId) finish(true);
        };
        cancelStyleTouchDrag = () => finish(true);
        list.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest('.ec_drag_handle');
            if (!handle || !['touch', 'pen'].includes(e.pointerType) || !e.isPrimary || drag) return;
            e.preventDefault();
            drag = {
                handle, item: handle.closest('.ec_style_item'), pointerId: e.pointerId,
                startY: e.clientY, y: e.clientY, active: false, order: Array.from(list.children), scrollTop: list.scrollTop
            };
            // Capture on the stationary list: moving a captured row/grip in DOM
            // would release capture and cancel an otherwise valid reorder.
            list.setPointerCapture(e.pointerId);
            list.addEventListener('lostpointercapture', onCancel);
            document.addEventListener('pointermove', onMove, { passive: false });
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onCancel);
        });
        list.addEventListener('dragstart', (e) => { if (drag) e.preventDefault(); });
        list.addEventListener('click', (e) => {
            if (e.target.closest('.ec_drag_handle')) { e.preventDefault(); e.stopPropagation(); }
        }, true);
    }

    function createStyleEditorModal() {
        if (jQuery('#ec_style_editor_modal').length) return;

        const modalHtml = `
        <div id="ec_style_editor_modal" class="ec_modal_overlay">
            <div class="ec_modal_content">
                <div class="ec_modal_header">
                    <h3><i class="fa-solid fa-palette"></i> Style Editor</h3>
                    <button class="ec_modal_close" id="ec_style_editor_close">&times;</button>
                </div>
                <div class="ec_modal_body">
                    <div class="ec_style_sidebar">
                        <div class="ec_style_sidebar_header">
                            <button class="menu_button ec_btn_new_style" id="ec_style_new" title="Create New Style">
                                <i class="fa-solid fa-plus"></i> <span>New</span>
                            </button>
                        </div>
                        <div class="ec_style_list" id="ec_style_list"></div>
                        <div class="ec_style_order_hint"><i class="fa-solid fa-grip-vertical"></i> Drag to reorder</div>
                    </div>
                    <div class="ec_style_main" id="ec_style_main">
                        <div class="ec_empty_state">
                            <i class="fa-solid fa-palette"></i>
                            <div>Select a style to edit or create a new one</div>
                        </div>
                    </div>
                </div>
                <div class="ec_modal_footer">
                    <div class="ec_modal_footer_left">
                        <button class="menu_button ec_btn_danger" id="ec_style_delete" style="display:none;">
                            <i class="fa-solid fa-trash"></i> Delete
                        </button>
                        <button class="menu_button ec_btn_export" id="ec_style_export" style="display:none;">
                            <i class="fa-solid fa-download"></i> Export
                        </button>
                    </div>
                    <div class="ec_modal_footer_right">
                        <button class="menu_button ec_btn_cancel" id="ec_style_cancel">
                            <i class="fa-solid fa-xmark"></i> Cancel
                        </button>
                        <button class="menu_button ec_btn_save" id="ec_style_save" style="display:none;">
                            <i class="fa-solid fa-floppy-disk"></i> Save
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

        jQuery('body').append(modalHtml);
        styleEditorModal = jQuery('#ec_style_editor_modal');
        bindStyleTouchReorder(document.getElementById('ec_style_list'));

        // Bind events
        jQuery('#ec_style_editor_close, #ec_style_cancel').on('click', closeStyleEditor);
        jQuery('#ec_style_new').on('click', createNewStyle);
        jQuery('#ec_style_save').on('click', saveStyleFromEditor);
        jQuery('#ec_style_delete').on('click', deleteStyleFromEditor);
        jQuery('#ec_style_export').on('click', () => exportStyle(currentEditingStyle));

        // Close on overlay click
        styleEditorModal.on('click', function (e) {
            if (e.target === this) closeStyleEditor();
        });
    }

    function openStyleEditor() {
        createStyleEditorModal();
        populateStyleList();
        currentEditingStyle = null;
        showEmptyState();
        stopStyleEditorViewport?.();
        stopStyleEditorViewport = trackModalViewport(styleEditorModal, () => {
            styleEditorModal.toggleClass('ec_mobile_editor', isMobileLayout());
            setStyleEditorCollapsed(styleEditorModal.hasClass('ec_prompt_collapsed'));
        });
        setStyleEditorCollapsed(true);
        styleEditorModal.addClass('active');
    }

    function closeStyleEditor() {
        cancelStyleTouchDrag?.();
        stopStyleEditorViewport?.();
        stopStyleEditorViewport = null;
        resetModalViewport(styleEditorModal);
        closeTemplateCreator();
        if (styleEditorModal) {
            styleEditorModal.removeClass('active');
        }
        currentEditingStyle = null;
        updateAllDropdowns();
    }

    function populateStyleList() {
        const list = jQuery('#ec_style_list');
        cancelStyleTouchDrag?.();
        const scrollTop = list.scrollTop();
        list.empty();

        const styles = getAllStyles();
        const { DOMPurify } = SillyTavern.libs;

        styles.forEach(style => {
            const isCustom = settings.custom_styles && settings.custom_styles[style.val];
            const typeClass = isCustom ? 'custom' : 'builtin';
            const icon = isCustom ? 'fa-user' : 'fa-cube';

            // Sanitize style label to prevent XSS
            const safeLabel = DOMPurify.sanitize(style.label, { ALLOWED_TAGS: [] });
            const safeVal = DOMPurify.sanitize(style.val, { ALLOWED_TAGS: [] });

            const item = jQuery(`
                <div class="ec_style_item ${typeClass}" data-id="${safeVal}" draggable="true">
                    <span class="ec_drag_handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                    <i class="fa-solid ${icon} ec_style_type_icon"></i>
                    <span class="ec_style_label">${safeLabel}</span>
                </div>
            `);

            // Click on the item (but not the drag handle) selects it
            item.on('click', function (e) {
                if (!jQuery(e.target).closest('.ec_drag_handle').length) {
                    if (isMobileLayout() && currentEditingStyle === style.val) {
                        setStyleEditorCollapsed(!styleEditorModal.hasClass('ec_prompt_collapsed'));
                        revealSelectedStyle();
                    } else {
                        selectStyleInEditor(style.val);
                    }
                }
            });

            list.append(item);
        });
        list.scrollTop(scrollTop);

        // --- Drag-and-drop reordering ---
        let dragSrc = null;

        list.find('.ec_style_item').each(function () {
            const el = this;

            el.addEventListener('dragstart', function (e) {
                dragSrc = el;
                el.classList.add('ec_dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', el.dataset.id);
            });

            el.addEventListener('dragend', function () {
                el.classList.remove('ec_dragging');
                list.find('.ec_style_item').removeClass('ec_drag_over');
                saveStyleOrder();
                // Refresh the dropdowns so the new order is reflected immediately
                updateAllDropdowns();
            });

            el.addEventListener('dragover', function (e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (el !== dragSrc) {
                    list.find('.ec_style_item').removeClass('ec_drag_over');
                    el.classList.add('ec_drag_over');
                }
            });

            el.addEventListener('dragleave', function () {
                el.classList.remove('ec_drag_over');
            });

            el.addEventListener('drop', function (e) {
                e.preventDefault();
                el.classList.remove('ec_drag_over');
                if (!dragSrc || dragSrc === el) return;

                // Insert dragSrc before or after this element based on pointer position
                const rect = el.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    list[0].insertBefore(dragSrc, el);
                } else {
                    list[0].insertBefore(dragSrc, el.nextSibling);
                }

                // Restore active state if needed
                if (currentEditingStyle) {
                    jQuery('.ec_style_item').removeClass('active');
                    jQuery(`.ec_style_item[data-id="${currentEditingStyle}"]`).addClass('active');
                }
            });
        });
    }

    function showEmptyState() {
        jQuery('#ec_style_main').html(`
            <div class="ec_empty_state">
                <i class="fa-solid fa-palette"></i>
                <div>Select a style to edit or create a new one</div>
            </div>
        `);
        jQuery('#ec_style_save, #ec_style_delete, #ec_style_export').hide();
    }

    async function selectStyleInEditor(styleId) {
        currentEditingStyle = styleId;

        // Update sidebar selection
        jQuery('.ec_style_item').removeClass('active');
        jQuery(`.ec_style_item[data-id="${styleId}"]`).addClass('active');

        const isCustom = settings.custom_styles && settings.custom_styles[styleId];
        const style = getAllStyles().find(s => s.val === styleId);
        const styleName = style ? style.label : styleId;

        // Load content (raw, before macro substitution so the editor shows the original tokens)
        let content = '';
        if (isCustom) {
            content = settings.custom_styles[styleId].prompt || '';
        } else {
            // Load raw from cache/fetch without resolving macros so tokens stay visible in editor
            const filename = STYLE_FILES[styleId] || 'discordtwitch.md';
            try {
                if (promptCache[styleId]) {
                    content = promptCache[styleId];
                } else {
                    const resp = await fetch(`${BASE_URL}/chat-styles/${filename}?v=${Date.now()}`);
                    content = resp.ok ? await resp.text() : '';
                    if (content) promptCache[styleId] = content;
                }
            } catch (e) {
                content = '';
            }
        }

        // A slow built-in prompt fetch must not replace a newer selection.
        if (currentEditingStyle !== styleId) return;

        // Resolve macro preview values for the hint bar
        const ctx = SillyTavern.getContext();
        const previewUser = ctx.name1 || 'User';
        const previewChar = ctx.characterName || ctx.name2 || 'Character';

        // Escape styleName for safe HTML insertion
        const safeStyleName = styleName.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Render editor (textarea content set separately to avoid HTML injection issues)
        jQuery('#ec_style_main').html(`
            <div class="ec_style_name_row">
                <input type="text" class="ec_style_name_input" id="ec_style_name"
                       value="${safeStyleName}" placeholder="Style Name" ${!isCustom ? 'readonly' : ''}>
                ${!isCustom ? '<small style="opacity:0.6;">(Built-in styles cannot be renamed)</small>' : ''}
            </div>
            <textarea class="ec_style_textarea" id="ec_style_content"
                      placeholder="Enter the prompt/instructions for this style..."></textarea>
            <div style="font-size:0.75em; opacity:0.65; margin-top:6px; padding:6px 8px; background:rgba(0,0,0,0.15); border-radius:4px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span><i class="fa-solid fa-code" style="margin-right:4px;"></i><b>Macros:</b></span>
                <span><code style="background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:3px;">{{user}}</code> → <em>${previewUser}</em></span>
                <span><code style="background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:3px;">{{char}}</code> → <em>${previewChar}</em></span>
                <span><code style="background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:3px;">{{characters}}</code> → <em>all active character names</em></span>
            </div>
        `);

        // Set textarea content safely (avoids HTML parsing issues with special characters)
        jQuery('#ec_style_content').val(content);

        // Show appropriate buttons
        setStyleEditorCollapsed(false);
        revealSelectedStyle();
    }

    // ============================================================
    // TEMPLATE CREATOR MODAL
    // ============================================================

    let templateCreatorModal = null;
    let stopTemplateViewport = null;

    const defaultAdvancedTemplate = `You will be acting as a chat feed audience. Your goal is to simulate messages reacting to the unfolding events.

<usernames>
- Generate NEW random usernames each time
- Make them creative and varied
- Align them with the conversation context
</usernames>

<personalities>
- Mix different personality types and reactions
- Include enthusiasts, skeptics, comedians, and analysts
- Vary the tone and engagement level
</personalities>

<style>
- Keep messages short and natural
- React to events as they happen
- Use platform-appropriate language and emojis
</style>

<interactions>
- Users may respond to each other
- Reference what others said
- Create natural conversation flow
</interactions>

You must format your responses using the following format:
<format>
username: message
</format>
`;

    function createTemplateCreatorModal() {
        if (jQuery('#ec_template_creator_modal').length) return;

        const modalHtml = `
        <div id="ec_template_creator_modal" class="ec_modal_overlay">
            <div class="ec_modal_content ec_template_creator">
                <div class="ec_modal_header">
                    <h3><i class="fa-solid fa-wand-magic-sparkles"></i> Create New Style</h3>
                    <button class="ec_modal_close" id="ec_template_close">&times;</button>
                </div>
                <div class="ec_template_tabs">
                    <button class="ec_tab_btn active" data-tab="easy"><i class="fa-solid fa-magic"></i> Easy Mode</button>
                    <button class="ec_tab_btn" data-tab="advanced"><i class="fa-solid fa-code"></i> Advanced</button>
                </div>
                <div class="ec_modal_body ec_template_body">
                    <!-- Easy Mode -->
                    <div class="ec_tab_content active" data-tab="easy">
                        <div class="ec_form_group">
                            <label>Style Name</label>
                            <input type="text" id="ec_tpl_name" placeholder="My Custom Chat" />
                        </div>
                        <div class="ec_form_group">
                            <label>Style Type</label>
                            <select id="ec_tpl_type">
                                <option value="chat">Chat (Multiple Users)</option>
                                <option value="narrator">Narrator (Single Voice)</option>
                            </select>
                        </div>
                        <div class="ec_form_group">
                            <label>Output Format</label>
                            <input type="text" id="ec_tpl_format" placeholder="username: message" value="username: message" />
                            <small>How each message should be formatted</small>
                        </div>
                        <div class="ec_form_group">
                            <label>Identity / Setting</label>
                            <textarea id="ec_tpl_identity" rows="2" placeholder="Who are the participants? What's the context?"></textarea>
                            <small>e.g., "Discord users reacting live to events" or "A sarcastic AI commentator"</small>
                        </div>
                        <div class="ec_form_group">
                            <label>Personality Guidelines</label>
                            <textarea id="ec_tpl_personality" rows="3" placeholder="Describe the tone, vocabulary, and behavior"></textarea>
                            <small>e.g., "Chaotic, uses emojis, internet slang, varying excitement levels"</small>
                        </div>
                        <div class="ec_form_group">
                            <label>Tone</label>
                            <select id="ec_tpl_tone">
                                <option value="custom">Custom (enter below)</option>
                                <option value="chaotic">Chaotic / Energetic</option>
                                <option value="calm">Calm / Thoughtful</option>
                                <option value="sarcastic">Sarcastic / Witty</option>
                                <option value="wholesome">Wholesome / Supportive</option>
                                <option value="cynical">Cynical / Tired</option>
                                <option value="explicit">Explicit / NSFW</option>
                            </select>
                            <input type="text" id="ec_tpl_custom_tone" placeholder="Enter your custom tone description..." style="margin-top: 8px;" />
                        </div>
                        <div class="ec_form_row">
                            <div class="ec_form_group">
                                <label>Message Length</label>
                                <select id="ec_tpl_length">
                                    <option value="short">Short (1-2 sentences)</option>
                                    <option value="medium">Medium (2-3 sentences)</option>
                                    <option value="long">Long (paragraphs)</option>
                                </select>
                            </div>
                            <div class="ec_form_group">
                                <label>User Interactions</label>
                                <select id="ec_tpl_interact">
                                    <option value="yes">Users respond to each other</option>
                                    <option value="no">Independent messages</option>
                                </select>
                            </div>
                        </div>
                        <div class="ec_form_group">
                            <label>Style Elements (select all that apply)</label>
                            <div class="ec_checkbox_row">
                                <label><input type="checkbox" id="ec_tpl_emoji" checked /> Emojis</label>
                                <label><input type="checkbox" id="ec_tpl_slang" checked /> Internet Slang</label>
                                <label><input type="checkbox" id="ec_tpl_lowercase" /> Lowercase preferred</label>
                                <label><input type="checkbox" id="ec_tpl_typos" /> Occasional typos</label>
                            </div>
                            <div class="ec_checkbox_row" style="margin-top: 8px;">
                                <label><input type="checkbox" id="ec_tpl_allcaps" /> ALL CAPS moments</label>
                                <label><input type="checkbox" id="ec_tpl_hashtags" /> Hashtags</label>
                                <label><input type="checkbox" id="ec_tpl_mentions" /> @mentions</label>
                                <label><input type="checkbox" id="ec_tpl_formal" /> Formal grammar</label>
                            </div>
                        </div>
                    </div>
                    <!-- Advanced Mode -->
                    <div class="ec_tab_content" data-tab="advanced">
                        <div class="ec_form_group">
                            <label>Style Name</label>
                            <input type="text" id="ec_tpl_adv_name" placeholder="My Custom Chat" />
                        </div>
                        <div class="ec_form_group ec_full_height">
                            <label>System Prompt</label>
                            <div class="ec_prompt_actions">
                                <button class="menu_button ec_small_btn" id="ec_tpl_copy"><i class="fa-solid fa-copy"></i> Copy</button>
                                <button class="menu_button ec_small_btn" id="ec_tpl_paste"><i class="fa-solid fa-paste"></i> Paste</button>
                                <button class="menu_button ec_small_btn" id="ec_tpl_clear"><i class="fa-solid fa-eraser"></i> Clear</button>
                                <button class="menu_button ec_small_btn" id="ec_tpl_reset"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                            </div>
                            <textarea id="ec_tpl_adv_prompt" placeholder="Write your complete system prompt here..."></textarea>
                            <small>The extension will prepend "Generate X messages" based on user count setting.</small>
                            <div style="font-size:0.75em; opacity:0.65; margin-top:6px; padding:6px 8px; background:rgba(0,0,0,0.15); border-radius:4px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                                <span><i class="fa-solid fa-code" style="margin-right:4px;"></i><b>Macros:</b></span>
                                <span><code style="background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:3px;">{{user}}</code> &rarr; <em id="ec_tpl_adv_user_preview">?</em></span>
                                <span><code style="background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:3px;">{{char}}</code> &rarr; <em id="ec_tpl_adv_char_preview">?</em></span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="ec_modal_footer">
                    <div class="ec_modal_footer_left"></div>
                    <div class="ec_modal_footer_right">
                        <button class="menu_button ec_btn_cancel" id="ec_template_cancel">
                            <i class="fa-solid fa-xmark"></i> Cancel
                        </button>
                        <button class="menu_button ec_btn_create" id="ec_template_create">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Create
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

        jQuery('body').append(modalHtml);
        templateCreatorModal = jQuery('#ec_template_creator_modal');

        // Tab switching
        templateCreatorModal.on('click', '.ec_tab_btn', function () {
            const tab = jQuery(this).data('tab');
            templateCreatorModal.find('.ec_tab_btn').removeClass('active');
            templateCreatorModal.find('.ec_tab_content').removeClass('active');
            jQuery(this).addClass('active');
            templateCreatorModal.find(`.ec_tab_content[data-tab="${tab}"]`).addClass('active');
        });

        // Tone dropdown - show/hide custom input
        templateCreatorModal.on('change', '#ec_tpl_tone', function () {
            const isCustom = jQuery(this).val() === 'custom';
            jQuery('#ec_tpl_custom_tone').toggle(isCustom);
            if (isCustom) jQuery('#ec_tpl_custom_tone').focus();
        });

        // Advanced mode buttons
        jQuery('#ec_tpl_clear').on('click', function () {
            jQuery('#ec_tpl_adv_prompt').val('').focus();
        });

        jQuery('#ec_tpl_copy').on('click', async function () {
            try {
                const text = jQuery('#ec_tpl_adv_prompt').val();
                await navigator.clipboard.writeText(text);
                if (typeof toastr !== 'undefined') toastr.success('Prompt copied to clipboard');
            } catch (err) {
                if (typeof toastr !== 'undefined') toastr.error('Could not copy to clipboard');
            }
        });

        jQuery('#ec_tpl_paste').on('click', async function () {
            try {
                const text = await navigator.clipboard.readText();
                jQuery('#ec_tpl_adv_prompt').val(text);
            } catch (err) {
                if (typeof toastr !== 'undefined') toastr.error('Could not access clipboard');
            }
        });

        jQuery('#ec_tpl_reset').on('click', function () {
            jQuery('#ec_tpl_adv_prompt').val(defaultAdvancedTemplate);
        });

        // Close handlers
        jQuery('#ec_template_close, #ec_template_cancel').on('click', closeTemplateCreator);
        jQuery('#ec_template_create').on('click', createStyleFromTemplate);

        templateCreatorModal.on('click', function (e) {
            if (e.target === this) closeTemplateCreator();
        });
    }

    function openTemplateCreator() {
        createTemplateCreatorModal();
        // Reset form
        templateCreatorModal.find('input[type="text"], textarea').val('');
        templateCreatorModal.find('select').each(function () {
            this.selectedIndex = 0;
        });
        templateCreatorModal.find('input[type="checkbox"]').prop('checked', false);
        jQuery('#ec_tpl_emoji, #ec_tpl_slang').prop('checked', true);
        jQuery('#ec_tpl_format').val('username: message');

        // Set tone to chaotic (not custom) and hide custom input
        jQuery('#ec_tpl_tone').val('chaotic');
        jQuery('#ec_tpl_custom_tone').hide().val('');

        // Pre-populate Advanced mode with template
        jQuery('#ec_tpl_adv_prompt').val(defaultAdvancedTemplate);

        // Populate macro preview values with current character/persona names
        try {
            const ctx = SillyTavern.getContext();
            jQuery('#ec_tpl_adv_user_preview').text(ctx.name1 || 'User');
            jQuery('#ec_tpl_adv_char_preview').text(ctx.characterName || ctx.name2 || 'Character');
        } catch (e) { /* context may not be ready */ }

        // Reset to Easy tab
        templateCreatorModal.find('.ec_tab_btn').removeClass('active').first().addClass('active');
        templateCreatorModal.find('.ec_tab_content').removeClass('active').first().addClass('active');

        templateCreatorModal.addClass('active');
        stopTemplateViewport?.();
        stopTemplateViewport = trackModalViewport(templateCreatorModal);
    }

    function closeTemplateCreator() {
        stopTemplateViewport?.();
        stopTemplateViewport = null;
        resetModalViewport(templateCreatorModal);
        if (templateCreatorModal) templateCreatorModal.removeClass('active');
    }

    function createStyleFromTemplate() {
        const activeTab = templateCreatorModal.find('.ec_tab_btn.active').data('tab');
        let styleName, stylePrompt;

        if (activeTab === 'advanced') {
            // Advanced mode - use raw prompt
            styleName = jQuery('#ec_tpl_adv_name').val().trim() || 'Custom Style';
            stylePrompt = jQuery('#ec_tpl_adv_prompt').val().trim();
            if (!stylePrompt) {
                if (typeof toastr !== 'undefined') toastr.warning('Please enter a system prompt.');
                return;
            }
        } else {
            // Easy mode - build prompt from form
            styleName = jQuery('#ec_tpl_name').val().trim() || 'Custom Style';
            const type = jQuery('#ec_tpl_type').val();
            const format = jQuery('#ec_tpl_format').val().trim() || 'username: message';
            const identity = jQuery('#ec_tpl_identity').val().trim();
            const personality = jQuery('#ec_tpl_personality').val().trim();
            const toneSelect = jQuery('#ec_tpl_tone').val();
            const customTone = jQuery('#ec_tpl_custom_tone').val().trim();
            const length = jQuery('#ec_tpl_length').val();
            const interact = jQuery('#ec_tpl_interact').val() === 'yes';
            const useEmoji = jQuery('#ec_tpl_emoji').is(':checked');
            const useSlang = jQuery('#ec_tpl_slang').is(':checked');
            const useLowercase = jQuery('#ec_tpl_lowercase').is(':checked');
            const useTypos = jQuery('#ec_tpl_typos').is(':checked');
            const useAllCaps = jQuery('#ec_tpl_allcaps').is(':checked');
            const useHashtags = jQuery('#ec_tpl_hashtags').is(':checked');
            const useMentions = jQuery('#ec_tpl_mentions').is(':checked');
            const useFormal = jQuery('#ec_tpl_formal').is(':checked');

            // Build the prompt
            const toneDescriptions = {
                chaotic: 'chaotic, energetic, and excitable',
                calm: 'calm, thoughtful, and reflective',
                sarcastic: 'sarcastic, witty, and playfully mocking',
                wholesome: 'wholesome, supportive, and kind',
                cynical: 'cynical, tired, and darkly humorous',
                explicit: 'explicit, unfiltered, and provocative'
            };

            const lengthDescriptions = {
                short: '1-2 sentences maximum',
                medium: '2-3 complete sentences',
                long: '1-3 paragraphs with 3-5 sentences each'
            };

            // Get tone description - use custom if selected
            const toneDescription = toneSelect === 'custom' && customTone
                ? customTone
                : (toneDescriptions[toneSelect] || 'varied and natural');

            // Build prompt with XML format
            let prompt = '';

            // Opening
            if (identity) {
                prompt += `${identity}\n\n`;
            } else {
                prompt += `You will be acting as a ${type === 'chat' ? 'chat feed audience' : 'narrator'}. Your goal is to simulate ${type === 'chat' ? 'messages' : 'commentary'} reacting to the unfolding events.\n\n`;
            }

            // Usernames section
            if (type === 'chat') {
                prompt += `<usernames>\n`;
                prompt += `- Generate NEW random usernames each time\n`;
                prompt += `- Make them creative, varied, and contextually appropriate\n`;
                prompt += `- Align them with the conversation context\n`;
                prompt += `</usernames>\n\n`;
            }

            // Personality section
            if (personality) {
                prompt += `<personalities>\n`;
                prompt += `- ${personality}\n`;
                prompt += `- Messages should be ${toneDescription}\n`;
                prompt += `</personalities>\n\n`;
            } else {
                prompt += `<personalities>\n`;
                prompt += `- Messages should be ${toneDescription}\n`;
                prompt += `- Mix different personality types and reactions\n`;
                prompt += `- Vary the tone and engagement level\n`;
                prompt += `</personalities>\n\n`;
            }

            // Style section
            const styleElements = [];
            if (useEmoji) styleElements.push('Use emojis');
            if (useSlang) styleElements.push('Use internet slang');
            if (useLowercase) styleElements.push('Prefer lowercase');
            if (useTypos) styleElements.push('Include occasional typos');
            if (useAllCaps) styleElements.push('Use ALL CAPS for emphasis occasionally');
            if (useHashtags) styleElements.push('Include hashtags');
            if (useMentions) styleElements.push('Use @mentions between users');
            if (useFormal) styleElements.push('Use proper grammar and punctuation');
            styleElements.push(`Each message should be ${lengthDescriptions[length]}`);

            prompt += `<style>\n`;
            styleElements.forEach(element => prompt += `- ${element}\n`);
            prompt += `</style>\n\n`;

            // Interactions section
            if (type === 'chat') {
                prompt += `<interactions>\n`;
                if (interact) {
                    prompt += `- Users may respond to each other\n`;
                    prompt += `- Users can agree, disagree, or build on previous comments\n`;
                    prompt += `- Reference what others said\n`;
                } else {
                    prompt += `- Each message is independent\n`;
                    prompt += `- No direct replies between users\n`;
                }
                prompt += `</interactions>\n\n`;
            }

            // Format instruction at the end
            prompt += `You must format your responses using the following format:\n`;
            prompt += `<format>\n`;
            prompt += `${format}\n`;
            prompt += `</format>`;

            stylePrompt = prompt.trim();
        }

        // Validate input types
        if (typeof styleName !== 'string' || typeof stylePrompt !== 'string') {
            if (typeof toastr !== 'undefined') toastr.error('Invalid input type');
            return;
        }

        // Create the style
        const id = 'custom_' + Date.now();
        if (!settings.custom_styles) settings.custom_styles = {};
        settings.custom_styles[id] = {
            name: styleName,
            prompt: stylePrompt
        };
        saveSettings();

        closeTemplateCreator();

        // Refresh style list and select new style
        populateStyleList();
        selectStyleInEditor(id);
        updateAllDropdowns();

        // Sanitize style name for display
        const { DOMPurify } = SillyTavern.libs;
        const safeStyleName = DOMPurify.sanitize(styleName, { ALLOWED_TAGS: [] });
        if (typeof toastr !== 'undefined') toastr.success(`Style "${safeStyleName}" created!`);
    }

    function createNewStyle() {
        openTemplateCreator();
    }

    function saveStyleFromEditor() {
        if (!currentEditingStyle) return;

        const name = jQuery('#ec_style_name').val().trim();
        const content = jQuery('#ec_style_content').val();

        // Validate input types
        if (typeof name !== 'string' || typeof content !== 'string') {
            if (typeof toastr !== 'undefined') toastr.error('Invalid input type');
            return;
        }

        if (!name) {
            if (typeof toastr !== 'undefined') toastr.error('Style name cannot be empty');
            return;
        }

        const isCustom = settings.custom_styles && settings.custom_styles[currentEditingStyle];

        if (isCustom) {
            // Update existing custom style
            settings.custom_styles[currentEditingStyle].name = name;
            settings.custom_styles[currentEditingStyle].prompt = content;
        } else {
            // Save modified built-in as new custom style
            // Check if content differs from original
            const id = 'custom_' + currentEditingStyle + '_' + Date.now();
            if (!settings.custom_styles) settings.custom_styles = {};
            settings.custom_styles[id] = {
                name: name + ' (Custom)',
                prompt: content
            };
            currentEditingStyle = id;
        }

        saveSettings();
        populateStyleList();

        // Sanitize currentEditingStyle for safe DOM query
        const { DOMPurify } = SillyTavern.libs;
        const safeId = DOMPurify.sanitize(currentEditingStyle, { ALLOWED_TAGS: [] });
        jQuery(`.ec_style_item[data-id="${safeId}"]`).addClass('active');
        setStyleEditorCollapsed(false);
        revealSelectedStyle();
        updateAllDropdowns();

        const safeName = DOMPurify.sanitize(name, { ALLOWED_TAGS: [] });
        if (typeof toastr !== 'undefined') toastr.success(`Style "${safeName}" saved!`);
        log('Style saved:', currentEditingStyle);
    }

    function deleteStyleFromEditor() {
        if (!currentEditingStyle) return;

        const isCustom = settings.custom_styles && settings.custom_styles[currentEditingStyle];

        if (isCustom) {
            if (!confirm('Delete this custom style? This cannot be undone.')) return;
            delete settings.custom_styles[currentEditingStyle];
        } else {
            if (!confirm('Hide this built-in style? You can restore it by clearing deleted styles.')) return;
            if (!settings.deleted_styles) settings.deleted_styles = [];
            settings.deleted_styles.push(currentEditingStyle);
        }

        saveSettings();
        currentEditingStyle = null;
        populateStyleList();
        showEmptyState();

        if (typeof toastr !== 'undefined') toastr.info('Style removed');
    }

    function exportStyle(styleId) {
        if (!styleId) return;

        const content = jQuery('#ec_style_content').val();
        const name = jQuery('#ec_style_name').val() || styleId;

        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (typeof toastr !== 'undefined') toastr.success('Style exported!');
    }

    // ============================================================
    // SETTINGS MODAL
    // ============================================================

    function openSettingsModal() {
        // Remove any existing modal
        jQuery('#ec_settings_modal').trigger('ecm:close');
        jQuery('#ec_settings_modal').remove();

        // Hide floating panel on mobile when opening settings modal
        const isMobileDevice = window.innerWidth <= 768;
        if (isMobileDevice && floatingPanelOpen) {
            jQuery('#ec_floating_panel').hide();
        }

        const styles = getAllStyles();
        const s = settings;

        // Build style options
        const styleOptions = styles.map(st =>
            `<option value="${st.val}"${s.style === st.val ? ' selected' : ''}>${st.label}</option>`
        ).join('');

        // Build source options with sub-panel visibility
        const ollamaVisible = s.source === 'ollama' ? '' : 'display:none;';
        const openaiVisible = s.source === 'openai' ? '' : 'display:none;';
        const profileVisible = s.source === 'profile' ? '' : 'display:none;';
        const contextDepthVisible = s.includeUserInput ? '' : 'display:none;';
        const wibudgetVisible = s.includeWorldInfo ? '' : 'display:none;';
        const livestreamVisible = s.livestream ? '' : 'display:none;';

        const modal = jQuery(`
<div id="ec_settings_modal" role="dialog" aria-modal="true" aria-label="EchoChamber Settings">
  <div class="ecm_backdrop"></div>
  <div class="ecm_card">

    <div class="ecm_header">
      <div class="ecm_header_title"><i class="fa-solid fa-gear"></i> EchoChamber Settings</div>
      <div class="ecm_close_btn" id="ecm_close" title="Close"><i class="fa-solid fa-xmark"></i></div>
    </div>

    <div class="ecm_layout">

      <!-- SIDEBAR (desktop only) -->
      <nav class="ecm_sidebar" aria-label="Settings navigation">
        <ul class="ecm_nav_list">
          <li><a class="ecm_nav_item" data-target="ecm-sect-general" role="button" tabindex="0">
            <i class="fa-solid fa-power-off"></i><span>General</span>
          </a></li>
          <li><a class="ecm_nav_item" data-target="ecm-sect-engine" role="button" tabindex="0">
            <i class="fa-solid fa-microchip"></i><span>Generation Engine</span>
          </a></li>
          <li><a class="ecm_nav_item" data-target="ecm-sect-display" role="button" tabindex="0">
            <i class="fa-solid fa-sliders"></i><span>Display</span>
          </a></li>
          <li><a class="ecm_nav_item" data-target="ecm-sect-content" role="button" tabindex="0">
            <i class="fa-solid fa-list-check"></i><span>Content Settings</span>
          </a></li>
          <li><a class="ecm_nav_item" data-target="ecm-sect-livestream" role="button" tabindex="0">
            <i class="fa-solid fa-tower-broadcast"></i><span>Livestream</span>
          </a></li>
          <li><a class="ecm_nav_item" data-target="ecm-sect-chat" role="button" tabindex="0">
            <i class="fa-solid fa-reply"></i><span>Chat Participation</span>
          </a></li>
        </ul>
      </nav>

      <!-- RIGHT CONTENT PANE -->
      <div class="ecm_content" id="ecm_content_pane">

        <!-- GENERAL -->
         <section class="ecm_section ecm_acc" data-acc-open id="ecm-sect-general">
          <button class="ecm_acc_header" aria-expanded="false" type="button">
            <span class="ecm_acc_title"><i class="fa-solid fa-power-off"></i> General</span>
            <i class="ecm_acc_chevron fa-solid fa-chevron-down"></i>
          </button>
          <div class="ecm_acc_body" hidden>
            <label class="ecm_row ecm_toggle_row" for="ecm_enabled">
              <span class="ecm_label">Enable EchoChamber</span>
              <input id="ecm_enabled" type="checkbox" class="ecm_toggle"${s.enabled ? ' checked' : ''}>
            </label>
          </div>
        </section>

        <!-- GENERATION ENGINE -->
        <section class="ecm_section ecm_acc" id="ecm-sect-engine">
          <button class="ecm_acc_header" aria-expanded="false" type="button">
            <span class="ecm_acc_title"><i class="fa-solid fa-microchip"></i> Generation Engine</span>
            <i class="ecm_acc_chevron fa-solid fa-chevron-down"></i>
          </button>
          <div class="ecm_acc_body" hidden>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_source">Source</label>
              <select id="ecm_source" class="ecm_select">
                <option value="default"${s.source === 'default' ? ' selected' : ''}>Default (Main API)</option>
                <option value="profile"${s.source === 'profile' ? ' selected' : ''}>Connection Profile</option>
                <option value="ollama"${s.source === 'ollama' ? ' selected' : ''}>Ollama (Local)</option>
                <option value="openai"${s.source === 'openai' ? ' selected' : ''}>OpenAI Compatible</option>
              </select>
            </div>
            <div id="ecm_ollama_settings" class="ecm_subpanel ecm_subpanel_green" style="${ollamaVisible}">
              <div class="ecm_subpanel_title"><i class="fa-solid fa-terminal"></i> Ollama</div>
              <input id="ecm_url" type="text" class="ecm_input ecm_input_gap" placeholder="http://localhost:11434" value="${s.url || ''}">
              <select id="ecm_model_select" class="ecm_select"></select>
              <div id="ecm_ollama_status" class="ecm_hint"></div>
            </div>
            <div id="ecm_openai_settings" class="ecm_subpanel ecm_subpanel_blue" style="${openaiVisible}">
              <div class="ecm_subpanel_title"><i class="fa-solid fa-cloud"></i> OpenAI Compatible</div>
              <select id="ecm_openai_preset" class="ecm_select ecm_input_gap">
                <option value="custom"${s.openai_preset === 'custom' ? ' selected' : ''}>Custom</option>
                <option value="lmstudio"${s.openai_preset === 'lmstudio' ? ' selected' : ''}>LM Studio (:1234)</option>
                <option value="kobold"${s.openai_preset === 'kobold' ? ' selected' : ''}>KoboldCPP (:5001)</option>
                <option value="textgen"${s.openai_preset === 'textgen' ? ' selected' : ''}>TextGenWebUI (:5000)</option>
                <option value="vllm"${s.openai_preset === 'vllm' ? ' selected' : ''}>vLLM (:8000)</option>
              </select>
              <input id="ecm_openai_url" type="text" class="ecm_input ecm_input_gap" placeholder="http://localhost:1234/v1" value="${s.openai_url || ''}">
              <input id="ecm_openai_key" type="password" class="ecm_input ecm_input_gap" placeholder="API Key (Optional)" value="${s.openai_key || ''}">
              <input id="ecm_openai_model" type="text" class="ecm_input" placeholder="Model name" value="${s.openai_model || ''}">
            </div>
            <div id="ecm_profile_settings" class="ecm_subpanel ecm_subpanel_purple" style="${profileVisible}">
              <div class="ecm_subpanel_title"><i class="fa-solid fa-link"></i> Connection Profile</div>
              <select id="ecm_preset_select" class="ecm_select"></select>
              <div class="ecm_hint"><i class="fa-solid fa-shield-halved"></i> Uses your existing ST credentials securely.</div>
            </div>
          </div>
        </section>

        <!-- DISPLAY -->
         <section class="ecm_section ecm_acc" id="ecm-sect-display">
          <button class="ecm_acc_header" aria-expanded="false" type="button">
            <span class="ecm_acc_title"><i class="fa-solid fa-sliders"></i> Display</span>
            <i class="ecm_acc_chevron fa-solid fa-chevron-down"></i>
          </button>
          <div class="ecm_acc_body" hidden>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_style">Style</label>
              <select id="ecm_style" class="ecm_select">${styleOptions}</select>
            </div>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_position">Position</label>
              <select id="ecm_position" class="ecm_select">
                <option value="bottom"${s.position === 'bottom' ? ' selected' : ''}>Bottom</option>
                <option value="top"${s.position === 'top' ? ' selected' : ''}>Top</option>
                <option value="left"${s.position === 'left' ? ' selected' : ''}>Left</option>
                <option value="right"${s.position === 'right' ? ' selected' : ''}>Right</option>
              </select>
            </div>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_user_count">Users</label>
              <select id="ecm_user_count" class="ecm_select">
                <!-- Generating options 1-20 inline -->
                ${Array.from({ length: 20 }, (_, i) => i + 1).map(n => `<option value="${n}"${(s.userCount || 5) == n ? ' selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_font_size">Font Size (px)</label>
              <select id="ecm_font_size" class="ecm_select">
                <!-- Generating options 8-24 inline -->
                ${Array.from({ length: 17 }, (_, i) => i + 8).map(n => `<option value="${n}"${(s.fontSize || 15) == n ? ' selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_opacity">Opacity <span id="ecm_opacity_val">${s.opacity || 85}%</span></label>
              <input id="ecm_opacity" type="range" class="ecm_slider" min="10" max="100" step="5" value="${s.opacity || 85}">
            </div>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_message_order"><i class="fa-solid fa-arrow-down-up-across-line ecm_icon"></i> Message Order</label>
              <select id="ecm_message_order" class="ecm_select">
                <option value="oldest-first"${(s.messageOrder || 'oldest-first') === 'oldest-first' ? ' selected' : ''}>Oldest at top, newest at bottom</option>
                <option value="newest-first"${s.messageOrder === 'newest-first' ? ' selected' : ''}>Newest at top, oldest at bottom</option>
              </select>
            </div>
          </div>
        </section>

        <!-- CONTENT SETTINGS -->
         <section class="ecm_section ecm_acc" id="ecm-sect-content">
          <button class="ecm_acc_header" aria-expanded="false" type="button">
            <span class="ecm_acc_title"><i class="fa-solid fa-list-check"></i> Content Settings</span>
            <i class="ecm_acc_chevron fa-solid fa-chevron-down"></i>
          </button>
          <div class="ecm_acc_body" hidden>
            <label class="ecm_row ecm_toggle_row" for="ecm_auto_update">
              <span class="ecm_label"><i class="fa-solid fa-sync ecm_icon"></i> Auto-update On Messages</span>
              <input id="ecm_auto_update" type="checkbox" class="ecm_toggle"${s.autoUpdateOnMessages !== false ? ' checked' : ''}>
            </label>
            <label class="ecm_row ecm_toggle_row" for="ecm_include_user">
              <span class="ecm_label"><i class="fa-solid fa-comments ecm_icon"></i> Include Chat History</span>
              <input id="ecm_include_user" type="checkbox" class="ecm_toggle"${s.includeUserInput ? ' checked' : ''}>
            </label>
            <div id="ecm_context_depth_container" class="ecm_subrow" style="${contextDepthVisible}">
              <label class="ecm_label" for="ecm_context_depth">Context Depth</label>
              <input id="ecm_context_depth" type="number" class="ecm_input ecm_input_sm" min="2" max="20" value="${s.contextDepth || 4}">
            </div>
            <label class="ecm_row ecm_toggle_row" for="ecm_include_past_echo">
              <span class="ecm_label"><i class="fa-solid fa-layer-group ecm_icon"></i> Include Past EchoChambers</span>
              <input id="ecm_include_past_echo" type="checkbox" class="ecm_toggle"${s.includePastEchoChambers ? ' checked' : ''}>
            </label>
            <div class="ecm_subpanel_plain">
              <div class="ecm_subpanel_title"><i class="fa-solid fa-file-lines"></i> Include in Context</div>
              <label class="ecm_row ecm_toggle_row" for="ecm_include_persona">
                <span class="ecm_label"><i class="fa-solid fa-face-smile ecm_icon"></i> Persona</span>
                <input id="ecm_include_persona" type="checkbox" class="ecm_toggle"${s.includePersona ? ' checked' : ''}>
              </label>
              <label class="ecm_row ecm_toggle_row" for="ecm_include_authors_note">
                <span class="ecm_label"><i class="fa-solid fa-pen-nib ecm_icon"></i> Author's Note</span>
                <input id="ecm_include_authors_note" type="checkbox" class="ecm_toggle"${s.includeAuthorsNote ? ' checked' : ''}>
              </label>
              <label class="ecm_row ecm_toggle_row" for="ecm_include_character_description">
                <span class="ecm_label"><i class="fa-solid fa-address-card ecm_icon"></i> Character Description(s)</span>
                <input id="ecm_include_character_description" type="checkbox" class="ecm_toggle"${s.includeCharacterDescription ? ' checked' : ''}>
              </label>
              <label class="ecm_row ecm_toggle_row" for="ecm_include_summary">
                <span class="ecm_label"><i class="fa-solid fa-scroll ecm_icon"></i> Summary (from Summarize ext.)</span>
                <input id="ecm_include_summary" type="checkbox" class="ecm_toggle"${s.includeSummary ? ' checked' : ''}>
              </label>
              <label class="ecm_row ecm_toggle_row" for="ecm_include_world_info">
                <span class="ecm_label"><i class="fa-solid fa-globe ecm_icon"></i> World Info / Lorebook</span>
                <input id="ecm_include_world_info" type="checkbox" class="ecm_toggle"${s.includeWorldInfo ? ' checked' : ''}>
              </label>
              <div id="ecm_wi_budget_container" class="ecm_subrow" style="${wibudgetVisible}">
                <label class="ecm_label" for="ecm_wi_budget"><i class="fa-solid fa-coins ecm_icon"></i> WI Token Budget</label>
                <input id="ecm_wi_budget" type="number" class="ecm_input ecm_input_sm" min="0" max="200000" step="1000" value="${s.wiBudget || 0}">
              </div>
            </div>
          </div>
        </section>

        <!-- LIVESTREAM -->
        <section class="ecm_section ecm_acc" id="ecm-sect-livestream">
          <button class="ecm_acc_header" aria-expanded="false" type="button">
            <span class="ecm_acc_title"><i class="fa-solid fa-tower-broadcast"></i> Livestream</span>
            <i class="ecm_acc_chevron fa-solid fa-chevron-down"></i>
          </button>
          <div class="ecm_acc_body" hidden>
            <label class="ecm_row ecm_toggle_row" for="ecm_livestream">
              <span class="ecm_label">Enable Livestream Mode</span>
              <input id="ecm_livestream" type="checkbox" class="ecm_toggle"${s.livestream ? ' checked' : ''}>
            </label>
            <div id="ecm_livestream_settings" style="${livestreamVisible}">
              <label class="ecm_row ecm_toggle_row" for="ecm_livestream_auto_scroll">
                <span class="ecm_label"><i class="fa-solid fa-angles-down ecm_icon"></i> Auto-scroll to Latest Message</span>
                <input id="ecm_livestream_auto_scroll" type="checkbox" class="ecm_toggle"${s.livestreamAutoScroll !== false ? ' checked' : ''}>
              </label>
              <div class="ecm_row">
                <label class="ecm_label" for="ecm_livestream_batch_size"><i class="fa-solid fa-boxes-stacked ecm_icon"></i> Batch Size</label>
                <input id="ecm_livestream_batch_size" type="number" class="ecm_input ecm_input_sm" min="5" max="50" value="${s.livestreamBatchSize || 20}">
              </div>
              <div class="ecm_row">
                <label class="ecm_label" for="ecm_livestream_min_wait"><i class="fa-solid fa-clock ecm_icon"></i> Min Wait (s)</label>
                <input id="ecm_livestream_min_wait" type="number" class="ecm_input ecm_input_sm" min="1" max="120" value="${s.livestreamMinWait || 5}">
              </div>
              <div class="ecm_row">
                <label class="ecm_label" for="ecm_livestream_max_wait"><i class="fa-solid fa-clock ecm_icon"></i> Max Wait (s)</label>
                <input id="ecm_livestream_max_wait" type="number" class="ecm_input ecm_input_sm" min="1" max="300" value="${s.livestreamMaxWait || 60}">
              </div>
              <div class="ecm_subpanel_plain">
                <div class="ecm_subpanel_title"><i class="fa-solid fa-clapperboard"></i> Generation Mode</div>
                <label class="ecm_radio_row" for="ecm_ls_manual">
                   <input type="radio" id="ecm_ls_manual" name="ecm_livestream_mode" value="manual"${(s.livestreamMode || 'manual') === 'manual' ? ' checked' : ''}><span>Manual (Regenerate Chat)</span>
                 </label>
                 <label class="ecm_radio_row" for="ecm_ls_onmessage">
                   <input type="radio" id="ecm_ls_onmessage" name="ecm_livestream_mode" value="onMessage"${s.livestreamMode === 'onMessage' ? ' checked' : ''}><span>On New Message</span>
                 </label>
                 <label class="ecm_radio_row" for="ecm_ls_oncomplete">
                   <input type="radio" id="ecm_ls_oncomplete" name="ecm_livestream_mode" value="onComplete"${s.livestreamMode === 'onComplete' ? ' checked' : ''}><span>After Batch Completes</span>
                 </label>
              </div>
            </div>
          </div>
        </section>

        <!-- CHAT PARTICIPATION -->
        <section class="ecm_section ecm_acc" id="ecm-sect-chat">
          <button class="ecm_acc_header" aria-expanded="false" type="button">
            <span class="ecm_acc_title"><i class="fa-solid fa-reply"></i> Chat Participation</span>
            <i class="ecm_acc_chevron fa-solid fa-chevron-down"></i>
          </button>
          <div class="ecm_acc_body" hidden>
            <label class="ecm_row ecm_toggle_row" for="ecm_chat_enabled">
              <span class="ecm_label">Enable Chat Participation</span>
              <input id="ecm_chat_enabled" type="checkbox" class="ecm_toggle"${s.chatEnabled !== false ? ' checked' : ''}>
            </label>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_chat_username"><i class="fa-solid fa-user ecm_icon"></i> Your Username</label>
              <input id="ecm_chat_username" type="text" class="ecm_input" placeholder="Streamer (You)" value="${s.chatUsername || 'Streamer (You)'}">
            </div>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_chat_avatar_color"><i class="fa-solid fa-circle ecm_icon"></i> Avatar Color</label>
              <div style="display:flex;align-items:center;gap:8px;">
                <input id="ecm_chat_avatar_color" type="color" class="ecm_color_input" value="${s.chatAvatarColor || '#3b82f6'}" style="width:44px;height:36px;padding:2px;border-radius:6px;border:1px solid var(--ec-border);cursor:pointer;background:transparent;">
                <span class="ecm_hint" style="margin:0;">Your avatar circle color</span>
              </div>
            </div>
            <div class="ecm_row">
              <label class="ecm_label" for="ecm_chat_reply_count"><i class="fa-solid fa-comments ecm_icon"></i> AI Replies per Comment</label>
              <input id="ecm_chat_reply_count" type="number" class="ecm_input" min="1" max="12" value="${s.chatReplyCount || 3}" style="width:70px;">
            </div>
            <div class="ecm_hint">Number of AI responses after a general comment (1–12). Direct @mentions always get a single reply.</div>
          </div>
        </section>

      </div><!-- /ecm_content -->
    </div><!-- /ecm_layout -->

    <div class="ecm_footer">
      <div class="ecm_footer_left">
        <button class="ecm_footer_btn" id="ecm_style_manager_btn"><i class="fa-solid fa-palette"></i> Style Manager</button>
        <button class="ecm_footer_btn" id="ecm_import_btn"><i class="fa-solid fa-file-import"></i> Import</button>
        <input type="file" id="ecm_import_file" accept=".md" style="display:none;">
      </div>
      <div class="ecm_footer_right">
        <button class="ecm_done_btn" id="ecm_done"><i class="fa-solid fa-check"></i> Done</button>
      </div>
    </div>

  </div><!-- /ecm_card -->
</div>`);

        jQuery('body').append(modal);
        const stopViewport = trackModalViewport(modal);
        modal.one('ecm:close', stopViewport);


        // Populate Ollama model select from existing settings panel
        const existingModels = jQuery('#discord_model_select option');
        existingModels.each(function () {
            const opt = jQuery(this).clone();
            if (jQuery(this).val() === s.model) opt.prop('selected', true);
            jQuery('#ecm_model_select').append(opt);
        });

        // Populate connection profile select from existing settings panel
        const existingProfiles = jQuery('#discord_preset_select option');
        existingProfiles.each(function () {
            const opt = jQuery(this).clone();
            if (jQuery(this).val() === s.preset) opt.prop('selected', true);
            jQuery('#ecm_preset_select').append(opt);
        });

        // Show/animate in
        requestAnimationFrame(() => {
            modal.addClass('ecm_visible');

            // Mobile: force explicit viewport sizing to fix iOS/Android modal display issues
            // (same fix used in SillyTavern-Larson for its settings overlay)
            if (window.innerWidth <= 768) {
                const modalEl = modal[0];
                const cardEl = modal.find('.ecm_card')[0];
                const layoutEl = modal.find('.ecm_layout')[0];
                if (modalEl) {
                    modalEl.style.display = 'flex';
                    modalEl.style.alignItems = 'center';
                    modalEl.style.justifyContent = 'center';
                }
                if (cardEl) {
                    cardEl.style.position = 'relative';
                    cardEl.style.top = 'auto';
                    cardEl.style.left = 'auto';
                    cardEl.style.bottom = 'auto';
                    cardEl.style.right = 'auto';
                    cardEl.style.transform = 'none';
                    cardEl.style.margin = 'auto';
                    cardEl.style.maxHeight = '90dvh';
                    cardEl.style.overflowY = 'auto';
                    cardEl.style.overflowX = 'hidden';
                }
                if (layoutEl) {
                    // Layout uses CSS flex scrolling on mobile - no override needed
                }
            }
        });

        // ---- Event Bindings ----

        // Close handlers (click + touchend for mobile)
        modal.find('.ecm_backdrop, #ecm_close, #ecm_done').on('click touchend', function (e) {
            if (e.type === 'touchend') e.preventDefault();
            closeSettingsModal();
        });
        // Stop click propagation on card so backdrop click-to-close doesn't fire when clicking inside
        modal.find('.ecm_card').on('click', e => e.stopPropagation());

        // Style Manager button — close settings modal then open style editor
        modal.find('#ecm_style_manager_btn').on('click', function () {
            closeSettingsModal();
            setTimeout(() => openStyleEditor(), 320);
        });

        // Import button — trigger the hidden file input
        modal.find('#ecm_import_btn').on('click', function () {
            modal.find('#ecm_import_file').click();
        });

        // Import file selected — same logic as settings panel import
        modal.find('#ecm_import_file').on('change', function () {
            const file = this.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function (e) {
                const content = e.target.result;
                const name = file.name.replace(/\.md$/i, '');
                const id = 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
                if (!settings.custom_styles) settings.custom_styles = {};
                settings.custom_styles[id] = { name: name, prompt: content };
                saveSettings();
                updateAllDropdowns();
                if (typeof toastr !== 'undefined') toastr.success(`Imported style: ${name}`);
            };
            reader.readAsText(file);
            this.value = '';
        });

        // Escape key
        jQuery(document).on('keydown.ecm', function (e) {
            if (e.key === 'Escape') closeSettingsModal();
        });

        // ---- Two-pane vs accordion depending on viewport ----
        const isMobile = () => window.innerWidth <= 768;
        const contentPane = modal.find('#ecm_content_pane')[0];

        if (!isMobile()) {
            // DESKTOP: reveal all section bodies immediately
            modal.find('.ecm_acc_body').each(function () { this.hidden = false; });

            // ---- Sidebar navigation ----
            const navItems = modal.find('.ecm_nav_item');
            navItems.first().addClass('ecm_nav_active');
            let isAutoScrolling = false;
            let scrollTimeout;

            navItems.on('click', function (e) {
                e.preventDefault();
                const target = this.dataset.target;
                const sect = document.getElementById(target);
                if (sect && contentPane) {
                    isAutoScrolling = true;
                    navItems.removeClass('ecm_nav_active');
                    jQuery(this).addClass('ecm_nav_active');

                    sect.scrollIntoView({ behavior: 'smooth', block: 'start' });

                    clearTimeout(scrollTimeout);
                    scrollTimeout = setTimeout(() => {
                        isAutoScrolling = false;
                    }, 800); // Re-enable observer after smooth scroll completes
                }
            });

            // ---- ScrollSpy via IntersectionObserver ----
            if (contentPane && window.IntersectionObserver) {
                const sects = modal.find('.ecm_section[id]').toArray();
                const spy = new IntersectionObserver((entries) => {
                    if (isAutoScrolling) return; // Skip highlights if manually clicked nav
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            const id = entry.target.id;
                            navItems.removeClass('ecm_nav_active');
                            modal.find(`.ecm_nav_item[data-target="${id}"]`).addClass('ecm_nav_active');
                        }
                    });
                }, { root: contentPane, rootMargin: '-5% 0px -80% 0px', threshold: 0 });
                sects.forEach(s => spy.observe(s));
                // Disconnect when modal closes
                modal.on('ecm:close', () => spy.disconnect());
            }
        } else {
            // MOBILE: accordion — open data-acc-open sections by default
            modal.find('.ecm_acc[data-acc-open]').each(function () {
                const btn = jQuery(this).find('.ecm_acc_header')[0];
                const body = jQuery(this).find('.ecm_acc_body')[0];
                if (btn && body) { btn.setAttribute('aria-expanded', 'true'); body.hidden = false; }
            });
            // Accordion toggle handler (mobile only) — click + touchend for mobile
            modal.find('.ecm_acc_header').on('click touchend', function (e) {
                if (e.type === 'touchend') e.preventDefault();
                const expanded = this.getAttribute('aria-expanded') === 'true';
                const body = this.nextElementSibling;
                // On phones (≤480px) close all other open sections before opening a new one
                if (!expanded && window.innerWidth <= 480) {
                    modal.find('.ecm_acc_header[aria-expanded="true"]').each(function () {
                        if (this !== e.currentTarget) {
                            this.setAttribute('aria-expanded', 'false');
                            if (this.nextElementSibling) this.nextElementSibling.hidden = true;
                        }
                    });
                }
                this.setAttribute('aria-expanded', String(!expanded));
                if (body) body.hidden = expanded;
            });
        }


        // Helper: sync a settings-panel element after modal change
        function syncToPanel(panelId, value, isProp = false) {
            const el = jQuery(`#${panelId}`);
            if (!el.length) return;
            if (isProp) el.prop('checked', value).trigger('change');
            else el.val(value).trigger('change');
        }

        // General
        modal.on('change', '#ecm_enabled', function () {
            syncToPanel('discord_enabled', this.checked, true);
        });

        // Generation Engine
        modal.on('change', '#ecm_source', function () {
            syncToPanel('discord_source', jQuery(this).val());
            // Show/hide sub-panels
            const src = jQuery(this).val();
            modal.find('#ecm_ollama_settings').toggle(src === 'ollama');
            modal.find('#ecm_openai_settings').toggle(src === 'openai');
            modal.find('#ecm_profile_settings').toggle(src === 'profile');
        });
        modal.on('change', '#ecm_url', function () { syncToPanel('discord_url', jQuery(this).val()); });
        modal.on('change', '#ecm_model_select', function () { syncToPanel('discord_model_select', jQuery(this).val()); });
        modal.on('change', '#ecm_openai_preset', function () { syncToPanel('discord_openai_preset', jQuery(this).val()); });
        modal.on('change', '#ecm_openai_url', function () { syncToPanel('discord_openai_url', jQuery(this).val()); });
        modal.on('change', '#ecm_openai_key', function () { syncToPanel('discord_openai_key', jQuery(this).val()); });
        modal.on('change', '#ecm_openai_model', function () { syncToPanel('discord_openai_model', jQuery(this).val()); });
        modal.on('change', '#ecm_preset_select', function () { syncToPanel('discord_preset_select', jQuery(this).val()); });

        // Display
        modal.on('change', '#ecm_style', function () {
            const val = jQuery(this).val();
            settings.style = val;
            saveSettings();
            updateStyleIndicator();
            jQuery('#discord_style').val(val);
            // Also update panel style menu selection
            jQuery('.ec_menu_item[data-val]').each(function () {
                const mi = jQuery(this);
                const inStyleMenu = mi.closest('.ec_style_menu').length > 0;
                if (inStyleMenu) mi.toggleClass('selected', mi.data('val') === val);
            });
        });
        modal.on('change', '#ecm_position', function () {
            const val = jQuery(this).val();
            settings.position = val;
            saveSettings();
            updateApplyLayout();
            jQuery('#discord_position').val(val);
        });
        modal.on('change', '#ecm_user_count', function () {
            settings.userCount = parseInt(jQuery(this).val()) || 5;
            saveSettings();
            jQuery('#discord_user_count').val(settings.userCount);
            // Update panel user menu
            jQuery('.ec_menu_item[data-val]').filter(function () {
                return jQuery(this).closest('.ec_user_menu').length > 0;
            }).each(function () {
                jQuery(this).toggleClass('selected', parseInt(jQuery(this).data('val')) === settings.userCount);
            });
        });
        modal.on('change', '#ecm_font_size', function () {
            settings.fontSize = parseInt(jQuery(this).val()) || 15;
            applyFontSize(settings.fontSize);
            saveSettings();
            jQuery('#discord_font_size').val(settings.fontSize);
        });
        modal.on('input change', '#ecm_opacity', function () {
            settings.opacity = parseInt(jQuery(this).val()) || 85;
            modal.find('#ecm_opacity_val').text(settings.opacity + '%');
            jQuery('#discord_opacity').val(settings.opacity).trigger('input');
        });
        modal.on('change', '#ecm_message_order', function () {
            settings.messageOrder = jQuery(this).val();
            saveSettings();
            applyMessageOrder();
            jQuery('#discord_message_order').val(settings.messageOrder);
        });

        // Content Settings
        modal.on('change', '#ecm_auto_update', function () { syncToPanel('discord_auto_update', this.checked, true); });
        modal.on('change', '#ecm_include_user', function () {
            const checked = this.checked;
            modal.find('#ecm_context_depth_container').toggle(checked);
            syncToPanel('discord_include_user', checked, true);
        });
        modal.on('change', '#ecm_context_depth', function () { syncToPanel('discord_context_depth', jQuery(this).val()); });
        modal.on('change', '#ecm_include_past_echo', function () { syncToPanel('discord_include_past_echo', this.checked, true); });
        modal.on('change', '#ecm_include_persona', function () { syncToPanel('discord_include_persona', this.checked, true); });
        modal.on('change', '#ecm_include_authors_note', function () { syncToPanel('discord_include_authors_note', this.checked, true); });
        modal.on('change', '#ecm_include_character_description', function () { syncToPanel('discord_include_character_description', this.checked, true); });
        modal.on('change', '#ecm_include_summary', function () { syncToPanel('discord_include_summary', this.checked, true); });
        modal.on('change', '#ecm_include_world_info', function () {
            const checked = this.checked;
            modal.find('#ecm_wi_budget_container').toggle(checked);
            syncToPanel('discord_include_world_info', checked, true);
        });
        modal.on('change', '#ecm_wi_budget', function () { syncToPanel('discord_wi_budget', jQuery(this).val()); });

        // Livestream
        modal.on('change', '#ecm_livestream', function () {
            const checked = this.checked;
            modal.find('#ecm_livestream_settings').toggle(checked);
            toggleLivestream(checked);
        });
        modal.on('change', '#ecm_livestream_batch_size', function () { syncToPanel('discord_livestream_batch_size', jQuery(this).val()); });
        modal.on('change', '#ecm_livestream_min_wait', function () { syncToPanel('discord_livestream_min_wait', jQuery(this).val()); });
        modal.on('change', '#ecm_livestream_max_wait', function () { syncToPanel('discord_livestream_max_wait', jQuery(this).val()); });
        modal.on('change', 'input[name="ecm_livestream_mode"]', function () {
            const val = jQuery(this).val();
            settings.livestreamMode = val;
            saveSettings();
            jQuery(`#discord_livestream_${val === 'manual' ? 'manual' : val === 'onMessage' ? 'onmessage' : 'oncomplete'} `).prop('checked', true);
        });
        modal.on('change', '#ecm_livestream_auto_scroll', function () {
            settings.livestreamAutoScroll = this.checked;
            jQuery('#discord_livestream_auto_scroll').prop('checked', this.checked);
            saveSettings();
        });

        // Chat Participation
        modal.on('change', '#ecm_chat_enabled', function () {
            const enabled = this.checked;
            settings.chatEnabled = enabled;
            syncToPanel('discord_chat_enabled', enabled, true);
            jQuery('.ec_reply_container').toggle(enabled);
            saveSettings();
        });
        modal.on('input', '#ecm_chat_username', function () {
            const username = jQuery(this).val().trim() || 'Streamer (You)';
            settings.chatUsername = username;
            syncToPanel('discord_chat_username', username);
            saveSettings();
        });
        modal.on('input change', '#ecm_chat_avatar_color', function () {
            const color = jQuery(this).val();
            settings.chatAvatarColor = color;
            applyAvatarColor(color);
            jQuery('#discord_chat_avatar_color').val(color);
            saveSettings();
        });
        modal.on('change', '#ecm_chat_reply_count', function () {
            // Only clamp on commit (blur / Enter) so mid-edit backspacing doesn't
            // immediately replace an empty field with the fallback value of 3.
            const val = Math.max(1, Math.min(12, parseInt(jQuery(this).val()) || 3));
            settings.chatReplyCount = val;
            jQuery(this).val(val);
            jQuery('#discord_chat_reply_count').val(val);
            saveSettings();
        });
    }

    function closeSettingsModal() {
        const modal = jQuery('#ec_settings_modal');
        modal.trigger('ecm:close');
        modal.removeClass('ecm_visible');
        jQuery(document).off('keydown.ecm');
        setTimeout(() => modal.remove(), 300);
    }

    // Sync modal inputs from the current settings object (called when panel changes while modal is open)
    function syncModalFromSettings() {
        const modal = jQuery('#ec_settings_modal');
        if (!modal.length) return;
        const s = settings;
        modal.find('#ecm_enabled').prop('checked', s.enabled);
        modal.find('#ecm_source').val(s.source);
        modal.find('#ecm_url').val(s.url);
        modal.find('#ecm_openai_url').val(s.openai_url);
        modal.find('#ecm_openai_key').val(s.openai_key);
        modal.find('#ecm_openai_model').val(s.openai_model);
        modal.find('#ecm_openai_preset').val(s.openai_preset);
        modal.find('#ecm_model_select').val(s.model);
        modal.find('#ecm_preset_select').val(s.preset);
        modal.find('#ecm_style').val(s.style);
        modal.find('#ecm_position').val(s.position);
        modal.find('#ecm_user_count').val(s.userCount);
        modal.find('#ecm_font_size').val(s.fontSize);
        modal.find('#ecm_opacity').val(s.opacity);
        modal.find('#ecm_opacity_val').text((s.opacity || 85) + '%');
        modal.find('#ecm_auto_update').prop('checked', s.autoUpdateOnMessages !== false);
        modal.find('#ecm_include_user').prop('checked', s.includeUserInput);
        modal.find('#ecm_context_depth').val(s.contextDepth);
        modal.find('#ecm_context_depth_container').toggle(!!s.includeUserInput);
        modal.find('#ecm_include_past_echo').prop('checked', s.includePastEchoChambers);
        modal.find('#ecm_include_persona').prop('checked', s.includePersona);
        modal.find('#ecm_include_authors_note').prop('checked', s.includeAuthorsNote);
        modal.find('#ecm_include_character_description').prop('checked', s.includeCharacterDescription);
        modal.find('#ecm_include_summary').prop('checked', s.includeSummary);
        modal.find('#ecm_include_world_info').prop('checked', s.includeWorldInfo);
        modal.find('#ecm_wi_budget').val(s.wiBudget);
        modal.find('#ecm_wi_budget_container').toggle(!!s.includeWorldInfo);
        modal.find('#ecm_livestream').prop('checked', s.livestream);
        modal.find('#ecm_livestream_settings').toggle(!!s.livestream);
        modal.find('#ecm_livestream_auto_scroll').prop('checked', s.livestreamAutoScroll !== false);
        modal.find('#ecm_livestream_batch_size').val(s.livestreamBatchSize);
        modal.find('#ecm_livestream_min_wait').val(s.livestreamMinWait);
        modal.find('#ecm_livestream_max_wait').val(s.livestreamMaxWait);
        const mode = s.livestreamMode || 'manual';
        modal.find(`input[name = "ecm_livestream_mode"][value = "${mode}"]`).prop('checked', true);
        modal.find('#ecm_chat_enabled').prop('checked', s.chatEnabled !== false);
        modal.find('#ecm_chat_username').val(s.chatUsername || 'Streamer (You)');
        modal.find('#ecm_chat_avatar_color').val(s.chatAvatarColor || '#3b82f6');
        modal.find('#ecm_chat_reply_count').val(s.chatReplyCount || 3);
        modal.find('#ecm_ollama_settings').toggle(s.source === 'ollama');
        modal.find('#ecm_openai_settings').toggle(s.source === 'openai');
        modal.find('#ecm_profile_settings').toggle(s.source === 'profile');
        modal.find('#ecm_message_order').val(s.messageOrder || 'oldest-first');
    }

    // ============================================================
    // UI RENDERING
    // ============================================================

    function renderPanel() {
        jQuery('#discordBar').remove();

        discordBar = jQuery('<div id="discordBar"></div>');
        discordQuickBar = jQuery('<div id="discordQuickSettings"></div>');

        // Header Left - Power button (enable/disable), Collapse arrow, and Live indicator
        const leftGroup = jQuery('<div class="ec_header_left"></div>');
        const powerBtn = jQuery('<div class="ec_power_btn" title="Enable/Disable EchoChamber"><i class="fa-solid fa-power-off"></i></div>');
        const collapseBtn = jQuery('<div class="ec_collapse_btn" title="Collapse/Expand Panel"><i class="fa-solid fa-chevron-down"></i></div>');
        const liveIndicator = jQuery('<div class="ec_live_indicator" id="ec_live_indicator"><i class="fa-solid fa-circle"></i> LIVE</div>');
        leftGroup.append(powerBtn).append(collapseBtn).append(liveIndicator);

        // Header Right - All icon buttons (Refresh first, then layout, users, font)
        const rightGroup = jQuery('<div class="ec_header_right"></div>');
        const createBtn = (icon, title, menuClass) => {
            const btn = jQuery(`<div class="ec_btn" title = "${title}" > <i class="${icon}"></i></div> `);
            if (menuClass) btn.append(`<div class="ec_popup_menu ${menuClass}" ></div> `);
            return btn;
        };

        const refreshBtn = createBtn('fa-solid fa-rotate-right', 'Regenerate Chat', null);
        const layoutBtn = createBtn('fa-solid fa-table-columns', 'Panel Position', 'ec_layout_menu');
        const usersBtn = createBtn('fa-solid fa-users', 'User Count', 'ec_user_menu');
        const fontBtn = createBtn('fa-solid fa-font', 'Font Size', 'ec_font_menu');
        const clearBtn = createBtn('fa-solid fa-trash-can', 'Clear Chat & Cache', null);
        const settingsBtn = createBtn('fa-solid fa-gear', 'Settings', null);

        // Overflow button - shown in compact/mobile mode instead of individual buttons
        const overflowBtn = jQuery('<div class="ec_btn ec_overflow_btn" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></div>');
        // Build overflow menu detached from button and appended to body to avoid clipping
        jQuery('#ec_overflow_menu_body').remove();
        const overflowMenu = jQuery('<div id="ec_overflow_menu_body" class="ec_popup_menu ec_overflow_menu"></div>');
        jQuery('body').append(overflowMenu);

        // Refresh is first on the left, then layout, users, font, clear, and settings button last
        rightGroup.append(refreshBtn).append(layoutBtn).append(usersBtn).append(fontBtn).append(clearBtn).append(settingsBtn).append(overflowBtn);

        discordQuickBar.append(leftGroup).append(rightGroup);

        // Style Indicator - shows current style name AND acts as dropdown
        const styleIndicator = jQuery('<div class="ec_style_indicator ec_style_dropdown_trigger" id="ec_style_indicator"></div>');
        // Create style menu and append to body to avoid clipping issues
        jQuery('#ec_style_menu_body').remove(); // Remove any existing
        const styleMenu = jQuery('<div id="ec_style_menu_body" class="ec_popup_menu ec_style_menu ec_indicator_menu"></div>');
        jQuery('body').append(styleMenu);
        updateStyleIndicator(styleIndicator);
        populateStyleMenu(styleMenu);

        // Status overlay - separate from content so it persists across updates
        const statusOverlay = jQuery('<div class="ec_status_overlay"></div>');

        discordContent = jQuery('<div id="discordContent"></div>');

        const replyContainer = jQuery(`
        <div class="ec_reply_container" >
            <div class="ec_reply_wrapper">
                <input type="search" class="ec_reply_input" placeholder="Type a message to participate..." id="ec_reply_field" autocomplete="off">
                <div class="ec_reply_send" id="ec_reply_submit" title="Send message"><i class="fa-solid fa-paper-plane"></i></div>
            </div>
        </div>
    `);

        const resizeHandle = jQuery('<div class="ec_resize_handle"></div>');

        // Update the append order:
        discordBar.append(discordQuickBar).append(styleIndicator).append(statusOverlay).append(discordContent).append(replyContainer).append(resizeHandle);

        // Populate Layout Menu
        const layoutMenu = layoutBtn.find('.ec_layout_menu');
        const currentPos = settings.position || 'bottom';
        ['Top', 'Bottom', 'Left', 'Right'].forEach(pos => {
            const icon = pos === 'Top' ? 'up' : pos === 'Bottom' ? 'down' : pos === 'Left' ? 'left' : 'right';
            const isSelected = pos.toLowerCase() === currentPos ? ' selected' : '';
            layoutMenu.append(`<div class="ec_menu_item${isSelected}" data-val="${pos.toLowerCase()}" > <i class="fa-solid fa-arrow-${icon}"></i> ${pos}</div> `);
        });
        // Add Pop Out option
        const popoutSelected = currentPos === 'popout' ? ' selected' : '';
        layoutMenu.append(`<div class="ec_menu_item${popoutSelected}" data-val="popout" > <i class="fa-solid fa-arrow-up-right-from-square"></i> Pop Out</div> `);

        // Populate User Count Menu with current selection highlighted
        const userMenu = usersBtn.find('.ec_user_menu');
        const currentUsers = settings.userCount || 5;
        for (let i = 1; i <= 20; i++) {
            const isSelected = i === currentUsers ? ' selected' : '';
            userMenu.append(`<div class="ec_menu_item${isSelected}" data-val="${i}" > ${i} users</div> `);
        }

        // Populate Font Size Menu with current selection highlighted
        const fontMenu = fontBtn.find('.ec_font_menu');
        const currentFont = settings.fontSize || 15;
        for (let i = 8; i <= 24; i++) {
            const isSelected = i === currentFont ? ' selected' : '';
            fontMenu.append(`<div class="ec_menu_item${isSelected}" data-val="${i}" > ${i}px</div> `);
        }


        updateApplyLayout();
        log('Panel rendered');

        // ---- Overflow menu population (accordion layout) ----
        const currentPosOF = settings.position || 'bottom';
        const currentUsersOF = settings.userCount || 5;
        const currentFontOF = settings.fontSize || 15;
        const posIcons = { top: 'up', bottom: 'down', left: 'left', right: 'right' };

        // Helper: build an accordion section
        function makeAccordion(id, icon, label, bodyContent) {
            const acc = jQuery(`
        <div class="ec_of_accordion" >
  <div class="ec_of_acc_header" data-acc="${id}">
    <span><i class="fa-solid ${icon}"></i> ${label}</span>
    <i class="fa-solid fa-chevron-right ec_of_chevron"></i>
  </div>
  <div class="ec_of_acc_body" id="ec_of_${id}_body"></div>
</div> `);
            acc.find('.ec_of_acc_body').append(bodyContent);
            return acc;
        }

        // Direct action: Regenerate Chat (always visible at top)
        overflowMenu.append(`<div class="ec_of_item ec_of_action" data-action="refresh"><i class="fa-solid fa-rotate-right"></i><span>Regenerate Chat</span></div>`);
        overflowMenu.append(`<div class="ec_of_divider_line"></div>`);

        // Accordion: Panel Position
        const posBodies = jQuery('<div class="ec_of_chip_wrap"></div>');
        ['top', 'bottom', 'left', 'right'].forEach(pos => {
            const sel = pos === currentPosOF ? ' ec_of_selected' : '';
            posBodies.append(`<div class="ec_of_chip ec_of_pos_chip${sel}" data-action="position" data-val="${pos}"><i class="fa-solid fa-arrow-${posIcons[pos]}"></i> ${pos.charAt(0).toUpperCase() + pos.slice(1)}</div>`);
        });
        posBodies.append(`<div class="ec_of_chip ec_of_pos_chip" data-action="position" data-val="popout"><i class="fa-solid fa-arrow-up-right-from-square"></i> Pop Out</div>`);
        overflowMenu.append(makeAccordion('position', 'fa-table-columns', 'Panel Position', posBodies));

        // Accordion: User Count (2–20 by twos)
        const userBodies = jQuery('<div class="ec_of_chip_wrap"></div>');
        for (let n = 2; n <= 20; n += 2) {
            const sel = n === currentUsersOF ? ' ec_of_selected' : '';
            userBodies.append(`<div class="ec_of_chip ec_of_num${sel}" data-action="users" data-val="${n}">${n}</div>`);
        }
        overflowMenu.append(makeAccordion('users', 'fa-users', 'User Count', userBodies));

        // Accordion: Font Size
        const fontBodies = jQuery('<div class="ec_of_chip_wrap"></div>');
        [10, 11, 12, 13, 14, 15, 16, 18, 20].forEach(n => {
            const sel = n === currentFontOF ? ' ec_of_selected' : '';
            fontBodies.append(`<div class="ec_of_chip ec_of_num${sel}" data-action="font" data-val="${n}">${n}px</div>`);
        });
        overflowMenu.append(makeAccordion('font', 'fa-font', 'Font Size', fontBodies));

        // Bottom actions
        overflowMenu.append(`<div class="ec_of_divider_line"></div>`);
        overflowMenu.append(`<div class="ec_of_item ec_of_action ec_of_danger" data-action="clear"><i class="fa-solid fa-trash-can"></i><span>Clear Chat &amp; Cache</span></div>`);
        overflowMenu.append(`<div class="ec_of_item ec_of_action" data-action="settings"><i class="fa-solid fa-gear"></i><span>Settings</span></div>`);

        // ---- Compact mode: measure-then-decide approach ----
        // To get accurate button widths, we must measure when buttons are visible.
        // Strategy: briefly remove ec_compact so buttons are measurable, take the reading,
        // then re-apply compact only if genuinely needed. CSS transition is fast enough
        // that this causes no visible flash (elements are in-flow but the toggle is <1ms).
        let naturalRightW = 0;
        let compactDebounce = null;

        const checkCompact = () => {
            clearTimeout(compactDebounce);
            compactDebounce = setTimeout(() => {
                if (!discordQuickBar || !discordQuickBar[0]) return;
                const bar = discordQuickBar[0];
                const barW = bar.offsetWidth;
                if (barW < 50) return; // not laid out yet

                const leftEl = bar.querySelector('.ec_header_left');
                const rightEl = bar.querySelector('.ec_header_right');
                if (!leftEl || !rightEl) return;

                // Temporarily remove compact so we can measure real button widths
                const wasCompact = discordQuickBar.hasClass('ec_compact');
                discordQuickBar.removeClass('ec_compact');

                // Force a sync reflow so offsetWidth reflects button visibility
                void bar.offsetWidth;

                // Measure actual rendered widths of the 6 regular buttons
                let measured = 0;
                rightEl.querySelectorAll('.ec_btn:not(.ec_overflow_btn)').forEach(b => {
                    measured += b.offsetWidth;
                });
                if (measured > 20) naturalRightW = measured;

                const leftW = leftEl.offsetWidth;
                const rightW = naturalRightW > 0 ? naturalRightW : 6 * 28;
                // Required: left + right groups must fit in bar with 4px margin
                // (bar padding is already inside offsetWidth, space-between handles gaps)
                const required = leftW + rightW + 4;
                const needsCompact = required > barW;

                // Apply the correct state
                if (needsCompact) {
                    discordQuickBar.addClass('ec_compact');
                }
                // If wasCompact and now not needsCompact, we already removed it above — correct.
            }, 150);
        };

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(checkCompact);
            setTimeout(() => {
                if (discordQuickBar && discordQuickBar[0]) {
                    ro.observe(discordQuickBar[0]);
                    checkCompact(); // initial check at 400ms (100 setup + 150 debounce = 250)
                }
            }, 250);
            // Second check at 700ms in case browser hasn't fully settled layout yet
            setTimeout(checkCompact, 700);
        } else {
            jQuery(window).on('resize.eccpact', checkCompact);
            setTimeout(checkCompact, 250);
            setTimeout(checkCompact, 700);
        }
    }



    function populateStyleMenu(menu) {
        menu.empty();
        const styles = getAllStyles();
        const { DOMPurify } = SillyTavern.libs;
        styles.forEach(s => {
            const isSelected = s.val === settings.style ? ' selected' : '';
            const safeVal = DOMPurify.sanitize(s.val, { ALLOWED_TAGS: [] });
            const safeLabel = DOMPurify.sanitize(s.label, { ALLOWED_TAGS: [] });
            menu.append(`<div class="ec_menu_item${isSelected}" data-val="${safeVal}" > <i class="fa-solid fa-masks-theater"></i> ${safeLabel}</div> `);
        });
    }

    function updateStyleIndicator(indicator) {
        const el = indicator || jQuery('#ec_style_indicator');
        if (!el.length) return;

        const styles = getAllStyles();
        const currentStyle = styles.find(s => s.val === settings.style);
        const styleName = currentStyle ? currentStyle.label : (settings.style || 'Default');

        // Sanitize style name to prevent XSS
        const { DOMPurify } = SillyTavern.libs;
        const safeStyleName = DOMPurify.sanitize(styleName, { ALLOWED_TAGS: [] });

        // Keep existing menu if present (main panel uses ec_indicator_menu appended to body)
        const existingMenu = el.find('.ec_indicator_menu');
        el.html(`<i class="fa-solid fa-masks-theater" ></i> <span>Style: ${safeStyleName}</span> <i class="fa-solid fa-caret-down ec_dropdown_arrow"></i>`);
        if (existingMenu.length) el.append(existingMenu);

        // When updating the main indicator, also sync the floating panel style button
        if (!indicator) {
            updateFloatStyleLabel();
        }
    }

    function updateApplyLayout() {
        if (!discordBar) return;
        closeStyleIndicatorMenu();

        // If fully disabled (via settings checkbox), hide the panel entirely
        if (!settings.enabled) {
            discordBar.hide();
            return;
        }

        // Show panel if enabled
        discordBar.show();

        const pos = settings.position || 'bottom';

        // Remove all position classes
        discordBar.removeClass('ec_top ec_bottom ec_left ec_right ec_collapsed');
        discordBar.addClass(`ec_${pos} `);

        // Detach and re-append depending on mode
        discordBar.detach();

        // Reset inline styles
        discordBar.css({ top: '', bottom: '', left: '', right: '', width: '', height: '' });
        discordContent.attr('style', '');

        // Apply opacity to backgrounds
        const opacity = (settings.opacity || 85) / 100;
        const bgWithOpacity = `rgba(20, 20, 25, ${opacity})`;
        const headerBgWithOpacity = `rgba(0, 0, 0, ${opacity * 0.3})`;
        discordBar.css('background', bgWithOpacity);
        discordQuickBar.css('background', headerBgWithOpacity);

        if (pos === 'bottom') {
            // On mobile, insert BEFORE send_form; on desktop, insert AFTER
            const sendForm = jQuery('#send_form');
            const isMobile = window.innerWidth <= 768;

            if (sendForm.length) {
                if (isMobile) {
                    sendForm.before(discordBar);
                } else {
                    sendForm.after(discordBar);
                }
            } else {
                // Fallback: try form_sheld
                const formSheld = jQuery('#form_sheld');
                if (formSheld.length) {
                    formSheld.append(discordBar);
                } else {
                    jQuery('body').append(discordBar);
                }
            }
            // Reset styles for flow layout
            discordBar.css({ width: '100%', height: '' });
            // Restore saved content height (fixes ' px' space bug with template literal)
            discordContent.css({
                'height': `${settings.chatHeight || 200}px`,
                'flex-grow': '0'
            });
            log('Bottom panel placed, content height:', settings.chatHeight);
        } else {
            // Top, Left, Right all append to body (fixed positioning via CSS)
            jQuery('body').append(discordBar);

            if (pos === 'top') {
                discordContent.css({
                    'height': `${settings.chatHeight || 200}px`,
                    'flex-grow': '0'
                });
                log('Top panel placed, content height:', settings.chatHeight);
            } else {
                // Side layouts — restore saved panel width
                discordBar.css('width', `${settings.panelWidth || 350}px`);
                discordContent.css({
                    'height': '100%',
                    'flex-grow': '1'
                });
            }
        }

        // Apply Collapsed State
        if (settings.collapsed) {
            discordBar.addClass('ec_collapsed');
        } else {
            discordBar.removeClass('ec_collapsed');
        }

        // Add paused visual state class (panel stays visible, generation is paused)
        if (settings.paused) {
            discordBar.addClass('ec_disabled');
        } else {
            discordBar.removeClass('ec_disabled');
        }

        updatePanelIcons();
    }

    function updatePanelIcons() {
        if (!discordBar) return;

        // Update power button - shows paused state
        const powerBtn = discordBar.find('.ec_power_btn');
        if (!settings.paused) {
            powerBtn.css('color', 'var(--ec-accent)');
            powerBtn.attr('title', 'Toggle On/Off (Currently ON)');
        } else {
            powerBtn.css('color', 'rgba(255, 255, 255, 0.3)');
            powerBtn.attr('title', 'Toggle On/Off (Currently OFF)');
        }

        // Update collapse button - shows collapsed state with arrow direction
        const collapseBtn = discordBar.find('.ec_collapse_btn i');
        const pos = settings.position || 'bottom';
        if (settings.collapsed) {
            // When collapsed, arrow points toward expansion direction
            if (pos === 'bottom') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-up');
            else if (pos === 'top') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-down');
            else if (pos === 'left') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-right');
            else if (pos === 'right') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-left');
            discordBar.find('.ec_collapse_btn').css('opacity', '0.5');
        } else {
            // When expanded, arrow points toward collapse direction
            if (pos === 'bottom') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-down');
            else if (pos === 'top') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-up');
            else if (pos === 'left') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-left');
            else if (pos === 'right') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-right');
            discordBar.find('.ec_collapse_btn').css('opacity', '1');
        }

        updateLiveIndicator();
    }

    function updateLiveIndicator(state) {
        const indicator = jQuery('#ec_live_indicator');
        // Also target the floating panel's live indicator if it exists in the same document
        const popoutInd = document.getElementById('ec_float_live_indicator');

        if (!indicator.length && !popoutInd) return;

        let className = 'ec_live_indicator ';
        let title = '';

        if (state === 'loading') {
            className += 'ec_live_loading';
            title = 'Processing… click to cancel';
        } else if (settings.livestream) {
            className += 'ec_live_on';
            title = 'LIVE — click to pause';
        } else {
            className += 'ec_live_off';
            title = 'Click to enable Livestream';
        }

        if (indicator.length) {
            indicator.removeClass('ec_live_off ec_live_on ec_live_loading');
            indicator.addClass(className.replace('ec_live_indicator ', ''));
            indicator.attr('title', title);
        }

        if (popoutInd) {
            popoutInd.className = className;
            popoutInd.title = title;
        }
    }

    // Shared toggle logic — called by both the LIVE indicator and the settings checkbox
    async function toggleLivestream(enable) {
        const wasEnabled = settings.livestream;
        settings.livestream = enable;
        saveSettings();

        // Keep settings panel checkbox in sync
        jQuery('#discord_livestream').prop('checked', enable);
        jQuery('#discord_livestream_settings').toggle(enable);

        updateLiveIndicator(enable ? null : null);

        if (enable) {
            if (livestreamActive && livestreamQueue.length > 0) {
                // Queue still has messages — just resume the ticker
                resumeLivestream();
                updateLiveIndicator();
            } else {
                // Need a fresh batch — generate silently in the background
                updateLiveIndicator('loading');

                // Kick off background generation without blocking the UI
                // generateDiscordChat handles livestream display flow internally
                generateDiscordChat().finally(() => {
                    updateLiveIndicator();
                });
            }
        } else {
            // Pause: stop the tick but keep the queue intact for resuming later
            pauseLivestream();
            // Abort any in-progress generation
            if (abortController) {
                abortController.abort();
                abortController = null;
            }
            updateLiveIndicator();
        }
    }

    // ============================================================
    // RESIZE LOGIC
    // ============================================================

    function initResizeLogic() {
        let isResizing = false;
        let startX, startY, startSize;

        jQuery(document).on('mousedown touchstart', '.ec_resize_handle', function (e) {
            e.preventDefault();
            e.stopPropagation();

            isResizing = true;
            startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const pos = settings.position;

            if (pos === 'left' || pos === 'right') {
                startSize = settings.panelWidth || 350;
                jQuery('body').css('cursor', 'ew-resize');
            } else {
                // Use saved setting as start size (more reliable than DOM read)
                startSize = settings.chatHeight || 200;
                jQuery('body').css('cursor', 'ns-resize');
            }

            log('Resize started:', pos, 'startSize:', startSize, 'startY:', startY);
            jQuery(this).addClass('resizing');
        });

        jQuery(document).on('mousemove touchmove', function (e) {
            if (!isResizing) return;

            const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const clientY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const deltaX = clientX - startX;
            const deltaY = clientY - startY;
            const pos = settings.position;

            if (pos === 'bottom') {
                // Bottom panel: drag up = bigger, drag down = smaller
                const newHeight = Math.max(80, Math.min(600, startSize - deltaY));
                discordContent.css('height', newHeight + 'px');
                settings.chatHeight = newHeight;
            } else if (pos === 'top') {
                // Top panel: drag down = bigger, drag up = smaller
                const newHeight = Math.max(80, Math.min(600, startSize + deltaY));
                discordContent.css('height', newHeight + 'px');
                settings.chatHeight = newHeight;
            } else if (pos === 'left') {
                const newWidth = Math.max(200, Math.min(window.innerWidth - 50, startSize + deltaX));
                discordBar.css('width', newWidth + 'px');
                settings.panelWidth = newWidth;
            } else if (pos === 'right') {
                const newWidth = Math.max(200, Math.min(window.innerWidth - 50, startSize - deltaX));
                discordBar.css('width', newWidth + 'px');
                settings.panelWidth = newWidth;
            }
        });

        jQuery(document).on('mouseup touchend', function () {
            if (isResizing) {
                isResizing = false;
                jQuery('.ec_resize_handle').removeClass('resizing');
                jQuery('body').css('cursor', '');
                log('Resize ended, chatHeight:', settings.chatHeight);
                saveSettings();
            }
        });
    }

    // ============================================================
    // EVENT HANDLERS
    // ============================================================

    function bindEventHandlers() {
        // Prevent duplicate event listener registration
        if (eventsBound) return;
        eventsBound = true;

        // Handle clicking a username to tag them
        jQuery(document).on('click', '.discord_username', function () {
            const username = jQuery(this).text();
            const input = jQuery('#ec_reply_field');
            input.val(`@${username} `).focus();
            // Scroll the reply input into view for convenience
            const replyContainer = document.querySelector('.ec_reply_container');
            if (replyContainer) replyContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

        // LIVE indicator click — when loading (orange), cancels in-progress generation.
        // Otherwise, toggles livestream on/off.
        jQuery(document).on('click', '#ec_live_indicator', function () {
            if (jQuery('#ec_live_indicator').hasClass('ec_live_loading')) {
                // Orange = processing — treat click as a cancel
                userCancelled = true;
                clearTimeout(debounceTimeout);
                if (abortController) {
                    abortController.abort();
                }
                updateLiveIndicator(); // Restore to ec_live_on state
            } else {
                toggleLivestream(!settings.livestream);
            }
        });

        //  Handle sending the message
        const submitReply = async () => {
            if (isGenerating) {
                cancelGenerationContext();
                return;
            }
            if (!settings.chatEnabled) return;
            const input = jQuery('#ec_reply_field');
            const text = input.val().trim();
            if (!text) return;

            // Clear input immediately for feel
            input.val('');

            // Show user's message immediately using their configured username
            const myMsg = formatMessage(settings.chatUsername || 'Streamer (You)', text, true);
            const container = jQuery('#discordContent .discord_container');
            if (container.length) {
                if (settings.messageOrder === 'newest-first') container.prepend(myMsg);
                else container.append(myMsg);
            } else {
                jQuery('#discordContent').html(`<div class="discord_container" > ${myMsg}</div> `);
            }

            // Scroll to show the user's message and incoming reply
            const dcSubmit = document.getElementById('discordContent');
            if (dcSubmit) {
                if (settings.messageOrder === 'newest-first') dcSubmit.scrollTo({ top: 0, behavior: 'smooth' });
                else dcSubmit.scrollTo({ top: dcSubmit.scrollHeight, behavior: 'smooth' });
            }

            // Parse @username mention if present, then generate a targeted single reply
            const atMatch = text.match(/^@([^\s]+)/);
            const targetUsername = atMatch ? atMatch[1] : null;

            // Generate a quick response from only the mentioned chatter (no full refresh)
            await generateSingleReply(text, targetUsername);
        };

        jQuery(document).on('click', '#ec_reply_submit', submitReply);
        jQuery(document).on('keypress', '#ec_reply_field', function (e) {
            if (e.which == 13) submitReply();
        });

        // Chat Participation settings handlers
        jQuery(document).on('change', '#discord_chat_enabled', function () {
            settings.chatEnabled = this.checked;
            jQuery('.ec_reply_container').toggle(this.checked);
            saveSettings();
        });

        jQuery(document).on('input', '#discord_chat_username', function () {
            settings.chatUsername = jQuery(this).val().trim() || 'Streamer (You)';
            saveSettings();
        });

        jQuery(document).on('input change', '#discord_chat_avatar_color', function () {
            const color = jQuery(this).val();
            settings.chatAvatarColor = color;
            applyAvatarColor(color);
            // Sync to modal if open
            jQuery('#ecm_chat_avatar_color').val(color);
            saveSettings();
        });

        jQuery(document).on('change', '#discord_chat_reply_count', function () {
            // Only clamp on commit (blur / Enter) so mid-edit backspacing doesn't
            // immediately replace an empty field with the fallback value of 3.
            const val = Math.max(1, Math.min(12, parseInt(jQuery(this).val()) || 3));
            settings.chatReplyCount = val;
            jQuery(this).val(val);
            // Sync to modal if open
            jQuery('#ecm_chat_reply_count').val(val);
            saveSettings();
        });

        // Power Button - toggles paused state (keeps panel visible, just pauses generation)
        jQuery(document).on('click', '.ec_power_btn', function () {
            settings.paused = !settings.paused;

            if (settings.paused) {
                // Pause: stop any ongoing generation (but keep panel visible)
                stopLivestream();
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
                discordBar.addClass('ec_disabled');
            } else {
                // Unpause: remove disabled state
                discordBar.removeClass('ec_disabled');
            }

            updatePanelIcons();
            saveSettings();
        });

        // Collapse Button - only toggles panel collapse state (visual only)
        jQuery(document).on('click', '.ec_collapse_btn', function () {
            settings.collapsed = !settings.collapsed;

            // Immediately apply/remove collapsed class
            if (settings.collapsed) {
                discordBar.addClass('ec_collapsed');
            } else {
                discordBar.removeClass('ec_collapsed');
            }

            updatePanelIcons();
            saveSettings();
        });

        // Menu Button Clicks
        jQuery(document).on('click touchend', '.ec_btn', function (e) {
            if (e.type === 'touchend') e.preventDefault();
            const btn = jQuery(this);
            const wasActive = btn.hasClass('active');
            closeStyleIndicatorMenu();

            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide().css({ top: '', bottom: '', left: '', right: '', position: '' });

            // Handle dropdowns (like user count, font size, AND chat styles indicator)
            if (btn.hasClass('ec_overflow_btn')) {
                if (!wasActive) {
                    btn.addClass('open active');
                    const popup = jQuery('#ec_overflow_menu_body');
                    const btnRect = btn[0].getBoundingClientRect();
                    const isBottom = jQuery('#discordBar').hasClass('ec_bottom');
                    const menuW = 260; // approx max-width; real width measured after show

                    // Temporarily show off-screen to measure actual width
                    popup.css({ visibility: 'hidden', display: 'block', top: '-9999px', left: '-9999px' });
                    const actualW = popup[0].offsetWidth;
                    const actualH = popup[0].offsetHeight;

                    // Horizontal: right-align to button, then clamp to viewport
                    let left = btnRect.right - actualW;
                    if (left < 8) left = 8;
                    if (left + actualW > window.innerWidth - 8) left = window.innerWidth - actualW - 8;

                    // Vertical: open below button normally, above when panel is at bottom
                    let top;
                    if (isBottom) {
                        top = btnRect.top - actualH - 6;
                    } else {
                        top = btnRect.bottom + 6;
                    }

                    popup.css({
                        visibility: '',
                        display: 'block',
                        position: 'fixed',
                        top: top + 'px',
                        left: left + 'px',
                        right: 'auto',
                        bottom: 'auto',
                    });
                }
            } else if (btn.find('.ec_popup_menu').length > 0) {
                if (!wasActive) {
                    btn.addClass('open active');
                    const popup = btn.find('.ec_popup_menu');
                    popup.show();
                    // Clamp the popup so it never overflows the left edge of the viewport
                    const rect = popup[0].getBoundingClientRect();
                    if (rect.left < 8) {
                        popup.css({ right: 'auto', left: (8 - rect.left) + 'px' });
                    }
                }
            } else if (btn.find('.fa-rotate-right').length) {
                btn.find('i').addClass('fa-spin');
                setTimeout(() => btn.find('i').removeClass('fa-spin'), 1000);
                // Always show the full Processing/Cancel overlay for explicit user-triggered regeneration,
                // even when Livestream is enabled (showOverlay=true bypasses the silent-background path).
                generateDiscordChat(true);
            } else if (btn.find('.fa-trash-can').length) {
                // Clear button clicked — show custom confirmation modal
                showConfirmModal('Clear all generated chat messages and cached commentary?').then(confirmed => {
                    if (confirmed) {
                        setDiscordText('');
                        clearCachedCommentary();
                        if (typeof toastr !== 'undefined') toastr.success('Chat and cache cleared');
                    }
                });
            } else if (btn.find('.fa-gear').length) {
                // Settings button clicked
                openSettingsModal();
            }
            e.stopPropagation();
        });

        // Overflow menu action clicks
        jQuery(document).on('click touchend', '.ec_of_action[data-action]', function (e) {
            if (e.type === 'touchend') e.preventDefault();
            e.stopPropagation();
            const action = jQuery(this).data('action');
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide().css({ top: '', bottom: '', left: '', right: '', position: '' });
            if (action === 'refresh') {
                jQuery('.ec_btn[title="Regenerate Chat"] i').addClass('fa-spin');
                setTimeout(() => jQuery('.ec_btn[title="Regenerate Chat"] i').removeClass('fa-spin'), 1000);
                generateDiscordChat(true);
            } else if (action === 'clear') {
                showConfirmModal('Clear all generated chat messages and cached commentary?').then(confirmed => {
                    if (confirmed) {
                        setDiscordText('');
                        clearCachedCommentary();
                        if (typeof toastr !== 'undefined') toastr.success('Chat and cache cleared');
                    }
                });
            } else if (action === 'settings') {
                openSettingsModal();
            }
        });

        // Accordion toggle inside overflow menu
        jQuery(document).on('click', '.ec_of_acc_header', function (e) {
            e.stopPropagation();
            const header = jQuery(this);
            const body = header.next('.ec_of_acc_body');
            const chevron = header.find('.ec_of_chevron');
            const isOpen = body.hasClass('ec_of_open');
            // Close all accordions first
            jQuery('.ec_of_acc_body').removeClass('ec_of_open');
            jQuery('.ec_of_chevron').removeClass('ec_of_rotated');
            // Open this one if it was closed
            if (!isOpen) {
                body.addClass('ec_of_open');
                chevron.addClass('ec_of_rotated');
            }
        });

        // Overflow chip clicks (position, users, font)
        jQuery(document).on('click', '.ec_of_chip[data-action]', function (e) {
            e.stopPropagation();
            const chip = jQuery(this);
            const action = chip.data('action');
            const val = chip.data('val');

            if (action === 'position') {
                if (val === 'popout') {
                    openPopoutWindow();
                } else {
                    settings.position = val;
                    saveSettings();
                    updateApplyLayout();
                    jQuery('#discord_position').val(val);
                    // Update selection highlight within this accordion body
                    chip.closest('.ec_of_acc_body').find('.ec_of_chip[data-action="position"]').removeClass('ec_of_selected');
                    chip.addClass('ec_of_selected');
                }
                jQuery('.ec_btn').removeClass('open active');
                jQuery('.ec_popup_menu').hide().css({ top: '', bottom: '', left: '', right: '', position: '' });
            } else if (action === 'users') {
                settings.userCount = parseInt(val);
                saveSettings();
                jQuery('#discord_user_count').val(settings.userCount);
                chip.closest('.ec_of_acc_body').find('.ec_of_chip').removeClass('ec_of_selected');
                chip.addClass('ec_of_selected');
                jQuery('.ec_user_menu .ec_menu_item').each(function () {
                    jQuery(this).toggleClass('selected', parseInt(jQuery(this).data('val')) === settings.userCount);
                });
            } else if (action === 'font') {
                const size = parseInt(val);
                settings.fontSize = size;
                applyFontSize(size);
                saveSettings();
                jQuery('#discord_font_size').val(size);
                chip.closest('.ec_of_acc_body').find('.ec_of_chip').removeClass('ec_of_selected');
                chip.addClass('ec_of_selected');
                jQuery('.ec_font_menu .ec_menu_item').each(function () {
                    jQuery(this).toggleClass('selected', parseInt(jQuery(this).data('val')) === size);
                });
            }
        });

        // Style Indicator Dropdown Click - menu is in body, position dynamically
        jQuery(document).on('click', '.ec_style_dropdown_trigger', function (e) {
            const trigger = jQuery(this);
            const wasActive = trigger.hasClass('active');
            const menu = jQuery('#ec_style_menu_body');

            // Close other menus
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').not('#ec_style_menu_body').hide().css({ top: '', bottom: '', left: '', right: '', position: '' });

            if (!wasActive) {
                closeStyleIndicatorMenu();
                trigger.addClass('active');
                openStyleIndicatorMenu(trigger, menu);
            } else {
                closeStyleIndicatorMenu();
            }
            e.stopPropagation();
        });

        jQuery(document).on('click', function () {
            closeStyleIndicatorMenu();
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide().css({ top: '', bottom: '', left: '', right: '', position: '' });
            jQuery('#ec_style_menu_body').hide();
            jQuery('#ec_float_style_menu_body').hide();
            jQuery('.ec_style_dropdown_trigger').removeClass('active');
        });

        // Track touch start position to distinguish taps from scrolls in popup menus
        let menuTouchStartY = 0;
        let menuTouchStartX = 0;
        jQuery(document).on('touchstart', '.ec_popup_menu', function (e) {
            const touch = e.originalEvent.touches[0];
            menuTouchStartY = touch.clientY;
            menuTouchStartX = touch.clientX;
        });
        // Prevent scroll gestures inside a popup menu from bubbling up to .ec_btn and closing the menu
        jQuery(document).on('touchend', '.ec_popup_menu', function (e) {
            const touch = e.originalEvent.changedTouches[0];
            const deltaY = Math.abs(touch.clientY - menuTouchStartY);
            const deltaX = Math.abs(touch.clientX - menuTouchStartX);
            if (deltaY > 10 || deltaX > 10) {
                e.stopPropagation(); // Scroll — keep menu open
            }
        });

        // Menu Item Clicks (touchend added for mobile support)
        jQuery(document).on('click touchend', '.ec_menu_item', function (e) {
            if (e.type === 'touchend') {
                // If the finger moved more than 10px, treat as a scroll — ignore
                const touch = e.originalEvent.changedTouches[0];
                const deltaY = Math.abs(touch.clientY - menuTouchStartY);
                const deltaX = Math.abs(touch.clientX - menuTouchStartX);
                if (deltaY > 10 || deltaX > 10) {
                    e.stopPropagation();
                    return; // Scroll gesture — don't select
                }
                e.preventDefault();
            }
            e.stopPropagation();
            const parent = jQuery(this).closest('.ec_popup_menu');
            const val = jQuery(this).data('val');

            if (parent.hasClass('ec_style_menu')) {
                settings.style = val;
                saveSettings();
                jQuery('#discord_style').val(val);
                // Update style menu selection
                parent.find('.ec_menu_item').removeClass('selected');
                jQuery(this).addClass('selected');
                updateStyleIndicator();
                updateFloatStyleLabel();
                // Show toast notification about style change
                const styleObj = getAllStyles().find(s => s.val === val);
                const styleName = styleObj ? styleObj.label : val;
                if (typeof toastr !== 'undefined') toastr.info(`Style: ${styleName} `);
            } else if (parent.hasClass('ec_layout_menu')) {
                if (val === 'popout') {
                    // Open popout window
                    openPopoutWindow();
                    // Don't change the position setting, just close menu
                } else {
                    settings.position = val;
                    saveSettings();
                    updateApplyLayout();
                    jQuery('#discord_position').val(val);
                }
            } else if (parent.hasClass('ec_user_menu')) {
                syncUserMenu(parseInt(val));
                saveSettings();
            } else if (parent.hasClass('ec_font_menu')) {
                syncFontMenu(parseInt(val));
                saveSettings();
            }

            if (!parent.hasClass('ec_user_menu') && !parent.hasClass('ec_font_menu')) {
                parent.find('.ec_menu_item').removeClass('selected');
                jQuery(this).addClass('selected');
            }

            // Close all menus and reset all active states
            closeStyleIndicatorMenu();
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide().css({ top: '', bottom: '', left: '', right: '', position: '' });
            jQuery('#ec_style_menu_body').hide();
            jQuery('#ec_float_style_menu_body').hide();
            jQuery('.ec_style_dropdown_trigger').removeClass('active');
        });

        // Settings Panel Bindings - this fully enables/disables the extension (shows/hides panel)
        jQuery('#discord_enabled').on('change', function () {
            settings.enabled = jQuery(this).prop('checked');

            if (!settings.enabled) {
                // Full disable: stop generation and hide panel
                stopLivestream();
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
                if (discordBar) discordBar.hide();
            } else {
                // Enable: remove paused state and reapply layout (which shows the panel)
                settings.paused = false;
                if (discordBar) {
                    discordBar.removeClass('ec_disabled');
                }
                updateApplyLayout();
            }

            saveSettings();
            updatePanelIcons();
            syncModalFromSettings();
        });

        jQuery('#discord_style').on('change', function () {
            const val = jQuery(this).val();
            settings.style = val;
            saveSettings();
            updateStyleIndicator();
            if (discordQuickBar) discordQuickBar.find('.ec_style_select').val(val);
            syncModalFromSettings();
        });

        jQuery('#discord_source').on('change', function () {
            settings.source = jQuery(this).val();
            saveSettings();
            updateSourceVisibility();
            syncModalFromSettings();
        });

        jQuery('#discord_position').on('change', function () {
            const newPosition = jQuery(this).val();
            if (newPosition === 'popout') {
                // Open popout window
                openPopoutWindow();
                // Reset to previous position (don't actually set position to 'popout')
                jQuery(this).val(settings.position || 'bottom');
            } else {
                settings.position = newPosition;
                saveSettings();
                updateApplyLayout();
                syncModalFromSettings();
            }
        });

        jQuery('#discord_user_count').on('change', function () {
            settings.userCount = parseInt(jQuery(this).val()) || 5;
            saveSettings();
            syncModalFromSettings();
        });

        jQuery('#discord_font_size').on('change', function () {
            settings.fontSize = parseInt(jQuery(this).val()) || 15;
            applyFontSize(settings.fontSize);
            saveSettings();
            syncModalFromSettings();
        });

        jQuery('#discord_opacity').on('input change', function () {
            settings.opacity = parseInt(jQuery(this).val()) || 85;
            jQuery('#discord_opacity_val').text(settings.opacity + '%');
            if (discordBar && discordQuickBar) {
                const opacity = settings.opacity / 100;
                const bgWithOpacity = `rgba(20, 20, 25, ${opacity})`;
                const headerBgWithOpacity = `rgba(0, 0, 0, ${opacity * 0.3})`;
                discordBar.css('background', bgWithOpacity);
                discordQuickBar.css('background', headerBgWithOpacity);
            }
            saveSettings();
            syncModalFromSettings();
        });

        jQuery('#discord_message_order').on('change', function () {
            settings.messageOrder = jQuery(this).val();
            saveSettings();
            applyMessageOrder();
            syncModalFromSettings();
        });

        // Connection Profile selection
        jQuery('#discord_preset_select').on('change', function () {
            settings.preset = jQuery(this).val();
            saveSettings();
            log('Selected connection profile:', settings.preset);
        });

        jQuery('#discord_openai_url').on('change', function () {
            settings.openai_url = jQuery(this).val();
            saveSettings();
            log('OpenAI URL:', settings.openai_url);
        });

        // OpenAI Compatible - Key
        jQuery('#discord_openai_key').on('change', function () {
            settings.openai_key = jQuery(this).val();
            saveSettings();
            log('OpenAI Key saved');
        });

        // OpenAI Compatible - Model
        jQuery('#discord_openai_model').on('change', function () {
            settings.openai_model = jQuery(this).val();
            saveSettings();
            log('OpenAI Model:', settings.openai_model);
        });

        // OpenAI Compatible - Preset
        jQuery('#discord_openai_preset').on('change', function () {
            settings.openai_preset = jQuery(this).val();
            saveSettings();
            log('OpenAI Preset:', settings.openai_preset);
        });

        // Ollama - URL
        jQuery('#discord_url').on('change', function () {
            settings.url = jQuery(this).val();
            saveSettings();
            log('Ollama URL:', settings.url);
        });

        // Ollama - Model selection
        jQuery('#discord_model_select').on('change', function () {
            settings.model = jQuery(this).val();
            saveSettings();
            log('Ollama Model:', settings.model);
        });

        // Include User Input toggle
        jQuery('#discord_include_user').on('change', function () {
            settings.includeUserInput = jQuery(this).prop('checked');
            // Show/hide context depth dropdown
            jQuery('#discord_context_depth_container').toggle(settings.includeUserInput);
            saveSettings();
            log('Include user input:', settings.includeUserInput);
        });

        // Context Depth selection
        jQuery('#discord_context_depth').on('change', function () {
            settings.contextDepth = parseInt(jQuery(this).val()) || 4;
            saveSettings();
            log('Context depth:', settings.contextDepth);
        });

        // Auto-update On Messages toggle
        jQuery('#discord_auto_update').on('change', function () {
            settings.autoUpdateOnMessages = jQuery(this).prop('checked');
            saveSettings();
            log('Auto-update on messages:', settings.autoUpdateOnMessages);
        });

        // Include Past Generated EchoChambers toggle
        jQuery('#discord_include_past_echo').on('change', function () {
            settings.includePastEchoChambers = jQuery(this).prop('checked');
            saveSettings();
            log('Include past EchoChambers:', settings.includePastEchoChambers);
        });

        // Include Persona toggle
        jQuery('#discord_include_persona').on('change', function () {
            settings.includePersona = jQuery(this).prop('checked');
            saveSettings();
            log('Include persona:', settings.includePersona);
        });

        // Include Author's Note toggle
        jQuery('#discord_include_authors_note').on('change', function () {
            settings.includeAuthorsNote = jQuery(this).prop('checked');
            saveSettings();
            log('Include authors note:', settings.includeAuthorsNote);
        });

        // Include Character Description toggle
        jQuery('#discord_include_character_description').on('change', function () {
            settings.includeCharacterDescription = jQuery(this).prop('checked');
            saveSettings();
            log('Include character description:', settings.includeCharacterDescription);
        });

        // Include Summary toggle
        jQuery('#discord_include_summary').on('change', function () {
            settings.includeSummary = jQuery(this).prop('checked');
            saveSettings();
            log('Include summary:', settings.includeSummary);
        });

        // Include World Info toggle
        jQuery('#discord_include_world_info').on('change', function () {
            settings.includeWorldInfo = jQuery(this).prop('checked');
            jQuery('#discord_wi_budget_container').toggle(settings.includeWorldInfo);
            saveSettings();
            log('Include world info:', settings.includeWorldInfo);
        });

        // World Info budget input
        jQuery('#discord_wi_budget').on('change', function () {
            settings.wiBudget = Math.max(0, parseInt(jQuery(this).val()) || 0);
            jQuery(this).val(settings.wiBudget);
            saveSettings();
            log('WI budget:', settings.wiBudget, settings.wiBudget === 0 ? '(unlimited - use ST budget)' : 'tokens');
        });

        // Livestream toggle (settings panel) — delegates to shared toggleLivestream()
        jQuery('#discord_livestream').on('change', function () {
            toggleLivestream(jQuery(this).prop('checked'));
        });

        // Livestream batch size
        jQuery('#discord_livestream_batch_size').on('change', function () {
            settings.livestreamBatchSize = parseInt(jQuery(this).val()) || 20;
            saveSettings();
            log('Livestream batch size:', settings.livestreamBatchSize);
        });

        // Livestream minimum wait time
        jQuery('#discord_livestream_min_wait').on('change', function () {
            settings.livestreamMinWait = parseInt(jQuery(this).val()) || 5;
            saveSettings();
            log('Livestream min wait:', settings.livestreamMinWait);
        });

        // Livestream maximum wait time
        jQuery('#discord_livestream_max_wait').on('change', function () {
            settings.livestreamMaxWait = parseInt(jQuery(this).val()) || 60;
            saveSettings();
            log('Livestream max wait:', settings.livestreamMaxWait);
        });

        // Livestream mode radio buttons
        jQuery('input[name=\"discord_livestream_mode\"]').on('change', function () {
            settings.livestreamMode = jQuery(this).val();
            saveSettings();
            log('Livestream mode:', settings.livestreamMode);
        });


        // Livestream auto-scroll
        jQuery('#discord_livestream_auto_scroll').on('change', function () {
            settings.livestreamAutoScroll = jQuery(this).prop('checked');
            saveSettings();
            log('Livestream auto-scroll:', settings.livestreamAutoScroll);
        });
        // Style Editor button
        jQuery(document).on('click', '#discord_open_style_editor', function () {
            openStyleEditor();
        });

        // Import Style file
        jQuery(document).on('click', '#discord_import_btn', function () {
            jQuery('#discord_import_file').click();
        });

        // Export Style button
        jQuery(document).on('click', '#discord_export_btn', async function () {
            const currentStyle = settings.style || 'twitch';
            const styles = getAllStyles();
            const styleObj = styles.find(s => s.val === currentStyle);
            const styleName = styleObj ? styleObj.label : currentStyle;

            // Get the prompt content
            let content = '';
            if (settings.custom_styles && settings.custom_styles[currentStyle]) {
                content = settings.custom_styles[currentStyle].prompt;
            } else {
                content = await loadChatStyle(currentStyle);
            }

            const blob = new Blob([content], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `echochamber_${styleName.toLowerCase().replace(/[^a-z0-9]/g, '_')}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            if (typeof toastr !== 'undefined') toastr.success(`Style "${styleName}" exported!`);
        });

        jQuery(document).on('change', '#discord_import_file', function () {
            const file = this.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function (e) {
                const content = e.target.result;
                const name = file.name.replace(/\.md$/i, '');
                const id = 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();

                if (!settings.custom_styles) settings.custom_styles = {};
                settings.custom_styles[id] = { name: name, prompt: content };
                saveSettings();
                updateAllDropdowns();

                if (typeof toastr !== 'undefined') toastr.success(`Imported style: ${name} `);
                log('Imported style:', id);
            };
            reader.readAsText(file);
            this.value = '';  // Reset to allow re-importing same file
        });

        // SillyTavern Events
        const context = SillyTavern.getContext();
        if (context.eventSource && context.eventTypes) {
            // Only auto-generate on new message if autoUpdateOnMessages is enabled
            context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
                // Don't auto-generate if there's no chat or it's empty (fresh chat)
                const ctx = SillyTavern.getContext();
                if (!ctx.chat || ctx.chat.length === 0) return;

                // Don't auto-generate if we're currently loading/switching chats
                if (isLoadingChat) return;

                // Skip panel-visibility guards when nav panels are pinned open — pinned panels
                // remain rendered by design and should not suppress generation during an active chat.
                const rightNavPinned = document.querySelector('#right-nav-panel')?.classList.contains('pinnedOpen') ?? false;
                const leftNavPinned = document.querySelector('#left-nav-panel')?.classList.contains('pinnedOpen') ?? false;

                // Don't auto-generate if character editor is open (editing character cards)
                const characterEditor = document.querySelector('#character_popup');
                const isCharacterEditorOpen = !leftNavPinned && characterEditor && characterEditor.style.display !== 'none' && characterEditor.offsetParent !== null;
                if (isCharacterEditorOpen) return;

                // Don't auto-generate if we're in the character creation/management area
                const charCreatePanel = document.querySelector('#rm_ch_create_block');
                const isCreatingCharacter = !rightNavPinned && charCreatePanel && charCreatePanel.style.display !== 'none' && charCreatePanel.offsetParent !== null;
                if (isCreatingCharacter) return;

                // Don't auto-generate if there's no valid chatId (indicates we're not in an actual conversation)
                if (!ctx.chatId) return;

                // Only trigger on AI character messages, not user messages
                const lastMessage = ctx.chat[ctx.chat.length - 1];
                if (!lastMessage || lastMessage.is_user) {
                    // This is a user message or no message - don't auto-generate
                    return;
                }

                // Determine if we should auto-generate
                let shouldAutoGenerate = false;

                if (settings.livestream && settings.livestreamMode === 'onMessage') {
                    // Livestream in onMessage mode takes priority
                    shouldAutoGenerate = true;
                } else if (!settings.livestream && settings.autoUpdateOnMessages === true) {
                    // Regular auto-update (only if livestream is off)
                    shouldAutoGenerate = true;
                }

                onChatEvent(false, shouldAutoGenerate);
            });
            // On chat change (loading a conversation), clear display and try to restore from metadata
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
                // Set flag to prevent MESSAGE_RECEIVED from triggering during chat load
                isLoadingChat = true;
                onChatEvent(false, false);
                // Clear the flag after a short delay to allow legitimate new messages
                setTimeout(() => { isLoadingChat = false; }, 1000);
            });
            context.eventSource.on(context.eventTypes.GENERATION_STOPPED, () => setStatus(''));
            // Refresh profiles when settings change (handles async loading)
            context.eventSource.on(context.eventTypes.SETTINGS_UPDATED, () => populateConnectionProfiles());
        }
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    // ============================================================
    // SETTINGS PANEL ACCORDION
    // ============================================================

    function initEcSettingsAccordions() {
        // Wire up all accordion header buttons
        document.querySelectorAll('.ec-s-section-header').forEach(btn => {
            btn.addEventListener('click', function () {
                const expanded = this.getAttribute('aria-expanded') === 'true';
                const body = this.nextElementSibling;
                this.setAttribute('aria-expanded', String(!expanded));
                if (body) body.hidden = expanded;
            });
        });

        // Open sections marked with data-default-open
        document.querySelectorAll('.ec-s-section[data-default-open]').forEach(section => {
            const btn = section.querySelector('.ec-s-section-header');
            const body = section.querySelector('.ec-s-section-body');
            if (btn && body) {
                btn.setAttribute('aria-expanded', 'true');
                body.hidden = false;
            }
        });
    }

    async function init() {
        log('Initializing...');

        // Wait for SillyTavern to be ready
        if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
            warn('SillyTavern not ready, retrying in 500ms...');
            setTimeout(init, 500);
            return;
        }

        const context = SillyTavern.getContext();
        log('Context available:', !!context);

        // Note: FontAwesome is already included by SillyTavern - do not inject a duplicate

        // Load settings HTML template
        try {
            if (context.renderExtensionTemplateAsync) {
                // Try to find the correct module name from script path
                const scripts = document.querySelectorAll('script[src*="index.js"]');
                let moduleName = 'third-party/SillyTavern-EchoChamber';
                for (const script of scripts) {
                    const match = script.src.match(/extensions\/(.+?)\/index\.js/);
                    if (match && (match[1].includes('EchoChamber') || match[1].includes('DiscordChat'))) {
                        moduleName = match[1];
                        break;
                    }
                }
                log('Detected module name:', moduleName);

                const settingsHtml = await context.renderExtensionTemplateAsync(moduleName, 'settings');
                jQuery('#extensions_settings').append(settingsHtml);
                log('Settings template loaded');
                initEcSettingsAccordions();
            }
        } catch (err) {
            error('Failed to load settings template:', err);
        }

        // Initialize - load settings FIRST so panel can use them
        loadSettings();
        renderPanel();

        // Toggle chat participation container based on loaded setting (must be after renderPanel)
        jQuery('.ec_reply_container').toggle(settings.chatEnabled !== false);

        // Update Pop Out visibility based on screen size
        updatePopoutVisibility();

        // Update on window resize
        jQuery(window).on('resize', debounce(() => {
            updatePopoutVisibility();
        }, 250));
        initResizeLogic();
        bindEventHandlers();

        // Restore cached commentary if there's an active chat
        if (context.chatId) {
            restoreCachedCommentary();
        }

        // Restore floating panel if it was open when the page was last closed
        if (settings.floatOpen && !window.matchMedia('(max-width: 768px)').matches) {
            openPopoutWindow();
        }

        log('Initialization complete');
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();