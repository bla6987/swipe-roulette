# Swipe Roulette

A standalone SillyTavern extension that applies weighted Connection Manager profile selection for swipe generations and optionally for normal user-message generations.

## Features

- Weighted profile selection for `type === 'swipe'` generations
- Optional weighted profile selection for `type === 'normal'` user-message generations
- Optional overall chance gate for swipe rotation (`0-100%`)
- Optional model/config-change-only mode for the overall chance gate
- Swipe path restores original profile and model/provider context on completion (`MESSAGE_RECEIVED`) or abort (`GENERATION_STOPPED`)
- Optional normal-message restore mode: keep selected profile active or restore previous profile
- Configurable threshold (`Swipes before rotating`)
- Detects manual connection context changes (profile/source/model/preset/API) and resets swipe counter baseline
- Profile checklist sourced from Connection Manager and refreshed on profile lifecycle changes
- Safe no-op behavior when no valid rotation candidates exist

## Install

### Per-user install

Copy or symlink this folder to:

```text
data/<user-handle>/extensions/third-party/swipe_roulette/
```

### Global install

Copy or symlink this folder to:

```text
public/scripts/extensions/third-party/swipe_roulette/
```

Then enable **Swipe Roulette** in **Extensions > Manage Extensions**.

## Settings

Open the **Extensions** drawer and find **Swipe Roulette** in the settings panel.

- `Enable profile rotation on swipe generation`: Turns the feature on/off.
- `Swipes before rotating`: Number of swipe generations to keep on current profile before rotation starts.
  - `0`: rotate on first swipe generation.
  - `3`: swipes 1-3 stay on current profile, swipe 4 starts rotation.
- `Enable overall chance gate for swipe rotation`: Adds a random chance check before swipe rotation runs.
- `Overall chance (%)`: Chance that swipe rotation runs when an eligible swipe occurs.
  - `100`: always allow rotation.
  - `0`: never allow rotation.
- `Apply only when model/config changes`: Only re-runs the overall chance roll after connection signature changes (profile/source/model/preset/API).
- `Enable weighted routing for user messages`: Enables weighted selection for `type === 'normal'` sends.
- `After user-message response`: Choose whether to keep the selected profile active or restore the previous profile.
- Profile checklist: select the Connection Manager profiles to include in weighted draws.
- Weight sliders: higher weight means higher selection chance. Shared across swipes, normal-message routing, and Spin.

## Notes

- User-message routing is disabled by default for backward compatibility.
- The overall chance gate applies only to swipe rotation, not normal user-message routing.
- The overall chance gate is evaluated after the swipe threshold is passed.
- The active profile is included in weighted candidates if it is selected in the checklist, so a draw may keep the current profile.
- Swipe and normal restore mode (`restore`) both attempt to restore profile plus provider/model/preset/URL context.
- If the original profile no longer exists when restoring, it restores to `"<None>"`.
- If the original model/provider context cannot be fully restored, the extension keeps the current context and logs a warning.
- If profile switching fails, the extension logs a warning and leaves current profile unchanged.
- Manual connection changes reset the swipe threshold counter and cancel any in-flight temporary restore state.

## Debug

In browser console:

```js
SillyTavern.getContext().extensionSettings.swipe_roulette.debug = true;
```

Logs are prefixed with `[swipe_roulette]`.
