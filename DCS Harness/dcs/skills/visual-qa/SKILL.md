---
name: visual-qa
description: Generic visual QA on the iOS simulator and Android emulator following the dcs reference-diff protocol, using Maestro captures when configured and agent-device otherwise. Use when a repo's dcs settings set visualQa to the dcs:visual-qa skill, or when Navin asks for visual QA in a repo without its own QA agent.
---

# /dcs:visual-qa

This runs in the Captain's session. Follow the **Visual QA** template in `${CLAUDE_PLUGIN_ROOT}/references/captain.md`: steps 0–8 and the reply shape. This file adds the platform mechanics.

## Captures
- **With Maestro captures**, which the Captain passes in: use them as they are. Recapture only through the Captain's Maestro flow.
- **Without Maestro:**
  - Resolve the binary with `which agent-device 2>/dev/null || echo "use npx"`. If it isn't installed, use `npx agent-device@0.17.6` for every command, and never `@latest`.
  - Read `agent-device help workflow` and `agent-device help react-native` once per session.
  - iOS:
    - Find the bundle id with `agent-device apps --platform ios`. If you're unsure which app it is, ask Navin.
    - Open it with `agent-device open <bundle-id> --platform ios`.
  - Android: use the same commands with `--platform android`.
  - Navigate with `agent-device snapshot -i` → `agent-device tap @eN` → `agent-device diff snapshot -i`. Refs change after each navigation, so re-snapshot first.
  - Capture with `agent-device screenshot <folder>/<screen>_<state>.png`.
  - Finish with `agent-device close`. Keep to one session, run serially.
- Metro must be running and the app built. If not, stop and tell Navin. Never start Metro, simulators or emulators yourself unless Navin asks.

## Device prep (template step 0)
Record the current values first, and restore them afterwards.
- **iOS:**
  - `xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 --dataNetwork wifi`
  - `xcrun simctl ui booted appearance <light|dark>`
  - `xcrun simctl ui booted content_size large`
  - Afterwards: `xcrun simctl status_bar booted clear`
- **Android:**
  - `adb shell settings put global sysui_demo_allowed 1`, then `adb shell am broadcast -a com.android.systemui.demo -e command enter`, then the clock broadcast with `-e command clock -e hhmm 0941`.
  - `adb shell cmd uimode night <yes|no>` and `adb shell settings put system font_scale 1.0`.
  - Animations: `adb shell settings put global window_animation_scale 0`, and the same for `transition_animation_scale` and `animator_duration_scale`. Read the previous values with `settings get` first.
  - Afterwards: `adb shell am broadcast -a com.android.systemui.demo -e command exit`, then restore the recorded values.

## Report
Reply with exactly the JSON shape in the template.
