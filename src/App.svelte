<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { common, dm, intent, type CommonProfileData, type DmMessage, type Subscription } from '@napplet/sdk';
  import {
    AIM_RUNNING_MAN_FILL_PATH,
    AIM_RUNNING_MAN_OUTLINE_PATH,
    AIM_RUNNING_MAN_VIEW_BOX,
  } from '@hyprgate/utils';

  interface OpenPayload {
    pubkey: string;
  }

  let ownerPubkey = $state('');
  let peerPubkey = $state('');
  let peerProfile = $state<CommonProfileData | null>(null);
  let messages = $state<DmMessage[]>([]);
  let draft = $state('');
  let error = $state('');
  let loading = $state(true);
  let sending = $state(false);
  let available = $state(false);
  let subscriptionId = $state('');
  let transcriptElement = $state<HTMLElement | null>(null);
  let conversationRevision = 0;

  const conversationId = $derived(
    ownerPubkey && peerPubkey ? `direct:${[ownerPubkey, peerPubkey].sort().join(',')}` : '',
  );
  const peerLabel = $derived(
    peerProfile?.displayName
      ?? (typeof peerProfile?.display_name === 'string' ? peerProfile.display_name : undefined)
      ?? peerProfile?.name
      ?? shortPubkey(peerPubkey),
  );

  function shortPubkey(pubkey: string): string {
    return pubkey.length > 18 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}` : pubkey;
  }

  function isDmMessage(value: unknown): value is DmMessage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Partial<DmMessage>;
    return typeof message.id === 'string'
      && message.id.length > 0
      && typeof message.conversationId === 'string'
      && typeof message.senderPubkey === 'string'
      && typeof message.createdAt === 'number'
      && Number.isFinite(message.createdAt)
      && typeof message.content === 'string'
      && ['sent', 'delivered', 'received', 'failed'].includes(message.status ?? '');
  }

  function parseOpenPayload(payload: unknown): OpenPayload | null {
    if (!payload || typeof payload !== 'object') return null;
    const pubkey = (payload as { pubkey?: unknown }).pubkey;
    return typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey) ? { pubkey } : null;
  }

  async function scrollToLatest(): Promise<void> {
    await tick();
    transcriptElement?.scrollTo({ top: transcriptElement.scrollHeight });
  }

  function mergeMessage(message: unknown): void {
    if (!isDmMessage(message)) return;
    const existing = messages.findIndex((entry) => entry.id === message.id);
    if (existing >= 0) messages[existing] = message;
    else messages = [...messages, message].sort((a, b) => a.createdAt - b.createdAt);
    void scrollToLatest();
  }

  function mergeMessages(incoming: unknown[]): void {
    const byId = new Map(messages.map((message) => [message.id, message]));
    for (const message of incoming) {
      if (isDmMessage(message)) byId.set(message.id, message);
    }
    messages = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    void scrollToLatest();
  }

  async function openConversation(pubkey: string): Promise<void> {
    const revision = ++conversationRevision;
    if (subscriptionId) {
      await dm.unsubscribe(subscriptionId).catch(() => ({ ok: false }));
      if (revision !== conversationRevision) return;
      subscriptionId = '';
    }
    peerPubkey = pubkey;
    peerProfile = null;
    messages = [];
    error = '';
    loading = true;
    try {
      const openedConversationId = conversationId;
      const subscriptionPromise = dm.subscribe({ conversationId: openedConversationId });
      const profilePromise = common.getProfile(pubkey);
      const historyPromise = dm.messages({ conversationId: openedConversationId, limit: 200 });
      void profilePromise.then((profileResult) => {
        if (revision === conversationRevision) peerProfile = profileResult.profile ?? null;
      }).catch(() => { /* profile hydration is opportunistic */ });
      void historyPromise.then((history) => {
        if (revision === conversationRevision) mergeMessages(history.messages);
      }).catch((cause) => {
        if (revision === conversationRevision) {
          error = cause instanceof Error ? cause.message : 'Could not load message history';
        }
      });

      const subscription = await subscriptionPromise;
      if (revision !== conversationRevision) {
        await dm.unsubscribe(subscription.subscriptionId).catch(() => ({ ok: false }));
        return;
      }
      subscriptionId = subscription.subscriptionId;
      loading = false;
    } catch (cause) {
      if (revision === conversationRevision) {
        error = cause instanceof Error ? cause.message : 'Could not open this conversation';
      }
    } finally {
      if (revision === conversationRevision && !subscriptionId) loading = false;
    }
  }

  async function send(): Promise<void> {
    const content = draft.trim();
    if (!content || !peerPubkey || !conversationId || sending || !available) return;
    sending = true;
    error = '';
    try {
      const result = await dm.send({
        conversationId,
        recipients: [peerPubkey],
        content,
        clientMessageId: crypto.randomUUID(),
      });
      if (!isDmMessage(result.message)) throw new Error('Message send returned no valid receipt');
      mergeMessage(result.message);
      draft = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Message was not sent';
    } finally {
      sending = false;
    }
  }

  async function openProfile(): Promise<void> {
    if (!peerPubkey) return;
    await intent.invoke('napplet:profile/open', { payload: { pubkey: peerPubkey }, behavior: { focus: true, reuse: true } });
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  }

  onMount(() => {
    let disposed = false;
    let openSubscription: Subscription | null = null;
    let messageSubscription: Subscription | null = null;
    void (async () => {
      try {
        const status = await dm.status();
        if (disposed) return;
        available = status.available;
        ownerPubkey = status.ownerPubkey ?? '';
        openSubscription = intent.onDelivery((event) => {
          if (event.archetype !== 'dm' || event.action !== 'open' || event.convention !== 'napplet:dm/open') return;
          const payload = parseOpenPayload(event.payload);
          if (payload) void openConversation(payload.pubkey);
        });
        messageSubscription = dm.onMessage((message, liveSubscriptionId) => {
          if (!isDmMessage(message)) return;
          if (liveSubscriptionId !== subscriptionId || message.conversationId !== conversationId) return;
          mergeMessage(message);
          // Reading an actively displayed conversation clears the runtime-owned
          // unread count that drives the shell header badge.
          void dm.messages({ conversationId, limit: 1 }).catch(() => ({ messages: [] }));
        });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Direct messaging is unavailable';
        loading = false;
      }
    })();
    return () => {
      disposed = true;
      openSubscription?.close();
      messageSubscription?.close();
      if (subscriptionId) void dm.unsubscribe(subscriptionId);
    };
  });
</script>

<main class="aim-window" data-testid="dm-window">
  <header class="aim-titlebar">
    <svg class="running-man" viewBox={AIM_RUNNING_MAN_VIEW_BOX} aria-hidden="true">
      <path class="aim-logo-outline" d={AIM_RUNNING_MAN_OUTLINE_PATH}></path>
      <path class="aim-logo-fill" d={AIM_RUNNING_MAN_FILL_PATH}></path>
    </svg>
    <div>
      <strong>
        {#if peerPubkey}
          <button
            class="peer-profile-link"
            type="button"
            onclick={() => { void openProfile(); }}
            title={`View ${peerLabel} profile`}
            data-testid="dm-open-profile"
          >{peerLabel}</button><span> — Instant Message</span>
        {:else}
          Instant Message
        {/if}
      </strong>
      <small>{available ? 'Double Ratchet connected' : 'Messenger offline'}</small>
    </div>
  </header>

  <nav aria-label="Messenger actions">
    <button type="button" disabled>Talk</button>
    <button type="button" disabled>Games</button>
  </nav>

  {#if error}
    <p class="notice" role="alert" data-testid="dm-error">{error}</p>
  {/if}

  <section class="conversation">
    <div class="transcript" bind:this={transcriptElement} data-testid="dm-transcript" aria-live="polite">
      {#if !peerPubkey}
        <p class="empty">Choose a friend from your Buddy List to begin.</p>
      {:else if loading}
        <p class="empty">Opening conversation…</p>
      {:else if messages.length === 0}
        <p class="empty">No messages yet. Say hello when both of you are online.</p>
      {/if}
      {#each messages as message (message.id)}
        <p class:mine={message.senderPubkey === ownerPubkey}>
          <strong>{message.senderPubkey === ownerPubkey ? 'You' : peerLabel}:</strong>
          <span>{message.content}</span>
        </p>
      {/each}
    </div>

    <div class="formatting" aria-hidden="true">
      <b>B</b><i>I</i><u>U</u><span>☺</span>
    </div>

    <textarea
      bind:value={draft}
      aria-label="Message"
      placeholder={peerPubkey ? 'Type your message here…' : 'Open a friend first'}
      disabled={!peerPubkey || !available}
      onkeydown={handleComposerKeydown}
      data-testid="dm-input"
    ></textarea>
    <footer>
      <span>Messages are end-to-end encrypted.</span>
      <button
        class="send"
        type="button"
        disabled={!draft.trim() || !peerPubkey || !available || sending}
        onclick={() => { void send(); }}
        data-testid="dm-send"
      >{sending ? 'Sending…' : 'Send'}</button>
    </footer>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    min-width: 300px;
    background: var(--hg-bg-base);
    color: var(--hg-text-primary);
    font: 12px/1.35 var(--hg-font-body);
  }

  button, textarea { font: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }

  .aim-window {
    --aim-theme-background: var(--hg-theme-background, var(--hg-bg-base));
    --aim-theme-text: var(--hg-theme-text, var(--hg-text-primary));
    --aim-theme-primary: var(--hg-theme-primary, var(--hg-accent-primary));
    --aim-title-top: color-mix(in srgb, var(--aim-theme-primary) 46%, var(--aim-theme-background));
    --aim-title-bottom: color-mix(in srgb, var(--aim-theme-primary) 30%, var(--aim-theme-background));
    --aim-title-text: var(--aim-theme-text);
    --aim-title-shadow: color-mix(in srgb, var(--aim-theme-background) 72%, transparent);
    --aim-header-border: color-mix(in srgb, var(--aim-theme-primary) 56%, var(--aim-theme-background));
    --aim-control-top: color-mix(in srgb, var(--aim-theme-text) 18%, var(--aim-theme-background));
    --aim-control-bottom: color-mix(in srgb, var(--aim-theme-text) 10%, var(--aim-theme-background));
    min-height: 100vh;
    box-sizing: border-box;
    padding: 5px;
    background: var(--hg-bg-base);
  }

  .aim-titlebar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    color: var(--aim-title-text);
    background: linear-gradient(var(--aim-title-top), var(--aim-title-bottom));
    border: 1px solid var(--aim-header-border);
    border-radius: 5px 5px 0 0;
    text-shadow: 0 1px var(--aim-title-shadow);
  }

  .aim-titlebar div:last-child { display: grid; }
  .aim-titlebar small { opacity: .85; font-size: 10px; }
  .peer-profile-link { margin: 0; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; font-weight: inherit; text-decoration: underline; text-underline-offset: 2px; }
  .peer-profile-link:hover, .peer-profile-link:focus-visible { color: var(--aim-theme-primary); outline: none; }
  .running-man { width: 27px; height: 27px; flex: 0 0 auto; }
  .running-man .aim-logo-outline { fill: var(--aim-theme-background); }
  .running-man .aim-logo-fill { fill: var(--aim-theme-primary); }

  nav {
    display: flex;
    gap: 3px;
    padding: 4px;
    border: 1px solid var(--hg-border-default);
    border-top: 0;
    background: var(--hg-bg-surface);
  }

  nav button, .send {
    min-width: 54px;
    padding: 3px 9px;
    border: 1px solid var(--hg-border-default);
    border-radius: 3px;
    color: var(--hg-text-primary);
    background: linear-gradient(var(--aim-control-top), var(--aim-control-bottom));
    box-shadow: inset 0 1px color-mix(in srgb, var(--hg-text-primary) 18%, transparent);
  }

  .notice {
    margin: 5px 0;
    padding: 5px 7px;
    color: var(--hg-accent-danger);
    border: 1px solid currentColor;
    background: color-mix(in srgb, var(--hg-accent-danger) 10%, var(--hg-bg-surface));
  }

  .conversation { display: grid; gap: 4px; margin-top: 5px; }
  .transcript, textarea {
    border: 1px solid var(--hg-border-default);
    background: var(--hg-bg-surface);
    color: var(--hg-text-primary);
    box-shadow: inset 1px 1px 2px color-mix(in srgb, var(--hg-bg-base) 36%, transparent);
  }
  .transcript { min-height: 220px; max-height: 55vh; overflow: auto; padding: 8px; }
  .transcript p { margin: 0 0 7px; }
  .transcript strong { color: color-mix(in srgb, var(--hg-accent-primary) 72%, var(--hg-text-primary)); margin-right: 4px; }
  .transcript p.mine strong { color: var(--hg-accent-primary); }
  .empty { color: var(--hg-text-muted); font-style: italic; }
  .formatting { display: flex; gap: 8px; padding: 3px 6px; border: 1px solid var(--hg-border-muted); background: var(--hg-bg-elevated); }
  textarea { min-height: 74px; resize: vertical; padding: 7px; }
  textarea::placeholder { color: var(--hg-text-dim); }
  footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  footer span { color: var(--hg-text-muted); font-size: 10px; }
  .send { min-width: 76px; font-weight: 700; }
</style>
