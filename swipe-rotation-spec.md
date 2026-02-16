# Swipe Profile Rotation — Implementation Spec

A standalone SillyTavern extension that automatically cycles Connection Manager profiles on each swipe, so every alternative response comes from a different model/API configuration.

---

## Why This Works: SillyTavern's Generation Pipeline

### The Key Event: `GENERATION_STARTED`

When a user clicks the swipe-right arrow, SillyTavern's flow is:

1. **Swipe button click** → `swipe()` function (`script.js:9683`)
2. Swipe animation plays, `MESSAGE_SWIPED` event emits (`script.js:10048`)
3. If overswiping (requesting a new generation), calls `Generate('swipe')` (`script.js:10052`)
4. **Inside `Generate()`** (`script.js:4123`), the very first meaningful action is:
   ```javascript
   await eventSource.emit(event_types.GENERATION_STARTED, type, { automatic_trigger, ... }, dryRun);
   ```
   This is on **line 4132** of `script.js`.

The critical detail: **`await`**. Because `eventSource.emit` is awaited, any async event handler you register will fully complete before the generation pipeline continues to build the prompt and make the API call. This gives us a reliable window to switch the Connection Manager profile before the request fires.

The `type` parameter is the string `'swipe'` — this lets us filter so we only intercept swipe generations, not normal sends, regenerations, impersonations, or quiet prompts.

### Other Relevant Events

All defined in `public/scripts/events.js`:

| Event | When it fires | Awaited? | Use |
|-------|--------------|----------|-----|
| `GENERATION_STARTED` | Immediately when `Generate()` is called, before anything else | **Yes** | Switch profile before API call |
| `GENERATION_AFTER_COMMANDS` | After slash command processing, before prompt building | Yes | Alternative interception point (but `GENERATION_STARTED` is simpler) |
| `MESSAGE_SWIPED` | During swipe animation, before `Generate('swipe')` is called | Yes | Could also use this, but it fires for ALL swipes including browsing existing ones |
| `MESSAGE_RECEIVED` | When the AI response is added to the chat | Varies | Restore the original profile after generation completes |
| `GENERATION_STOPPED` | When the user clicks the stop button mid-generation | No | Restore profile on abort |
| `GENERATION_ENDED` | When the stop button UI is hidden | No | Less reliable — only fires in `cancelStatusCheck()` |

### Why `GENERATION_STARTED` and Not `MESSAGE_SWIPED`

`MESSAGE_SWIPED` fires for **every** swipe — including swiping left/right through existing swipes that don't trigger new generation. `GENERATION_STARTED` with `type === 'swipe'` fires **only** when a new swipe response is being generated. This avoids false triggers.

### Why Restore on `MESSAGE_RECEIVED` + `GENERATION_STOPPED`

A swipe generation can end two ways:
1. **Normal completion** → `MESSAGE_RECEIVED` fires when the response is added to chat
2. **User abort** → `GENERATION_STOPPED` fires when the user clicks the stop button

We restore the profile on whichever fires first, using a boolean flag (`swipeRotationActive`) to ensure single restoration.

`GENERATION_ENDED` was considered but it only fires inside `cancelStatusCheck()` (the stop-button-hide logic at `script.js:3408-3411`), making it unreliable for normal completion.

---

## Connection Manager Profile Switching

### How Profiles Are Stored

Connection Manager stores its data in SillyTavern's extension settings:

```javascript
const context = SillyTavern.getContext();
const profiles = context.extensionSettings?.connectionManager?.profiles; // Array of {id, name, ...}
const activeId = context.extensionSettings?.connectionManager?.selectedProfile; // Currently active profile ID
```

- `profiles` is an array of objects, each with at least `id` (string) and `name` (string)
- `selectedProfile` is the `id` of the currently active profile

### How to Switch Profiles

SillyTavern's Connection Manager registers a `/profile` slash command. To switch:

```javascript
await context.executeSlashCommandsWithOptions(`/profile ${profileName}`);
```

This is the same mechanism used by Chat Manager's `ai-features.js` (line 195) and is the officially supported way to switch profiles programmatically. Using the name (not the ID) is required.

To deactivate all profiles (restore to "no profile"):
```javascript
await context.executeSlashCommandsWithOptions('/profile None');
```

### Why `/profile` Instead of Direct Setting Manipulation

The `/profile` command handles all the internal state updates Connection Manager needs — API reconnection, UI indicator updates, etc. Directly writing to `extensionSettings.connectionManager.selectedProfile` would leave the connection in an inconsistent state.

---

## Design Decisions

### Default Profile Threshold (Swipes Before Rotation)

The user can configure how many swipes to attempt on the current (default) profile before the extension starts cycling to alternatives. This is stored as `defaultSwipeThreshold` (integer, minimum 0, default 0).

**Why this exists:** Sometimes the same model produces a great response on the second or third try — different sampling, different token choices. The user may want to give their preferred model a few chances before pulling in a completely different model. A threshold of 0 means rotation starts on the very first swipe. A threshold of 3 means the first 3 swipes use the default profile normally, and swipe 4+ cycle through the rotation list.

