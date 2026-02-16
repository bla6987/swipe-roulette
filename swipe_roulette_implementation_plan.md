# Swipe Roulette Weighted Random + Quick Spin Implementation Plan

## Summary

This plan extends the existing `swipe_roulette` extension in `/workspace/swipe_roulette` to match the feature set previously associated with SwipeModelRoulette while preserving the current stable behavior:

- Swipe-only profile switching
- Reliable pre-switch timing before generation
- Automatic restore after swipe generation
- Threshold-based delayed rotation (`Swipes before rotating`)

New work in this plan adds:

- Weighted random profile selection for automatic swipe rotation
- Per-profile weight configuration in extension UI
- Quick manual "Spin" button that switches immediately and persists

The implementation is designed to be backward-compatible with existing settings and safe when Connection Manager profiles are missing, renamed, or deleted.

## Goals

1. Preserve current extension reliability and lifecycle behavior.
2. Replace deterministic round-robin auto selection with pure weighted random.
3. Add manual spin UX for instant profile changes.
4. Keep implementation fully local to `swipe_roulette` without touching core SillyTavern files.

## Non-Goals

1. No core SillyTavern API changes.
2. No new slash commands in this iteration.
3. No telemetry or analytics additions.
4. No profile presets import/export feature for weights yet.

## Current Baseline (Confirmed)

Current extension already implements:

- `GENERATION_STARTED` swipe interception
- active profile capture and temporary switch
- restore on `MESSAGE_RECEIVED` and `GENERATION_STOPPED`
- threshold logic via `defaultSwipeThreshold`
- profile checklist synced with Connection Manager events

Current auto selection strategy is deterministic sorted round-robin with `rotationIndex`.

## Target Behavior

### Automatic swipe rotation

- Applies only on generation type `swipe`.
- Honors `Swipes before rotating` threshold exactly as now.
- After threshold is exceeded, selects from user-enabled profiles by weighted random.
- Excludes currently active profile from auto candidates to ensure variation.
- Temporarily switches before generation request is built/sent.
- Restores original profile after swipe completion or stop.

### Manual quick spin

- "Spin" button in extension settings card.
- Draws a weighted random profile from enabled profiles.
- Switches immediately via `/profile`.
- Result persists (manual spin is not auto-restored).
- Stores last spun profile for UI feedback.

## Settings and Data Model Changes

File: `swipe_roulette/index.js`

Extend `extensionSettings.swipe_roulette` with:

- `mode: 'weighted_random'`
- `profileWeights: Record<string, number>`
- `spinLastProfileId: string | null`

Keep existing fields:

- `enabled: boolean`
- `profileIds: string[]`
- `defaultSwipeThreshold: number`
- `debug: boolean`

### Validation and normalization rules

1. `mode` defaults to `'weighted_random'`.
2. `profileWeights[id]` defaults to `1` when missing/invalid.
3. Coerce weights to integer in range `1..999`.
4. Remove weight entries for deleted profiles during pruning.
5. Preserve unknown future keys to avoid migration churn.

## Detailed Implementation Steps

### 1) Settings bootstrap and migration

Files:

- `swipe_roulette/index.js`

Changes:

1. Update `ensureSettings()` to initialize new fields.
2. Add helper `normalizeWeight(value)` for coercion/clamp.
3. Add helper `getWeightForProfileId(id)` returning normalized value.
4. Extend `pruneStaleProfileSelections()` to prune `profileWeights` keys too.

Acceptance:

- Existing installs with old schema run without errors.
- New keys appear lazily in settings after load.

### 2) Replace round-robin with weighted random

Files:

- `swipe_roulette/index.js`

Changes:

1. Remove dependency on `rotationIndex` for automatic candidate pick.
2. Keep candidate filtering behavior:
   - selected by `settings.profileIds`
   - existing in Connection Manager
   - exclude current active profile for auto-swipes
3. Build weighted pool from `(profile, weight)` pairs.
4. Draw via cumulative random:
   - `total = sum(weights)`
   - `r = Math.random() * total`
   - first cumulative bucket above `r` wins
5. Keep threshold gate unchanged:
   - increment `defaultSwipesUsed` only for `type === 'swipe'`
   - rotate only when `defaultSwipesUsed > threshold`

Acceptance:

- Automatic rotations are random with weighted bias.
- No deterministic cycle ordering remains.

### 3) Preserve reliable pre-switch + restore lifecycle

Files:

- `swipe_roulette/index.js`

Changes:

1. Keep switch in awaited `onGenerationStarted(...)`.
2. Keep stale recovery logic before non-quiet generations.
3. Keep restore triggers:
   - `onMessageReceived(..., type)` for `type === 'swipe'`
   - `onGenerationStopped()`
   - `onGenerationEnded()` as defensive cleanup (retain existing safeguard)
