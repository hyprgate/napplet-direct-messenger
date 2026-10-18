<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `direct-messenger` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Direct Messenger

The Hyprgate workspace owns this app at `napplets/direct-messenger`.
It uses the runtime DM service for conversation history, subscriptions and sending.

`napplet:dm/open` arrives through the injected `intent.onDelivery` API. The app
subscribes after DM status initialization; the published binding buffers earlier
deliveries. Closing the app while status is pending prevents late subscriptions.
Profile navigation invokes `napplet:profile/open` through the public URI API.

From the existing workspace:

```bash
pnpm --filter ./napplets/direct-messenger test
pnpm --filter ./napplets/direct-messenger type-check
pnpm --filter ./napplets/direct-messenger build
```

The shell target-controller migration is still in progress; see
[package migration status](../../docs/napplet-package-migration.md).
