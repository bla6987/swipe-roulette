# Swipe Roulette

A standalone SillyTavern extension that rotates Connection Manager profiles on swipe generation, then restores your previous profile after the swipe completes.

## Features

- Rotates profiles only for `type === 'swipe'` generations
- Restores original profile on completion (`MESSAGE_RECEIVED`) or abort (`GENERATION_STOPPED`)
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
- Profile checklist: select the Connection Manager profiles to cycle through.

## Notes

- The active profile at swipe time is excluded from rotation candidates.
- If the original profile no longer exists when restoring, it restores to `"<None>"`.
- If profile switching fails, the extension logs a warning and leaves current profile unchanged.
- Manual connection changes between swipes reset the threshold counter and cancel any in-flight swipe rotation state.

## Debug

In browser console:

```js
SillyTavern.getContext().extensionSettings.swipe_roulette.debug = true;
```

Logs are prefixed with `[swipe_roulette]`.
