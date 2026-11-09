<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `direct-messenger` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Direct Messenger

Encrypted one-to-one messages through the runtime DM service. The app is tracked
in this repo at `napplets/direct-messenger`; the standalone repository is a
generated, read-only mirror.

It lists your conversations from `dm.conversations` and lets you start one from
an npub, nprofile or hex key. Sending still follows the runtime's rules: the other
person has to follow you back, and you both have to be online. Accounts that can't
encrypt, such as read-only sessions, see what's needed and a way to check again.

`napplet:dm/open` arrives through the injected `intent.onDelivery` API. The app
subscribes after DM status initialization; the published binding buffers earlier
deliveries. Closing the app while status is pending prevents late subscriptions.
Names and avatars come from `common.getProfile`, with the npub as the fallback.
Clicking a name invokes `napplet:profile/open`. Group conversations aren't listed
yet, because the app can only open one peer at a time.

```bash
pnpm --filter ./napplets/direct-messenger test
pnpm --filter ./napplets/direct-messenger type-check
pnpm --filter ./napplets/direct-messenger build
```

The shell target-controller migration is still in progress; see
[package migration status](../../docs/napplet-package-migration.md).