**How it works:** A counter (`defaultSwipesUsed`) tracks how many swipe generations have fired on the current message since the last non-swipe generation or chat change. Each `GENERATION_STARTED` with `type === 'swipe'` increments this counter. If the counter is still within the threshold, the handler returns early without switching. Once the counter exceeds the threshold, rotation begins.

**When the counter resets:** On `CHAT_CHANGED` (new chat context), on `GENERATION_STARTED` with `type !== 'swipe'` (user sent a new message or regenerated), and on any detected manual connection context change (profile/source/model/preset/API). This means the threshold applies per-message and per-connection-baseline: each time the conversation advances or the user changes connection context, swipe counting starts fresh.

### Excluding the Active Profile from Rotation

The first response (and all threshold swipes) were generated by whatever profile is currently active. When rotation kicks in, the user wants something *different*. Including the active profile in the rotation means some rotated swipes would produce results from the same model — defeating the purpose. So the rotation list is filtered to exclude the currently active profile at switch time.

### Cycling (Not Random)

Cycling guarantees the user sees every selected profile before any repeats. Random selection could repeat the same profile multiple times in a row, which wastes swipes.

### Resetting Rotation Index on Chat Change

When the user switches to a different chat, the rotation resets to index 0. This keeps behavior predictable — the first swipe in any chat always starts with the first profile in the list.

### Auto-Restore After Each Swipe

After the swipe response completes, the original profile is restored. This means:
- The user's default profile stays active for normal sends
- Each swipe is a temporary deviation, not a permanent profile change
- The UI profile indicator returns to normal after the swipe

Without restoration, the user would end up on whatever profile was used for the last swipe, which is confusing and changes their default generation behavior.

### No Conflict with Other Profile-Switching Extensions

Chat Manager's `ai-features.js` uses a `withAIProfile()` wrapper that does local save/restore for quiet prompt generation (titles, summaries). If `withAIProfile()` runs during an active swipe rotation:

1. Swipe rotation switches A → B
2. `withAIProfile()` saves current (B), switches to C, runs its quiet prompt, restores B
3. Swipe completes, rotation restores A

Each layer does its own save/restore, so they compose correctly. The key is that `withAIProfile()` saves whatever profile is active *at the time it runs*, not a hardcoded value.

---

## Implementation Outline

### Event Registration

```javascript
const context = SillyTavern.getContext();
const eventTypes = context.eventTypes || context.event_types;
const { eventSource } = context;

// Core generation lifecycle events:
eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);

// Chat reset:
eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);

// Connection-context change signals:
for (const key of [
    'CONNECTION_PROFILE_LOADED',
    'MAIN_API_CHANGED',
    'CHATCOMPLETION_SOURCE_CHANGED',
    'CHATCOMPLETION_MODEL_CHANGED',
    'PRESET_CHANGED',
    'OAI_PRESET_CHANGED_AFTER',
    'SETTINGS_UPDATED',
]) {
    if (eventTypes[key]) eventSource.on(eventTypes[key], () => syncConnectionContext(`event:${key}`));
}
```

### Core State

```javascript
let rotationIndex = 0;           // Position in the cycle
let swipeRotationActive = false;  // Whether a rotation switch is currently in effect
let profileBeforeSwipe = null;    // Profile ID to restore after generation
let defaultSwipesUsed = 0;       // How many swipes have fired on the default profile for the current message
let expectedProfileId = null;     // Last known selected profile baseline
let connectionSignature = null;   // Fingerprint of connection context
```

### `GENERATION_STARTED` Handler

```javascript
async function onGenerationStarted(type, _params, _dryRun) {
    // Reset swipe counter when a non-swipe generation fires (new message, regenerate, etc.)
    if (type !== 'swipe') {
        defaultSwipesUsed = 0;
        return;
    }

    if (!isEnabled()) return;

    // Increment the per-message swipe counter
    defaultSwipesUsed++;

    // Let the default profile handle swipes until the threshold is exceeded.
    // defaultSwipeThreshold of 0 means rotate immediately on the first swipe.
    // defaultSwipeThreshold of 3 means swipes 1-3 use the default, swipe 4+ rotates.
    const threshold = getDefaultSwipeThreshold(); // From your settings, integer >= 0
    if (defaultSwipesUsed <= threshold) return;

    const context = SillyTavern.getContext();
    const cmProfiles = context.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(cmProfiles) || cmProfiles.length === 0) return;

    const currentProfileId = context.extensionSettings?.connectionManager?.selectedProfile;
    const selectedIds = getConfiguredProfileIds(); // From your settings

    // Filter to only configured profiles, excluding the currently active one
    const candidates = cmProfiles.filter(p =>
        selectedIds.includes(p.id) && p.id !== currentProfileId
    );
    if (candidates.length === 0) return;

    // Pick next in cycle
    const target = candidates[rotationIndex % candidates.length];
    rotationIndex = (rotationIndex + 1) % candidates.length;

    // Save current profile for restoration
    profileBeforeSwipe = currentProfileId;

    // Switch — this completes before Generate() continues because the emit is awaited
    try {
        await context.executeSlashCommandsWithOptions(`/profile ${target.name}`);
        swipeRotationActive = true;
    } catch (err) {
        console.warn('Swipe rotation: failed to switch profile', err);
        profileBeforeSwipe = null;
    }
}
```

