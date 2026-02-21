(function () {
    'use strict';

    const EXTENSION_NAME = 'swipe_roulette';
    const PROFILE_NONE_SENTINEL = '<None>';
    const MAX_BOOT_RETRIES = 14;
    const BOOT_RETRY_MS_INITIAL = 100;
    const BOOT_RETRY_MS_MAX = 2000;
    const CHAT_COMPLETION_SIGNATURE_KEYS = [
        'chat_completion_source',
        'openai_model',
        'azure_openai_model',
        'openrouter_model',
        'claude_model',
        'mistralai_model',
        'custom_model',
        'cohere_model',
        'perplexity_model',
        'groq_model',
        'siliconflow_model',
        'electronhub_model',
        'nanogpt_model',
        'deepseek_model',
        'xai_model',
        'aimlapi_model',
        'moonshot_model',
        'fireworks_model',
        'cometapi_model',
        'zai_model',
        'chutes_model',
        'ai21_model',
        'makersuite_model',
        'vertexai_model',
        'preset_settings_openai',
        'custom_url',
        'azure_base_url',
    ];
    const TEXT_COMPLETION_SIGNATURE_KEYS = [
        'type',
        'preset',
        'mancer_model',
        'togetherai_model',
        'infermaticai_model',
        'ollama_model',
        'openrouter_model',
        'vllm_model',
        'aphrodite_model',
        'dreamgen_model',
        'tabby_model',
        'llamacpp_model',
        'custom_model',
        'featherless_model',
        'generic_model',
        'api_server_textgenerationwebui',
    ];
    const DYNAMIC_SIGNATURE_KEY_PATTERNS = [
        /(^|_)model$/i,
        /(^|_)source$/i,
        /(^|_)preset$/i,
        /(^|_)url$/i,
        /^api_server_/i,
    ];

    let defaultSwipesUsed = 0;
    let swipeRotationActive = false;
    let profileBeforeSwipe = null;
    let connectionContextBeforeSwipe = null;
    let isRestoringSwipe = false;
    let rotationSeq = 0;
    let normalRoutingActive = false;
    let profileBeforeNormalRouting = null;
    let connectionContextBeforeNormalRouting = null;
    let isRestoringNormalRouting = false;
    let normalRoutingSeq = 0;
    let spinInFlight = false;
    let activeRotationToast = null;
    let expectedProfileId = null;
    let connectionSignature = null;
    let internalProfileSwitchDepth = 0;
    let pendingManualSwipeBypass = false;
    let lastOverallChanceGateSignature = null;

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
        if (typeof settings.normalMessageRoutingEnabled !== 'boolean') settings.normalMessageRoutingEnabled = false;
        if (settings.normalMessageRestoreMode !== 'restore' && settings.normalMessageRestoreMode !== 'keep') {
            settings.normalMessageRestoreMode = 'keep';
        }
        if (typeof settings.overallChanceEnabled !== 'boolean') settings.overallChanceEnabled = false;
        if (!Number.isFinite(Number(settings.overallChancePercent))) settings.overallChancePercent = 100;
        settings.overallChancePercent = sanitizePercentageInput(settings.overallChancePercent);
        if (typeof settings.overallChanceOnlyOnModelChange !== 'boolean') settings.overallChanceOnlyOnModelChange = false;

        return settings;
    }

    function saveSettings() {
        const ctx = getContext();
        if (!ctx?.saveSettingsDebounced) return;
        ctx.saveSettingsDebounced();
    }

    function getSettings() {
        return ensureSettings() || {
            enabled: false,
            profileIds: [],
            defaultSwipeThreshold: 0,
            debug: false,
            mode: 'weighted_random',
            profileWeights: {},
            spinLastProfileId: null,
            showNotifications: true,
            normalMessageRoutingEnabled: false,
            normalMessageRestoreMode: 'keep',
            overallChanceEnabled: false,
            overallChancePercent: 100,
            overallChanceOnlyOnModelChange: false,
        };
    }

    function isEnabled() {
        return Boolean(getSettings().enabled);
    }

    function isNormalMessageRoutingEnabled() {
        return Boolean(getSettings().normalMessageRoutingEnabled);
    }

    function isOverallChanceEnabled() {
        return Boolean(getSettings().overallChanceEnabled);
    }

    function getOverallChancePercent() {
        return sanitizePercentageInput(getSettings().overallChancePercent);
    }

    function isOverallChanceOnlyOnModelChange() {
        return Boolean(getSettings().overallChanceOnlyOnModelChange);
    }

    function getThreshold() {
        const value = Number(getSettings().defaultSwipeThreshold);
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.floor(value));
    }

    function getNormalRestoreMode() {
        const mode = getSettings().normalMessageRestoreMode;
        return mode === 'restore' ? 'restore' : 'keep';
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

    function isInternalProfileSwitchInProgress() {
        return internalProfileSwitchDepth > 0;
    }

    function stableStringify(value, seen = new WeakSet()) {
        if (value === null || typeof value !== 'object') {
            return JSON.stringify(value);
        }

        if (seen.has(value)) {
            return JSON.stringify('[Circular]');
        }
        seen.add(value);

        if (Array.isArray(value)) {
            const out = '[' + value.map(item => stableStringify(item, seen)).join(',') + ']';
            seen.delete(value);
            return out;
        }

        const keys = Object.keys(value).sort();
        const props = [];
        for (const key of keys) {
            const item = value[key];
            if (typeof item === 'undefined' || typeof item === 'function') continue;
            props.push(`${JSON.stringify(key)}:${stableStringify(item, seen)}`);
        }

        seen.delete(value);
        return '{' + props.join(',') + '}';
    }

    function isDynamicSignatureKey(key) {
        if (typeof key !== 'string' || key.length === 0) return false;
        return DYNAMIC_SIGNATURE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    }

    function pickKeys(source, keys, { includeDynamicKeys = false } = {}) {
        if (!source || typeof source !== 'object') return {};
        const out = {};
        const allowList = new Set(Array.isArray(keys) ? keys : []);

        for (const key of Object.keys(source)) {
            if (!allowList.has(key) && !(includeDynamicKeys && isDynamicSignatureKey(key))) continue;
            if (typeof source[key] === 'undefined') continue;
            out[key] = source[key];
        }

        return out;
    }

    function cloneValue(value) {
        if (typeof value === 'undefined') return value;
        if (typeof globalThis.structuredClone === 'function') {
            try {
                return globalThis.structuredClone(value);
            } catch (_error) {
                // Fall back to JSON clone for plain settings data.
            }
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_error) {
            return value;
        }
    }

    function copyObjectValues(source) {
        if (!source || typeof source !== 'object') return {};
        const out = {};
        for (const key of Object.keys(source)) {
            out[key] = cloneValue(source[key]);
        }
        return out;
    }

    function areEqualValues(left, right) {
        if (Object.is(left, right)) return true;

        const leftIsObject = left !== null && typeof left === 'object';
        const rightIsObject = right !== null && typeof right === 'object';
        if (!leftIsObject || !rightIsObject) return false;

        return stableStringify(left) === stableStringify(right);
    }

    function captureRestorableConnectionContext(reason = 'capture_restorable_context', { silent = false } = {}) {
        const ctx = getContext();
        if (!ctx) return null;

        const snapshot = {
            profileId: getActiveProfileId(),
            mainApi: cloneValue(ctx?.mainApi ?? null),
            chatCompletion: copyObjectValues(
                pickKeys(ctx?.chatCompletionSettings, CHAT_COMPLETION_SIGNATURE_KEYS, { includeDynamicKeys: true }),
            ),
            textCompletion: copyObjectValues(
                pickKeys(ctx?.textCompletionSettings, TEXT_COMPLETION_SIGNATURE_KEYS, { includeDynamicKeys: true }),
            ),
        };

        if (!silent) {
            log('Captured restorable connection context', {
                reason,
                profileId: snapshot.profileId,
                mainApi: snapshot.mainApi,
            });
        }

        return snapshot;
    }

    function getTrackedSubsetKeys(target, snapshotSubset, staticKeys) {
        const keys = new Set(Array.isArray(staticKeys) ? staticKeys : []);
        const objectsToScan = [target, snapshotSubset];

        for (const obj of objectsToScan) {
            if (!obj || typeof obj !== 'object') continue;
            for (const key of Object.keys(obj)) {
                if (isDynamicSignatureKey(key)) keys.add(key);
            }
        }

        return keys;
    }

    function applyTrackedSubset(target, snapshotSubset, staticKeys) {
        if (!target || typeof target !== 'object') return { changed: false, targetMissing: true };
        const source = snapshotSubset && typeof snapshotSubset === 'object' ? snapshotSubset : {};
        const trackedKeys = getTrackedSubsetKeys(target, source, staticKeys);

        let changed = false;
        for (const key of trackedKeys) {
            const hasSavedValue = Object.prototype.hasOwnProperty.call(source, key);

            if (hasSavedValue) {
                const nextValue = cloneValue(source[key]);
                if (!areEqualValues(target[key], nextValue)) {
                    target[key] = nextValue;
                    changed = true;
                }
                continue;
            }

            if (Object.prototype.hasOwnProperty.call(target, key)) {
                delete target[key];
                changed = true;
            }
        }

        return { changed, targetMissing: false };
    }

    function isTrackedSubsetMatch(currentSubset, savedSubset, staticKeys) {
        const current = currentSubset && typeof currentSubset === 'object' ? currentSubset : {};
        const saved = savedSubset && typeof savedSubset === 'object' ? savedSubset : {};
        const trackedKeys = getTrackedSubsetKeys(current, saved, staticKeys);

        for (const key of trackedKeys) {
            const currentHas = Object.prototype.hasOwnProperty.call(current, key);
            const savedHas = Object.prototype.hasOwnProperty.call(saved, key);

            if (currentHas !== savedHas) return false;
            if (!currentHas) continue;
            if (!areEqualValues(current[key], saved[key])) return false;
        }

        return true;
    }

    function isRestorableConnectionContextMatch(savedSnapshot) {
        if (!savedSnapshot || typeof savedSnapshot !== 'object') return true;
        const current = captureRestorableConnectionContext('verify_restorable_context', { silent: true });
        if (!current) return false;

        if (!areEqualValues(current.mainApi ?? null, savedSnapshot.mainApi ?? null)) return false;
        if (!isTrackedSubsetMatch(current.chatCompletion, savedSnapshot.chatCompletion, CHAT_COMPLETION_SIGNATURE_KEYS)) {
            return false;
        }
        if (!isTrackedSubsetMatch(current.textCompletion, savedSnapshot.textCompletion, TEXT_COMPLETION_SIGNATURE_KEYS)) {
            return false;
        }

        return true;
    }

    function applyRestorableSnapshotToContext(ctx, snapshot) {
        let changed = false;
        let complete = true;

        const savedMainApi = snapshot.mainApi ?? null;
        if (!areEqualValues(ctx.mainApi ?? null, savedMainApi)) {
            ctx.mainApi = cloneValue(savedMainApi);
            changed = true;
        }

        const chatResult = applyTrackedSubset(
            ctx.chatCompletionSettings,
            snapshot.chatCompletion,
            CHAT_COMPLETION_SIGNATURE_KEYS,
        );
        if (chatResult.targetMissing) {
            complete = false;
            warn('Unable to restore chat completion settings: target unavailable');
        } else {
            changed = changed || chatResult.changed;
        }

        const textResult = applyTrackedSubset(
            ctx.textCompletionSettings,
            snapshot.textCompletion,
            TEXT_COMPLETION_SIGNATURE_KEYS,
        );
        if (textResult.targetMissing) {
            complete = false;
            warn('Unable to restore text completion settings: target unavailable');
        } else {
            changed = changed || textResult.changed;
        }

        return { changed, complete };
    }

    async function applyRestorableConnectionContext(savedSnapshot, reason = 'restore_connection_context') {
        if (!savedSnapshot || typeof savedSnapshot !== 'object') return true;

        const ctx = getContext();
        if (!ctx) {
            warn('Unable to restore connection context: SillyTavern context unavailable');
            return false;
        }

        const fallbackSnapshot = captureRestorableConnectionContext('capture_restore_fallback', { silent: true });
        let complete = true;
        internalProfileSwitchDepth += 1;

        try {
            const applyResult = applyRestorableSnapshotToContext(ctx, savedSnapshot);
            const changed = applyResult.changed;
            complete = complete && applyResult.complete;

            if (changed) {
                saveSettings();
                log('Applied restorable connection context', {
                    reason,
                    profileId: savedSnapshot.profileId ?? null,
                    mainApi: savedSnapshot.mainApi ?? null,
                });
            } else {
                log('Restorable connection context already matched', {
                    reason,
                    profileId: savedSnapshot.profileId ?? null,
                });
            }
        } catch (error) {
            complete = false;
            warn('Failed to apply restorable connection context', error);
        } finally {
            internalProfileSwitchDepth = Math.max(0, internalProfileSwitchDepth - 1);
            captureConnectionContext(reason);
        }

        if (!isRestorableConnectionContextMatch(savedSnapshot)) {
            complete = false;
            warn('Unable to fully restore saved model/provider context; restoring previous active context instead');

            if (fallbackSnapshot) {
                internalProfileSwitchDepth += 1;
                try {
                    const rollbackResult = applyRestorableSnapshotToContext(ctx, fallbackSnapshot);
                    if (rollbackResult.changed) {
                        saveSettings();
                    }
                } catch (error) {
                    warn('Failed to restore previous active context after restore mismatch', error);
                } finally {
                    internalProfileSwitchDepth = Math.max(0, internalProfileSwitchDepth - 1);
                    captureConnectionContext(`${reason}:rollback`);
                }
            }
        }

        return complete;
    }

    function getActiveProfileSnapshot(activeProfileId) {
        if (!activeProfileId) return null;
        const ctx = getContext();
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
        if (!Array.isArray(profiles)) return null;
        const profile = profiles.find(p => p && typeof p === 'object' && p.id === activeProfileId);
        return profile || null;
    }

    function computeConnectionSignature() {
        const ctx = getContext();
        const activeProfileId = getActiveProfileId();

        const snapshot = {
            mainApi: ctx?.mainApi || null,
            selectedProfileId: activeProfileId,
            selectedProfile: getActiveProfileSnapshot(activeProfileId),
            chatCompletion: pickKeys(ctx?.chatCompletionSettings, CHAT_COMPLETION_SIGNATURE_KEYS, { includeDynamicKeys: true }),
            textCompletion: pickKeys(ctx?.textCompletionSettings, TEXT_COMPLETION_SIGNATURE_KEYS, { includeDynamicKeys: true }),
        };

        return stableStringify(snapshot);
    }

    function captureConnectionContext(reason = 'capture') {
        expectedProfileId = getActiveProfileId();
        connectionSignature = computeConnectionSignature();
        log('Captured connection context', { reason, expectedProfileId });
    }

    function resetOverallChanceGateSignature(reason = 'reset') {
        if (lastOverallChanceGateSignature === null) return;
        lastOverallChanceGateSignature = null;
        log('Reset overall chance gate signature', { reason });
    }

    function syncConnectionContext(reason, options = {}) {
        const { resetCounter = true, cancelActiveRotation = true } = options;
        if (isInternalProfileSwitchInProgress()) {
            log('Skipping connection sync during internal profile switch', { reason });
            return false;
        }

        const currentProfileId = getActiveProfileId();
        const nextSignature = computeConnectionSignature();
        const profileChanged = currentProfileId !== expectedProfileId;
        const signatureChanged = nextSignature !== connectionSignature;
        if (!profileChanged && !signatureChanged) return false;

        log('Connection context changed', {
            reason,
            expectedProfileId,
            currentProfileId,
            profileChanged,
            signatureChanged,
        });

        expectedProfileId = currentProfileId;
        connectionSignature = nextSignature;
        resetOverallChanceGateSignature(`connection_context_changed:${reason}`);

        if (resetCounter) {
            defaultSwipesUsed = 0;
        }

        if (cancelActiveRotation) {
            if (swipeRotationActive) {
                resetSwipeState();
            }
            if (normalRoutingActive) {
                resetNormalRoutingState();
            }
        }

        return true;
    }

    function shouldSkipSwipeRotationByOverallChance() {
        if (!isOverallChanceEnabled()) return false;

        const currentSignature = computeConnectionSignature();
        const modelChangeOnly = isOverallChanceOnlyOnModelChange();
        if (modelChangeOnly && typeof lastOverallChanceGateSignature === 'string' && currentSignature === lastOverallChanceGateSignature) {
            log('Skipping overall chance gate check: signature unchanged');
            return false;
        }

        lastOverallChanceGateSignature = currentSignature;
        const percent = getOverallChancePercent();
        const roll = Math.random() * 100;
        const passes = roll < percent;
        log('Overall chance gate roll', {
            percent,
            roll: Number(roll.toFixed(2)),
            passes,
            modelChangeOnly,
        });
        return !passes;
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

    async function performInternalProfileSwitch(profileName, reason) {
        internalProfileSwitchDepth += 1;
        try {
            await switchProfileByName(profileName);
            captureConnectionContext(reason);
        } finally {
            internalProfileSwitchDepth = Math.max(0, internalProfileSwitchDepth - 1);
        }
    }

    function showRotationToast(profileName, { sticky = true } = {}) {
        if (!getSettings().showNotifications) return;
        dismissRotationToast();
        if (!sticky) {
            toastr.info(
                profileName,
                'Swipe Roulette',
                { timeOut: 3500, extendedTimeOut: 1000 },
            );
            return;
        }

        activeRotationToast = toastr.info(
            profileName,
            'Swipe Roulette',
            { timeOut: 0, extendedTimeOut: 0 },
        );
    }

    function dismissRotationToast() {
        if (!activeRotationToast) return;
        toastr.clear(activeRotationToast, { force: true });
        activeRotationToast = null;
    }

    function getWeightedCandidates({ excludeActiveProfile = false } = {}) {
        const settings = getSettings();
        const selectedIds = new Set(settings.profileIds);
        const profiles = getConnectionProfiles();
        const activeProfileId = getActiveProfileId();

        return profiles
            .filter(p => !excludeActiveProfile || p.id !== activeProfileId)
            .filter(p => selectedIds.has(p.id))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function getRotationCandidates() {
        return getWeightedCandidates({ excludeActiveProfile: false });
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
        connectionContextBeforeSwipe = null;
        isRestoringSwipe = false;
        dismissRotationToast();
    }

    function resetNormalRoutingState() {
        normalRoutingSeq++;
        normalRoutingActive = false;
        profileBeforeNormalRouting = null;
        connectionContextBeforeNormalRouting = null;
        isRestoringNormalRouting = false;
        dismissRotationToast();
    }

    async function restoreSwipeProfile() {
        if (!swipeRotationActive || isRestoringSwipe) return;
        isRestoringSwipe = true;

        const seq = rotationSeq;
        const savedProfileId = profileBeforeSwipe;
        const savedContext = connectionContextBeforeSwipe;
        const profiles = getConnectionProfiles();
        const originalProfile = profiles.find(p => p.id === savedProfileId) || null;

        try {
            if (originalProfile) {
                await performInternalProfileSwitch(originalProfile.name, 'restore_profile');
                log('Restored profile', originalProfile.name);
            } else {
                await performInternalProfileSwitch(PROFILE_NONE_SENTINEL, 'restore_none');
                log('Restored to no profile');
            }

            const contextRestored = await applyRestorableConnectionContext(savedContext, 'restore_swipe_context');
            if (!contextRestored) {
                warn('Swipe restore could not fully restore saved model/provider context');
            }

            dismissRotationToast();
        } catch (error) {
            warn('Failed to restore profile after swipe generation', error);
        } finally {
            if (rotationSeq === seq) {
                swipeRotationActive = false;
                profileBeforeSwipe = null;
                connectionContextBeforeSwipe = null;
            } else {
                log('Skipping stale restore cleanup', { seq, current: rotationSeq });
            }
            isRestoringSwipe = false;
        }
    }

    async function restoreNormalRoutingProfile() {
        if (!normalRoutingActive || isRestoringNormalRouting) return;
        isRestoringNormalRouting = true;

        const seq = normalRoutingSeq;
        const savedProfileId = profileBeforeNormalRouting;
        const savedContext = connectionContextBeforeNormalRouting;
        const profiles = getConnectionProfiles();
        const originalProfile = profiles.find(p => p.id === savedProfileId) || null;

        try {
            if (originalProfile) {
                await performInternalProfileSwitch(originalProfile.name, 'restore_normal_profile');
                log('Restored profile after normal message generation', originalProfile.name);
            } else {
                await performInternalProfileSwitch(PROFILE_NONE_SENTINEL, 'restore_normal_none');
                log('Restored to no profile after normal message generation');
            }

            const contextRestored = await applyRestorableConnectionContext(savedContext, 'restore_normal_context');
            if (!contextRestored) {
                warn('Normal restore could not fully restore saved model/provider context');
            }

            dismissRotationToast();
        } catch (error) {
            warn('Failed to restore profile after normal message generation', error);
        } finally {
            if (normalRoutingSeq === seq) {
                normalRoutingActive = false;
                profileBeforeNormalRouting = null;
                connectionContextBeforeNormalRouting = null;
            } else {
                log('Skipping stale normal restore cleanup', { seq, current: normalRoutingSeq });
            }
            isRestoringNormalRouting = false;
        }
    }

    async function onGenerationStarted(type, _params, dryRun) {
        if (dryRun === true) return;

        const contextChanged = syncConnectionContext(`generation_started:${type}`, {
            resetCounter: type === 'swipe',
            cancelActiveRotation: true,
        });
        if (type === 'swipe' && contextChanged) {
            return;
        }
        if (type === 'swipe' && pendingManualSwipeBypass) {
            pendingManualSwipeBypass = false;
            defaultSwipesUsed = 0;
            log('Skipping swipe rotation after manual connection change');
            return;
        }

        // Restore stale rotation from a previous generation that never completed
        if (swipeRotationActive && !isRestoringSwipe && type !== 'quiet') {
            log('Recovering stale rotation before', type, 'generation');
            await restoreSwipeProfile();
        }

        // Restore stale non-swipe temporary routing if a previous run never finished cleanly
        if (normalRoutingActive && !isRestoringNormalRouting && type !== 'quiet') {
            log('Recovering stale normal restore state before', type, 'generation');
            await restoreNormalRoutingProfile();
        }

        if (type !== 'swipe' && type !== 'normal') {
            if (type !== 'quiet') {
                defaultSwipesUsed = 0;
            }
            return;
        }

        if (type === 'normal') {
            defaultSwipesUsed = 0;

            if (!isNormalMessageRoutingEnabled()) return;

            const candidates = getRotationCandidates();
            if (candidates.length === 0) {
                log('No candidates available for normal message routing');
                return;
            }

            const target = weightedRandomDraw(candidates, (p) => getWeightForProfileId(p.id));
            if (!target) {
                log('Weighted draw returned no target for normal message routing');
                return;
            }

            const activeProfileId = getActiveProfileId();
            if (target.id === activeProfileId) {
                log('Selected profile already active for normal generation', target.name);
                return;
            }

            const restoreAfter = getNormalRestoreMode() === 'restore';
            if (restoreAfter) {
                normalRoutingSeq++;
                if (!normalRoutingActive) {
                    profileBeforeNormalRouting = activeProfileId;
                    connectionContextBeforeNormalRouting = captureRestorableConnectionContext('capture_before_normal_switch');
                }
            } else {
                normalRoutingActive = false;
                profileBeforeNormalRouting = null;
                connectionContextBeforeNormalRouting = null;
                isRestoringNormalRouting = false;
            }

            try {
                await performInternalProfileSwitch(target.name, 'normal_message_switch');
                if (restoreAfter) {
                    normalRoutingActive = true;
                    showRotationToast(target.name, { sticky: true });
                } else {
                    showRotationToast(target.name, { sticky: false });
                }
                log('Switched profile for normal generation', { profile: target.name, restoreAfter });
            } catch (error) {
                warn('Failed to switch profile for normal generation', error);
                if (restoreAfter) {
                    normalRoutingActive = false;
                    profileBeforeNormalRouting = null;
                    connectionContextBeforeNormalRouting = null;
                }
            }

            return;
        }

        if (!isEnabled()) return;

        defaultSwipesUsed += 1;
        const threshold = getThreshold();
        if (defaultSwipesUsed <= threshold) {
            log('Swipe within threshold, skipping rotation', { defaultSwipesUsed, threshold });
            return;
        }

        if (shouldSkipSwipeRotationByOverallChance()) {
            log('Swipe rotation blocked by overall chance gate');
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
            connectionContextBeforeSwipe = captureRestorableConnectionContext('capture_before_swipe_switch');
        }

        try {
            await performInternalProfileSwitch(target.name, 'swipe_rotation_switch');
            swipeRotationActive = true;
            showRotationToast(target.name, { sticky: true });
            log('Switched profile for swipe generation', target.name);
        } catch (error) {
            warn('Failed to switch profile for swipe generation', error);
            swipeRotationActive = false;
            profileBeforeSwipe = null;
            connectionContextBeforeSwipe = null;
        }
    }

    async function onMessageReceived(_messageId, type) {
        if (type === 'swipe') {
            await restoreSwipeProfile();
            return;
        }

        if (type === 'normal') {
            await restoreNormalRoutingProfile();
        }
    }

    async function onGenerationStopped() {
        await restoreSwipeProfile();
        await restoreNormalRoutingProfile();
    }

    async function onGenerationEnded() {
        await restoreSwipeProfile();
        await restoreNormalRoutingProfile();
    }

    async function onChatChanged() {
        await restoreSwipeProfile();
        await restoreNormalRoutingProfile();
        resetSwipeCounters();
        resetSwipeState();
        resetNormalRoutingState();
        pendingManualSwipeBypass = false;
        resetOverallChanceGateSignature('chat_changed');
        captureConnectionContext('chat_changed');
    }

    async function spinNow() {
        if (spinInFlight) return;
        spinInFlight = true;

        resetSwipeState();
        resetNormalRoutingState();

        try {
            const candidates = getSpinCandidates();
            if (candidates.length === 0) {
                const resultEl = uiRoot?.querySelector('#swipe_roulette_spin_result');
                if (resultEl) resultEl.textContent = 'No profiles selected';
                return;
            }

            const target = weightedRandomDraw(candidates, (p) => getWeightForProfileId(p.id));
            if (!target) return;

            await performInternalProfileSwitch(target.name, 'spin_switch');
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
        syncConnectionContext('event:CONNECTION_PROFILE_CATALOG');
        refreshSettingsUi();
    }

    function onConnectionContextSignal(eventKey) {
        const changed = syncConnectionContext(`event:${eventKey}`);
        if (changed) {
            pendingManualSwipeBypass = true;
            log('Armed one-swipe bypass after manual connection context change', { eventKey });
        }
    }

    function sanitizeThresholdInput(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.floor(n));
    }

    function sanitizePercentageInput(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(100, Math.floor(n)));
    }

    function normalizeNormalRestoreMode(value) {
        return value === 'restore' ? 'restore' : 'keep';
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
        return getWeightedCandidates({ excludeActiveProfile: false });
    }

    function ensureUiContainer() {
        if (uiRoot?.isConnected) return uiRoot;

        const parent = document.getElementById('extensions_settings2');
        if (!parent) return null;

        const wrapper = document.createElement('div');
        wrapper.id = `${EXTENSION_NAME}_container`;
        wrapper.className = 'extension_container';
        wrapper.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Swipe Roulette</b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="swipe-roulette">
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
                            <input type="checkbox" id="swipe_roulette_overall_chance_enabled">
                            <span>Enable overall chance gate for swipe rotation</span>
                        </label>
                        <label class="swipe-roulette__field" id="swipe_roulette_overall_chance_percent_field" for="swipe_roulette_overall_chance_percent">
                            <span class="swipe-roulette__label">Overall chance (%)</span>
                            <input type="number" id="swipe_roulette_overall_chance_percent" min="0" max="100" step="1" class="text_pole widthNatural">
                        </label>
                        <label class="checkbox_label flexNoGap swipe-roulette__toggle" id="swipe_roulette_overall_chance_model_change_only_field">
                            <input type="checkbox" id="swipe_roulette_overall_chance_model_change_only">
                            <span>Apply only when model/config changes</span>
                        </label>
                        <div class="swipe-roulette__hint">
                            Overall chance gate runs after threshold. With model/config-only enabled, the random roll is re-checked only after connection signature changes.
                        </div>
                        <label class="checkbox_label flexNoGap swipe-roulette__toggle">
                            <input type="checkbox" id="swipe_roulette_normal_enabled">
                            <span>Enable weighted routing for user messages</span>
                        </label>
                        <label class="swipe-roulette__field" id="swipe_roulette_normal_restore_field" for="swipe_roulette_normal_restore_mode">
                            <span class="swipe-roulette__label">After user-message response</span>
                            <select id="swipe_roulette_normal_restore_mode" class="text_pole swipe-roulette__select">
                                <option value="keep">Keep selected profile active</option>
                                <option value="restore">Restore previous profile</option>
                            </select>
                        </label>
                        <div class="swipe-roulette__hint">
                            User-message routing applies to normal sends only. Regenerate, continue, and impersonate stay unchanged.
                        </div>
                        <label class="checkbox_label flexNoGap swipe-roulette__toggle">
                            <input type="checkbox" id="swipe_roulette_show_notifications">
                            <span>Show notification on profile switch</span>
                        </label>
                        <div id="swipe_roulette_profiles_state" class="swipe-roulette__state"></div>
                        <div id="swipe_roulette_profiles" class="swipe-roulette__profiles"></div>
                        <div class="swipe-roulette__hint">
                            Drag sliders to adjust selection probability used by swipes, user-message routing, and Spin.
                        </div>
                        <div class="swipe-roulette__spin-section">
                            <button id="swipe_roulette_spin" class="menu_button swipe-roulette__spin-btn" disabled>Spin</button>
                            <span id="swipe_roulette_spin_result" class="swipe-roulette__spin-result"></span>
                        </div>
                    </div>
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
        const normalRoutingInput = uiRoot.querySelector('#swipe_roulette_normal_enabled');
        const normalRestoreModeInput = uiRoot.querySelector('#swipe_roulette_normal_restore_mode');
        const thresholdInput = uiRoot.querySelector('#swipe_roulette_threshold');
        const overallChanceEnabledInput = uiRoot.querySelector('#swipe_roulette_overall_chance_enabled');
        const overallChancePercentInput = uiRoot.querySelector('#swipe_roulette_overall_chance_percent');
        const overallChanceModelChangeOnlyInput = uiRoot.querySelector('#swipe_roulette_overall_chance_model_change_only');

        if (enabledInput) {
            enabledInput.addEventListener('change', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.enabled = enabledInput.checked;
                saveSettings();
            });
        }

        if (normalRoutingInput) {
            normalRoutingInput.addEventListener('change', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.normalMessageRoutingEnabled = normalRoutingInput.checked;
                saveSettings();
                refreshNormalRestoreModeUi();
            });
        }

        if (normalRestoreModeInput) {
            normalRestoreModeInput.addEventListener('change', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.normalMessageRestoreMode = normalizeNormalRestoreMode(normalRestoreModeInput.value);
                normalRestoreModeInput.value = settings.normalMessageRestoreMode;
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

        if (overallChanceEnabledInput) {
            overallChanceEnabledInput.addEventListener('change', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.overallChanceEnabled = overallChanceEnabledInput.checked;
                resetOverallChanceGateSignature('settings:overall_chance_enabled');
                saveSettings();
                refreshOverallChanceUi();
            });
        }

        if (overallChancePercentInput) {
            overallChancePercentInput.addEventListener('input', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.overallChancePercent = sanitizePercentageInput(overallChancePercentInput.value);
                overallChancePercentInput.value = String(settings.overallChancePercent);
                saveSettings();
            });
        }

        if (overallChanceModelChangeOnlyInput) {
            overallChanceModelChangeOnlyInput.addEventListener('change', () => {
                const settings = ensureSettings();
                if (!settings) return;

                settings.overallChanceOnlyOnModelChange = overallChanceModelChangeOnlyInput.checked;
                resetOverallChanceGateSignature('settings:overall_chance_model_only');
                saveSettings();
                refreshOverallChanceUi();
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

    function refreshNormalRestoreModeUi() {
        if (!uiRoot) return;
        const normalRoutingInput = uiRoot.querySelector('#swipe_roulette_normal_enabled');
        const restoreModeInput = uiRoot.querySelector('#swipe_roulette_normal_restore_mode');
        const restoreField = uiRoot.querySelector('#swipe_roulette_normal_restore_field');
        if (!normalRoutingInput || !restoreModeInput || !restoreField) return;

        const enabled = normalRoutingInput.checked;
        restoreModeInput.disabled = !enabled;
        restoreField.classList.toggle('swipe-roulette__field--disabled', !enabled);
    }

    function refreshOverallChanceUi() {
        if (!uiRoot) return;
        const enabledInput = uiRoot.querySelector('#swipe_roulette_overall_chance_enabled');
        const percentInput = uiRoot.querySelector('#swipe_roulette_overall_chance_percent');
        const percentField = uiRoot.querySelector('#swipe_roulette_overall_chance_percent_field');
        const modelChangeOnlyInput = uiRoot.querySelector('#swipe_roulette_overall_chance_model_change_only');
        const modelChangeOnlyField = uiRoot.querySelector('#swipe_roulette_overall_chance_model_change_only_field');
        if (!enabledInput || !percentInput || !percentField || !modelChangeOnlyInput || !modelChangeOnlyField) return;

        const enabled = enabledInput.checked;
        percentInput.disabled = !enabled;
        modelChangeOnlyInput.disabled = !enabled;
        percentField.classList.toggle('swipe-roulette__field--disabled', !enabled);
        modelChangeOnlyField.classList.toggle('swipe-roulette__field--disabled', !enabled);
    }

    function renderProfilesChecklist(container, stateEl) {
        if (!container || !stateEl) return;

        pruneStaleProfileSelections();
        const settings = getSettings();
        const profiles = getConnectionProfiles().sort((a, b) => a.name.localeCompare(b.name));
        const selectedIds = new Set(settings.profileIds);

        // Remove delegated listeners from a previous render before wiping innerHTML
        if (container._srChangeHandler) {
            container.removeEventListener('change', container._srChangeHandler);
            container._srChangeHandler = null;
        }
        if (container._srInputHandler) {
            container.removeEventListener('input', container._srInputHandler);
            container._srInputHandler = null;
        }

        container.innerHTML = '';

        if (profiles.length === 0) {
            stateEl.textContent = 'No Connection Manager profiles found. Create profiles first.';
            stateEl.classList.remove('swipe-roulette__state--ok');
            container.style.display = 'none';
            return;
        }

        container.style.display = '';
        stateEl.textContent = 'Select profiles for weighted routing. The same weights are used for swipes, user messages, and Spin.';
        stateEl.classList.add('swipe-roulette__state--ok');

        const fragment = document.createDocumentFragment();
        for (const profile of profiles) {
            const row = document.createElement('div');
            row.className = 'swipe-roulette__profile-row';
            row.dataset.profileId = profile.id;

            const label = document.createElement('label');
            label.className = 'checkbox_label flexNoGap swipe-roulette__profile-item';
            label.style.flex = '1';
            label.style.minWidth = '0';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedIds.has(profile.id);
            checkbox.dataset.profileId = profile.id;
            checkbox.className = 'swipe-roulette__profile-checkbox';

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
            weightSlider.dataset.profileId = profile.id;

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

        // Single delegated listener for checkbox changes
        container._srChangeHandler = (e) => {
            const checkbox = e.target.closest('.swipe-roulette__profile-checkbox');
            if (!checkbox) return;

            const profileId = checkbox.dataset.profileId;
            if (!profileId) return;

            const s = ensureSettings();
            if (!s) return;

            const set = new Set(s.profileIds);
            if (checkbox.checked) set.add(profileId);
            else set.delete(profileId);
            s.profileIds = [...set];
            saveSettings();

            const row = checkbox.closest('.swipe-roulette__profile-row');
            const weightControls = row?.querySelector('.swipe-roulette__weight-controls');
            if (weightControls) weightControls.style.display = checkbox.checked ? '' : 'none';

            updateAllPercentageDisplays(container);

            const spinBtn = uiRoot?.querySelector('#swipe_roulette_spin');
            if (spinBtn) spinBtn.disabled = getSpinCandidates().length === 0;
        };
        container.addEventListener('change', container._srChangeHandler);

        // Single delegated listener for slider input
        container._srInputHandler = (e) => {
            const slider = e.target.closest('.swipe-roulette__weight-slider');
            if (!slider) return;

            const profileId = slider.dataset.profileId;
            if (!profileId) return;

            const s = ensureSettings();
            if (!s) return;

            s.profileWeights[profileId] = normalizeWeight(slider.value);
            saveSettings();
            updateAllPercentageDisplays(container);
        };
        container.addEventListener('input', container._srInputHandler);

        updateAllPercentageDisplays(container);
    }

    function refreshSettingsUi() {
        const root = ensureUiContainer();
        if (!root) return;

        const settings = getSettings();

        const enabledInput = root.querySelector('#swipe_roulette_enabled');
        const normalRoutingInput = root.querySelector('#swipe_roulette_normal_enabled');
        const normalRestoreModeInput = root.querySelector('#swipe_roulette_normal_restore_mode');
        const thresholdInput = root.querySelector('#swipe_roulette_threshold');
        const overallChanceEnabledInput = root.querySelector('#swipe_roulette_overall_chance_enabled');
        const overallChancePercentInput = root.querySelector('#swipe_roulette_overall_chance_percent');
        const overallChanceModelChangeOnlyInput = root.querySelector('#swipe_roulette_overall_chance_model_change_only');
        const profilesContainer = root.querySelector('#swipe_roulette_profiles');
        const stateEl = root.querySelector('#swipe_roulette_profiles_state');

        const notificationsInput = root.querySelector('#swipe_roulette_show_notifications');

        if (enabledInput) enabledInput.checked = settings.enabled;
        if (normalRoutingInput) normalRoutingInput.checked = settings.normalMessageRoutingEnabled;
        if (normalRestoreModeInput) normalRestoreModeInput.value = getNormalRestoreMode();
        if (thresholdInput) thresholdInput.value = String(getThreshold());
        if (overallChanceEnabledInput) overallChanceEnabledInput.checked = isOverallChanceEnabled();
        if (overallChancePercentInput) overallChancePercentInput.value = String(getOverallChancePercent());
        if (overallChanceModelChangeOnlyInput) overallChanceModelChangeOnlyInput.checked = isOverallChanceOnlyOnModelChange();
        if (notificationsInput) notificationsInput.checked = settings.showNotifications;
        refreshOverallChanceUi();
        refreshNormalRestoreModeUi();
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
        captureConnectionContext('init');

        registerEvent(eventSource, eventTypes, 'GENERATION_STARTED', onGenerationStarted);
        registerEvent(eventSource, eventTypes, 'MESSAGE_RECEIVED', onMessageReceived);
        registerEvent(eventSource, eventTypes, 'GENERATION_STOPPED', onGenerationStopped);
        registerEvent(eventSource, eventTypes, 'GENERATION_ENDED', onGenerationEnded);
        registerEvent(eventSource, eventTypes, 'CHAT_CHANGED', onChatChanged);

        registerEvent(eventSource, eventTypes, 'CONNECTION_PROFILE_CREATED', onConnectionProfileChanged);
        registerEvent(eventSource, eventTypes, 'CONNECTION_PROFILE_UPDATED', onConnectionProfileChanged);
        registerEvent(eventSource, eventTypes, 'CONNECTION_PROFILE_DELETED', onConnectionProfileChanged);
        registerEvent(eventSource, eventTypes, 'CONNECTION_PROFILE_LOADED', () => onConnectionContextSignal('CONNECTION_PROFILE_LOADED'));
        registerEvent(eventSource, eventTypes, 'MAIN_API_CHANGED', () => onConnectionContextSignal('MAIN_API_CHANGED'));
        registerEvent(eventSource, eventTypes, 'CHATCOMPLETION_SOURCE_CHANGED', () => onConnectionContextSignal('CHATCOMPLETION_SOURCE_CHANGED'));
        registerEvent(eventSource, eventTypes, 'CHATCOMPLETION_MODEL_CHANGED', () => onConnectionContextSignal('CHATCOMPLETION_MODEL_CHANGED'));
        registerEvent(eventSource, eventTypes, 'PRESET_CHANGED', () => onConnectionContextSignal('PRESET_CHANGED'));
        registerEvent(eventSource, eventTypes, 'OAI_PRESET_CHANGED_AFTER', () => onConnectionContextSignal('OAI_PRESET_CHANGED_AFTER'));
        registerEvent(eventSource, eventTypes, 'SETTINGS_UPDATED', () => onConnectionContextSignal('SETTINGS_UPDATED'));

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
                const delay = Math.min(BOOT_RETRY_MS_INITIAL * Math.pow(2, retries), BOOT_RETRY_MS_MAX);
                setTimeout(() => boot(retries + 1), delay);
            } else {
                warn('Failed to initialize: SillyTavern context did not become available');
            }
            return;
        }

        init();
    }

    boot();
})();