4. Keep chat reset behavior:
   - clear temporary rotation state on `CHAT_CHANGED`
   - reset threshold counters on chat switch

Acceptance:

- Swipe runs always use intended selected profile when switch succeeds.
- Original profile reliably restored after auto swipe path.

### 4) Add manual "Spin" action

Files:

- `swipe_roulette/index.js`
- `swipe_roulette/style.css`

Changes:

1. Add UI controls:
   - button `#swipe_roulette_spin`
   - status text `#swipe_roulette_spin_result`
2. Add `spinNow()` handler:
   - gather enabled profiles (do not exclude active profile for manual mode)
   - weighted random draw using same weight utility
   - call `switchProfileByName(target.name)`
   - on success, set `spinLastProfileId = target.id`, save settings, refresh status text
3. Do not set `swipeRotationActive` for manual spin path (no restore contract).
4. Disable button when no valid candidate profiles exist.
5. Add in-flight guard to prevent double-click races.

Acceptance:

- Clicking Spin changes active profile immediately.
- Profile remains active until user or other logic changes it.

### 5) Extend checklist rows with per-profile weight input

Files:

- `swipe_roulette/index.js`
- `swipe_roulette/style.css`

Changes:

1. In `renderProfilesChecklist(...)`, each profile row gets:
   - existing enable checkbox
   - profile label
   - numeric input for weight
2. Weight input behavior:
   - `min=1`, `max=999`, `step=1`
   - on input/change: normalize, persist to `profileWeights`, `saveSettingsDebounced()`
3. Preserve accessibility:
   - labels for weight fields
   - concise helper text

Acceptance:

- Weight edits persist and survive reload.
- Stale profile weights disappear when profile is deleted.

### 6) UI copy and state messaging

Files:

- `swipe_roulette/index.js`

Changes:

1. Update help text to explain weight semantics:
   - "Higher weight = higher chance."
2. Add state text variants:
   - no profiles available
   - no selected profiles
   - spin result and active status

Acceptance:

- User can understand setup without README.

### 7) Documentation refresh

Files:

- `swipe_roulette/README.md`

Changes:

1. Add weighted random section.
2. Add spin semantics:
   - immediate switch
   - persistent effect
3. Clarify auto-swipe restore still applies only to automatic swipe switches.
4. Update settings section with per-profile weight.

Acceptance:

- README accurately reflects implemented behavior and edge cases.

## Failure Modes and Handling

1. `executeSlashCommandsWithOptions` unavailable:
   - keep current profile unchanged
   - warn in console with extension prefix
2. `/profile` switch command fails:
   - auto path: clear temporary rotation state for that run
   - manual path: leave previous profile active, show warning status
3. No candidates:
   - auto path no-op
   - manual path button disabled + explanatory text
4. Deleted original profile before restore:
   - keep existing fallback restore to `'<None>'`

## Testing Plan

### Functional scenarios

1. **Migration**
   - Start with old settings object, load extension, verify defaults created.
2. **Weighted auto draw**
   - Profiles A/B/C with weights 1/1/8, run many swipes, observe C dominates.
3. **Threshold**
   - Threshold `3`, verify first 3 swipes do not rotate; 4th does.
4. **Swipe-only guard**
   - Send/regenerate path should not rotate profile.
5. **Auto restore on completion**
   - Confirm profile returns to pre-swipe profile after normal completion.
6. **Auto restore on abort**
   - Stop generation mid-swipe, confirm restoration.
7. **Manual spin persist**
   - Spin to profile X, verify profile stays X afterward.
8. **Profile deletion pruning**
   - Delete selected profile in Connection Manager, verify selection and weight cleanup.
9. **No selected profiles**
   - Auto no-op and spin disabled without errors.

### Regression checks

1. Debug logging still controlled by `settings.debug`.
2. UI renders correctly when extension panel opens before Connection Manager data is populated.
3. Chat change resets temporary rotation state and counters safely.

## File-Level Change List

1. `swipe_roulette/index.js`
   - settings schema, weighted selection, spin logic, UI rendering/events, pruning updates.
2. `swipe_roulette/style.css`
   - row layout updates for weight input and spin controls.
3. `swipe_roulette/README.md`
   - behavior and settings documentation.

## Rollout Strategy

1. Implement in local extension folder first (`/workspace/swipe_roulette`).
2. Smoke test against local SillyTavern dev instance with Connection Manager profiles.
3. If stable, copy/symlink into third-party extensions path for production use.

## Implementation Notes

1. Keep all switching through `/profile` slash command to preserve Connection Manager invariants.
2. Avoid direct writes to `connectionManager.selectedProfile`.
3. Keep logic defensive against event ordering and missing context during startup.
4. Prefer small pure helpers for candidate filtering and weighted draw to simplify future unit tests.
