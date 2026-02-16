(function () {
    'use strict';

    const EXTENSION_NAME = 'swipe_roulette';
    const PROFILE_NONE_SENTINEL = '<None>';
    const MAX_BOOT_RETRIES = 100;
    const BOOT_RETRY_MS = 100;

    let defaultSwipesUsed = 0;
    let swipeRotationActive = false;
    let profileBeforeSwipe = null;
    let isRestoring = false;
    let rotationSeq = 0;
    let spinInFlight = false;
    let activeRotationToast = null;
    let expectedProfileId = null;

    let uiRoot = null;

    function getContext() {
        return globalThis.SillyTavern?.getContext?.() || null;
    }

    function getEventTypes(ctx) {
        if (!ctx) return null;
        return ctx.eventTypes || ctx.event_types || null;
    }

    function ensureSettings() {
        const ctx = getContext();
        if (!ctx) return null;

        if (!ctx.extensionSettings) ctx.extensionSettings = {};
        if (!ctx.extensionSettings[EXTENSION_NAME] || typeof ctx.extensionSettings[EXTENSION_NAME] !== 'object') {
            ctx.extensionSettings[EXTENSION_NAME] = {};
        }

        const settings = ctx.extensionSettings[EXTENSION_NAME];
        if (typeof settings.enabled !== 'boolean') settings.enabled = false;
        if (!Array.isArray(settings.profileIds)) settings.profileIds = [];
        if (!Number.isInteger(settings.defaultSwipeThreshold) || settings.defaultSwipeThreshold < 0) {
            settings.defaultSwipeThreshold = 0;
        }
        if (typeof settings.debug !== 'boolean') settings.debug = false;
        if (typeof settings.mode !== 'string') settings.mode = 'weighted_random';
        if (!settings.profileWeights || typeof settings.profileWeights !== 'object') {
            settings.profileWeights = {};
        }
        if (settings.spinLastProfileId !== null && typeof settings.spinLastProfileId !== 'string') {
            settings.spinLastProfileId = null;
        }
        if (typeof settings.showNotifications !== 'boolean') settings.showNotifications = true;

        return settings;
    }

    function saveSettings() {
        const ctx = getContext();
        if (!ctx?.saveSettingsDebounced) return;
        ctx.saveSettingsDebounced();
    }

    function getSettings() {
        return ensureSettings() || { enabled: false, profileIds: [], defaultSwipeThreshold: 0, debug: false, mode: 'weighted_random', profileWeights: {}, spinLastProfileId: null, showNotifications: true };
    }

    function isEnabled() {
        return Boolean(getSettings().enabled);
    }

    function getThreshold() {
        const value = Number(getSettings().defaultSwipeThreshold);
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.floor(value));
    }

    function log(...args) {
        if (!getSettings().debug) return;
        console.log(`[${EXTENSION_NAME}]`, ...args);
    }

    function warn(...args) {
        console.warn(`[${EXTENSION_NAME}]`, ...args);
    }

    function getConnectionProfiles() {
        const ctx = getContext();
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
        if (!Array.isArray(profiles)) return [];
        return profiles.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string');
    }

    function getActiveProfileId() {
        const ctx = getContext();
        const selected = ctx?.extensionSettings?.connectionManager?.selectedProfile;
        return typeof selected === 'string' && selected.length > 0 ? selected : null;
    }

    function quoteSlashArg(value) {
        return JSON.stringify(String(value));
    }

    async function switchProfileByName(profileName) {
        const ctx = getContext();
        if (!ctx?.executeSlashCommandsWithOptions) {
            throw new Error('executeSlashCommandsWithOptions is unavailable');
        }

        const command = `/profile ${quoteSlashArg(profileName)}`;
        await ctx.executeSlashCommandsWithOptions(command);
    }

    async function switchToNoProfile() {
        await switchProfileByName(PROFILE_NONE_SENTINEL);
    }

    function showRotationToast(profileName) {
        if (!getSettings().showNotifications) return;
        dismissRotationToast();
        activeRotationToast = toastr.info(
            `<i class="fa-solid fa-dice"></i> ${profileName}`,
            'Swipe Roulette',
            { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 },
        );
    }

    function dismissRotationToast() {
        if (!activeRotationToast) return;
        toastr.clear(activeRotationToast, { force: true });
        activeRotationToast = null;
    }

    function getRotationCandidates() {
        const settings = getSettings();
        const selectedIds = new Set(settings.profileIds);
        const profiles = getConnectionProfiles();
        const activeId = getActiveProfileId();

        return profiles
            .filter(p => selectedIds.has(p.id))
            .filter(p => p.id !== activeId)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function pruneStaleProfileSelections() {
        const settings = ensureSettings();
        if (!settings) return;

        const profileIds = new Set(getConnectionProfiles().map(p => p.id));
        let dirty = false;

        const filtered = settings.profileIds.filter(id => profileIds.has(id));
        if (filtered.length !== settings.profileIds.length) {
            settings.profileIds = filtered;
            dirty = true;
        }

        for (const key of Object.keys(settings.profileWeights)) {
            if (!profileIds.has(key)) {
                delete settings.profileWeights[key];
                dirty = true;
            }
        }

        if (settings.spinLastProfileId && !profileIds.has(settings.spinLastProfileId)) {
            settings.spinLastProfileId = null;
            dirty = true;
        }

        if (dirty) {
            saveSettings();
            log('Pruned stale profile selections');
        }
    }

    function resetSwipeCounters() {
        defaultSwipesUsed = 0;
    }

    function resetSwipeState() {
        rotationSeq++;
        swipeRotationActive = false;
        profileBeforeSwipe = null;
        isRestoring = false;
        dismissRotationToast();
    }

    async function restoreProfile() {
        if (!swipeRotationActive || isRestoring) return;
        isRestoring = true;

        const seq = rotationSeq;
        const savedProfileId = profileBeforeSwipe;
        const profiles = getConnectionProfiles();
        const originalProfile = profiles.find(p => p.id === savedProfileId) || null;

        try {
            if (originalProfile) {
                await switchProfileByName(originalProfile.name);
                expectedProfileId = savedProfileId;
                log('Restored profile', originalProfile.name);
            } else {
                await switchToNoProfile();
                expectedProfileId = null;
                log('Restored to no profile');
            }
            dismissRotationToast();
        } catch (error) {
            warn('Failed to restore profile after swipe generation', error);
        } finally {
            if (rotationSeq === seq) {
                swipeRotationActive = false;
                profileBeforeSwipe = null;
            } else {
                log('Skipping stale restore cleanup', { seq, current: rotationSeq });
            }
            isRestoring = false;
        }
    }

    async function onGenerationStarted(type, _params, dryRun) {
        if (dryRun === true) return;

        // Restore stale rotation from a previous generation that never completed
        if (swipeRotationActive && !isRestoring && type !== 'quiet') {
            log('Recovering stale rotation before', type, 'generation');
            await restoreProfile();
        }

        if (type !== 'swipe') {
            if (type !== 'quiet') {
                defaultSwipesUsed = 0;
            }
            return;
        }

        if (!isEnabled()) return;

        const currentProfileId = getActiveProfileId();
        if (currentProfileId !== expectedProfileId) {
            log('Manual profile change detected', { expected: expectedProfileId, actual: currentProfileId });
            expectedProfileId = currentProfileId;
            defaultSwipesUsed = 0;
            if (swipeRotationActive) {
                resetSwipeState();
            }
            return;
        }

        defaultSwipesUsed += 1;
        const threshold = getThreshold();
        if (defaultSwipesUsed <= threshold) {
            log('Swipe within threshold, skipping rotation', { defaultSwipesUsed, threshold });
            return;
        }

        const candidates = getRotationCandidates();
        if (candidates.length === 0) {
            log('No rotation candidates available');
            return;
        }

        const target = weightedRandomDraw(candidates, (p) => getWeightForProfileId(p.id));
        if (!target) {
            log('Weighted draw returned no target');
            return;
        }

        if (target.id === getActiveProfileId()) {
            log('Selected profile already active, skipping rotation', target.name);
            return;
        }

        rotationSeq++;
        if (!swipeRotationActive) {
            profileBeforeSwipe = getActiveProfileId();
        }

        try {
            await switchProfileByName(target.name);
            swipeRotationActive = true;
            expectedProfileId = target.id;
            showRotationToast(target.name);
            log('Switched profile for swipe generation', target.name);
        } catch (error) {
            warn('Failed to switch profile for swipe generation', error);
            swipeRotationActive = false;
            profileBeforeSwipe = null;
        }
    }

    async function onMessageReceived(_messageId, type) {
        if (type !== 'swipe') return;
        await restoreProfile();
    }

    async function onGenerationStopped() {
        await restoreProfile();
    }

    async function onGenerationEnded() {
        await restoreProfile();
    }

    async function onChatChanged() {
        await restoreProfile();
        resetSwipeCounters();
        resetSwipeState();
        expectedProfileId = getActiveProfileId();
    }

    async function spinNow() {
        if (spinInFlight) return;
        spinInFlight = true;

        try {
            const candidates = getSpinCandidates();
            if (candidates.length === 0) {
                const resultEl = uiRoot?.querySelector('#swipe_roulette_spin_result');
                if (resultEl) resultEl.textContent = 'No profiles selected';
                return;
            }

            const target = weightedRandomDraw(candidates, (p) => getWeightForProfileId(p.id));
            if (!target) return;

            await switchProfileByName(target.name);
            expectedProfileId = target.id;
            defaultSwipesUsed = 0;

            const settings = ensureSettings();
            if (settings) {
                settings.spinLastProfileId = target.id;
                saveSettings();
            }

            const resultEl = uiRoot?.querySelector('#swipe_roulette_spin_result');
            if (resultEl) resultEl.textContent = target.name;

            log('Spin switched to', target.name);
        } catch (error) {
            warn('Spin failed', error);
            const resultEl = uiRoot?.querySelector('#swipe_roulette_spin_result');
            if (resultEl) resultEl.textContent = 'Spin failed';
        } finally {
            spinInFlight = false;
        }
    }

    function onConnectionProfileChanged() {
        pruneStaleProfileSelections();
        refreshSettingsUi();
    }

    function sanitizeThresholdInput(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.floor(n));
    }

    function normalizeWeight(value) {
        const n = Math.floor(Number(value));
        if (!Number.isFinite(n) || n < 1) return 5;
        return Math.min(n, 10);
    }

    function getWeightForProfileId(profileId) {
        const settings = getSettings();
        return normalizeWeight(settings.profileWeights[profileId]);
    }

    function updateAllPercentageDisplays(container) {
        const settings = getSettings();
        const selectedIds = new Set(settings.profileIds);
        let total = 0;
        for (const id of selectedIds) total += getWeightForProfileId(id);

        const pctSpans = container.querySelectorAll('.swipe-roulette__weight-pct');
        for (const span of pctSpans) {
            const profileId = span.dataset.profileId;
            if (!profileId || !selectedIds.has(profileId) || total === 0) {
                span.textContent = '';
            } else {
                span.textContent = Math.round(getWeightForProfileId(profileId) / total * 100) + '%';
            }
        }
    }

    function weightedRandomDraw(candidates, getWeight) {
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        let total = 0;
        for (const c of candidates) total += getWeight(c);

        let r = Math.random() * total;
        for (const c of candidates) {
            r -= getWeight(c);
            if (r <= 0) return c;
        }
        return candidates[candidates.length - 1];
    }

    function getSpinCandidates() {
        const settings = getSettings();
        const selectedIds = new Set(settings.profileIds);
        const profiles = getConnectionProfiles();

        return profiles
            .filter(p => selectedIds.has(p.id))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function ensureUiContainer() {
        if (uiRoot?.isConnected) return uiRoot;

        const parent = document.getElementById('extensions_settings2');
        if (!parent) return null;

        const wrapper = document.createElement('div');
        wrapper.id = `${EXTENSION_NAME}_container`;
        wrapper.className = 'extension_container';
        wrapper.innerHTML = `
            <div class="swipe-roulette card">
                <div class="swipe-roulette__header">Swipe Roulette</div>
                <label class="checkbox_label flexNoGap swipe-roulette__toggle">
                    <input type="checkbox" id="swipe_roulette_enabled">
                    <span>Enable profile rotation on swipe generation</span>
                </label>
                <label class="swipe-roulette__field" for="swipe_roulette_threshold">
                    <span class="swipe-roulette__label">Swipes before rotating</span>
                    <input type="number" id="swipe_roulette_threshold" min="0" step="1" class="text_pole widthNatural">
                </label>
                <div class="swipe-roulette__hint">
                    Number of swipe generations to keep on the current profile before rotation starts. 0 means rotate on the first swipe.
                </div>
                <label class="checkbox_label flexNoGap swipe-roulette__toggle">
                    <input type="checkbox" id="swipe_roulette_show_notifications">
                    <span>Show notification on profile switch</span>
                </label>
                <div id="swipe_roulette_profiles_state" class="swipe-roulette__state"></div>
                <div id="swipe_roulette_profiles" class="swipe-roulette__profiles"></div>
                <div class="swipe-roulette__hint">
                    Drag sliders to adjust selection probability.
                </div>
                <div class="swipe-roulette__spin-section">
                    <button id="swipe_roulette_spin" class="menu_button swipe-roulette__spin-btn" disabled>Spin</button>
                    <span id="swipe_roulette_spin_result" class="swipe-roulette__spin-result"></span>
                </div>
            </div>
        `;

        parent.appendChild(wrapper);
        uiRoot = wrapper;

        bindUiEvents();
        return wrapper;
    }

    function bindUiEvents() {
        if (!uiRoot) return;

        const enabledInput = uiRoot.querySelector('#swipe_roulette_enabled');
        const thresholdInput = uiRoot.querySelector('#swipe_roulette_threshold');

        if (enabledInput) {
            enabledInput.addEventListener('change', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.enabled = enabledInput.checked;
                saveSettings();
            });
        }

        if (thresholdInput) {
            thresholdInput.addEventListener('input', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.defaultSwipeThreshold = sanitizeThresholdInput(thresholdInput.value);
                thresholdInput.value = String(settings.defaultSwipeThreshold);
                saveSettings();
            });
        }

        const notificationsInput = uiRoot.querySelector('#swipe_roulette_show_notifications');
        if (notificationsInput) {
            notificationsInput.addEventListener('change', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.showNotifications = notificationsInput.checked;
                saveSettings();
            });
        }

        const spinBtn = uiRoot.querySelector('#swipe_roulette_spin');
        if (spinBtn) {
            spinBtn.addEventListener('click', () => spinNow());
        }
    }

    function renderProfilesChecklist(container, stateEl) {
        if (!container || !stateEl) return;

        pruneStaleProfileSelections();
        const settings = getSettings();
        const profiles = getConnectionProfiles().sort((a, b) => a.name.localeCompare(b.name));
        const selectedIds = new Set(settings.profileIds);

        container.innerHTML = '';

        if (profiles.length === 0) {
            stateEl.textContent = 'No Connection Manager profiles found. Create profiles first.';
            stateEl.classList.remove('swipe-roulette__state--ok');
            container.style.display = 'none';
            return;
        }

        container.style.display = '';
        stateEl.textContent = 'Select profiles for weighted random rotation. Adjust weights per profile.';
        stateEl.classList.add('swipe-roulette__state--ok');

        const fragment = document.createDocumentFragment();
        for (const profile of profiles) {
            const row = document.createElement('div');
            row.className = 'swipe-roulette__profile-row';

            const label = document.createElement('label');
            label.className = 'checkbox_label flexNoGap swipe-roulette__profile-item';
            label.style.flex = '1';
            label.style.minWidth = '0';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedIds.has(profile.id);
            checkbox.dataset.profileId = profile.id;
            checkbox.addEventListener('change', () => {
                const s = ensureSettings();
                if (!s) return;

                const set = new Set(s.profileIds);
                if (checkbox.checked) set.add(profile.id);
                else set.delete(profile.id);

                s.profileIds = [...set];
                saveSettings();

                weightControls.style.display = checkbox.checked ? '' : 'none';
                updateAllPercentageDisplays(container);

                const spinBtn = uiRoot?.querySelector('#swipe_roulette_spin');
                if (spinBtn) spinBtn.disabled = getSpinCandidates().length === 0;
            });

            const text = document.createElement('span');
            text.className = 'swipe-roulette__profile-name';
            text.textContent = profile.name;

            label.appendChild(checkbox);
            label.appendChild(text);

            const weightControls = document.createElement('div');
            weightControls.className = 'swipe-roulette__weight-controls';
            weightControls.style.display = selectedIds.has(profile.id) ? '' : 'none';

            const weightSlider = document.createElement('input');
            weightSlider.type = 'range';
            weightSlider.min = '1';
            weightSlider.max = '10';
            weightSlider.className = 'swipe-roulette__weight-slider';
            weightSlider.value = String(getWeightForProfileId(profile.id));
            weightSlider.addEventListener('input', () => {
                const s = ensureSettings();
                if (!s) return;

                s.profileWeights[profile.id] = normalizeWeight(weightSlider.value);
                saveSettings();
                updateAllPercentageDisplays(container);
            });

            const weightPct = document.createElement('span');
            weightPct.className = 'swipe-roulette__weight-pct';
            weightPct.dataset.profileId = profile.id;

            weightControls.appendChild(weightSlider);
            weightControls.appendChild(weightPct);

            row.appendChild(label);
            row.appendChild(weightControls);
            fragment.appendChild(row);
        }

        container.appendChild(fragment);
        updateAllPercentageDisplays(container);
    }

    function refreshSettingsUi() {
        const root = ensureUiContainer();
        if (!root) return;

        const settings = getSettings();

        const enabledInput = root.querySelector('#swipe_roulette_enabled');
        const thresholdInput = root.querySelector('#swipe_roulette_threshold');
        const profilesContainer = root.querySelector('#swipe_roulette_profiles');
        const stateEl = root.querySelector('#swipe_roulette_profiles_state');

        const notificationsInput = root.querySelector('#swipe_roulette_show_notifications');

        if (enabledInput) enabledInput.checked = settings.enabled;
        if (thresholdInput) thresholdInput.value = String(getThreshold());
        if (notificationsInput) notificationsInput.checked = settings.showNotifications;
        renderProfilesChecklist(profilesContainer, stateEl);

        const spinBtn = root.querySelector('#swipe_roulette_spin');
        if (spinBtn) spinBtn.disabled = getSpinCandidates().length === 0;

        const spinResult = root.querySelector('#swipe_roulette_spin_result');
        if (spinResult && settings.spinLastProfileId) {
            const profile = getConnectionProfiles().find(p => p.id === settings.spinLastProfileId);
            spinResult.textContent = profile ? profile.name : '';
        }
    }

    function registerEvent(eventSource, eventTypes, eventKey, handler) {
        const eventName = eventTypes[eventKey];
        if (!eventName) return;
        eventSource.on(eventName, handler);
    }

    function init() {
        const ctx = getContext();
        const eventTypes = getEventTypes(ctx);
        const eventSource = ctx?.eventSource;
        if (!ctx || !eventTypes || !eventSource) {
            warn('Context or event bus unavailable during init');
            return;
        }

        ensureSettings();
        pruneStaleProfileSelections();
        expectedProfileId = getActiveProfileId();

        registerEvent(eventSource, eventTypes, 'GENERATION_STARTED', onGenerationStarted);
        registerEvent(eventSource, eventTypes, 'MESSAGE_RECEIVED', onMessageReceived);
        registerEvent(eventSource, eventTypes, 'GENERATION_STOPPED', onGenerationStopped);
        registerEvent(eventSource, eventTypes, 'GENERATION_ENDED', onGenerationEnded);
        registerEvent(eventSource, eventTypes, 'CHAT_CHANGED', onChatChanged);

        registerEvent(eventSource, eventTypes, 'CONNECTION_PROFILE_CREATED', onConnectionProfileChanged);
        registerEvent(eventSource, eventTypes, 'CONNECTION_PROFILE_UPDATED', onConnectionProfileChanged);
        registerEvent(eventSource, eventTypes, 'CONNECTION_PROFILE_DELETED', onConnectionProfileChanged);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', refreshSettingsUi, { once: true });
        } else {
            refreshSettingsUi();
        }

        log('Extension initialized');
    }

    function boot(retries = 0) {
        const ctx = getContext();
        const eventTypes = getEventTypes(ctx);
        if (!ctx?.eventSource || !eventTypes) {
            if (retries < MAX_BOOT_RETRIES) {
                setTimeout(() => boot(retries + 1), BOOT_RETRY_MS);
            } else {
                warn('Failed to initialize: SillyTavern context did not become available');
            }
            return;
        }

        init();
    }

    boot();
})();