### Restoration Handlers

```javascript
async function restoreProfile() {
    if (!swipeRotationActive) return;
    swipeRotationActive = false;

    const context = SillyTavern.getContext();
    const cmProfiles = context.extensionSettings?.connectionManager?.profiles;
    const original = cmProfiles?.find(p => p.id === profileBeforeSwipe);

    try {
        const restoreName = original ? original.name : 'None';
        await context.executeSlashCommandsWithOptions(`/profile ${restoreName}`);
    } catch (err) {
        console.warn('Swipe rotation: failed to restore profile', err);
    }
    profileBeforeSwipe = null;
}

async function onMessageReceived() {
    await restoreProfile();
}

async function onGenerationStopped() {
    await restoreProfile();
}

function onChatChanged() {
    rotationIndex = 0;
    defaultSwipesUsed = 0;
    // If a swipe was in progress when chat changed, clean up
    swipeRotationActive = false;
    profileBeforeSwipe = null;
}
```

### Settings Persistence

Use `extensionSettings[YOUR_MODULE_NAME]` for persistence:

```javascript
// In your ensureSettings():
if (!settings.swipeRotation) {
    settings.swipeRotation = { enabled: false, profileIds: [], defaultSwipeThreshold: 0 };
}
```

- `defaultSwipeThreshold` — Number of swipes to let through on the default profile before rotation kicks in. `0` = rotate immediately on first swipe. Stored as integer >= 0.

### Settings UI

A checkbox toggle + a number input for the default swipe threshold + a dynamically populated checklist of Connection Manager profiles.

The threshold input is a number field (min 0, no hard max) labeled something like "Swipes before rotating" with a description explaining that this many swipes will use the current profile before the extension starts cycling. A value of 0 means rotation starts on the very first swipe.

Populate the checklist from `context.extensionSettings?.connectionManager?.profiles`, sorted alphabetically by name. Refresh the list when Connection Manager profile catalog events fire:

```javascript
for (const evtName of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
    if (eventTypes[evtName]) {
        eventSource.on(eventTypes[evtName], refreshProfileChecklist);
    }
}
```

Additionally, listen for `CONNECTION_PROFILE_LOADED` and other connection-related events to recompute a connection signature. If the signature changes, reset swipe counters and cancel any in-flight rotation state so manual changes between swipes are respected.

Use SillyTavern theme variables for all styling (`var(--SmartThemeBodyColor)`, etc.).

---

## SillyTavern Extension API Reference (Used by This Feature)

```javascript
const context = SillyTavern.getContext();

// Event bus
context.eventSource.on(eventTypes.SOME_EVENT, handler);
context.eventSource.removeListener(eventTypes.SOME_EVENT, handler);

// Settings persistence
context.extensionSettings[MODULE_NAME]          // Your settings object
context.saveSettingsDebounced()                  // Persist after changes

// Connection Manager data
context.extensionSettings?.connectionManager?.profiles         // Array<{id, name, ...}>
context.extensionSettings?.connectionManager?.selectedProfile  // Active profile ID

// Profile switching
context.executeSlashCommandsWithOptions('/profile ProfileName')  // Switch profile
context.executeSlashCommandsWithOptions('/profile None')         // Deactivate profile

// HTML sanitization (for any dynamic UI)
SillyTavern.libs.DOMPurify.sanitize(html)
```

---

## Edge Cases to Handle

| Scenario | Behavior |
|----------|----------|
| No Connection Manager profiles exist | Feature disabled, UI shows empty state |
| All selected profiles deleted | Rotation no-ops, swipe uses current profile as normal |
| Only 1 profile selected (and it's the active one) | Excluded by filter → no candidates → no-op |
| User stops generation mid-stream | `GENERATION_STOPPED` handler restores profile |
| Profile switch fails (network error, etc.) | Catch error, leave current profile active, don't set `swipeRotationActive` |
| `type === 'quiet'` generation | Ignored — only `type === 'swipe'` triggers rotation |
| `type === 'regenerate'` | Ignored — regenerate replaces the current message, not a swipe. Also resets `defaultSwipesUsed` to 0 since it's a non-swipe generation |
| Threshold set to 0 | Rotation starts on the very first swipe — no default-profile grace period |
| Threshold set to 3 | Swipes 1-3 proceed normally on the default profile; swipe 4+ cycle through the rotation list |
| User sends a new message | `defaultSwipesUsed` resets to 0 because `GENERATION_STARTED` fires with a non-swipe type, so the threshold applies fresh to the new AI response |
| User manually changes profile/model/source/preset/API between swipes | Connection signature changes; reset `defaultSwipesUsed`, cancel active rotation state, and use the new baseline |
