<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    common,
    dm,
    intent,
    type CommonProfileData,
    type DmConversation,
    type DmMessage,
    type Subscription,
  } from '@napplet/sdk';
  import {
    AIM_RUNNING_MAN_FILL_PATH,
    AIM_RUNNING_MAN_OUTLINE_PATH,
    AIM_RUNNING_MAN_VIEW_BOX,
    resourceImageBatch,
  } from '@hyprgate/utils';
  import { directPeer, formatMessageTime, personLabel, resolvePeerInput, shortKey, sortConversations } from './lib/people.js';

  interface OpenPayload {
    pubkey: string;
  }

  const CONVERSATION_REFRESH_DELAY_MS = 250;

  let ownerPubkey = $state('');
  let peerPubkey = $state('');
  let profiles = $state<Record<string, CommonProfileData | null>>({});
  let npubs = $state<Record<string, string>>({});
  let conversations = $state<DmConversation[]>([]);
  let conversationsLoaded = $state(false);
  let messages = $state<DmMessage[]>([]);
  let draft = $state('');
  let error = $state('');
  let loading = $state(false);
  let sending = $state(false);
  let statusResolved = $state(false);
  let available = $state(false);
  let subscriptionId = $state('');
  let inboxSubscriptionId = '';
  let newPeerInput = $state('');
  let newPeerError = $state('');
  let startingConversation = $state(false);
  let transcriptElement = $state<HTMLElement | null>(null);
  let composerElement = $state<HTMLTextAreaElement | null>(null);
  let newPeerElement = $state<HTMLInputElement | null>(null);
  let conversationRevision = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const requestedPeople = new Set<string>();
  const drafts = new Map<string, string>();

  const conversationId = $derived(
    ownerPubkey && peerPubkey ? `direct:${[ownerPubkey, peerPubkey].sort().join(',')}` : '',
  );
  const peerLabel = $derived(labelFor(peerPubkey));
  const peerPicture = $derived(pictureFor(peerPubkey));
  const peerHasName = $derived(peerLabel !== shortKey(npubs[peerPubkey] ?? peerPubkey));
  const directConversations = $derived(sortConversations(conversations).flatMap((conversation) => {
    const peer = directPeer(conversation, ownerPubkey);
    return peer ? [{ conversation, peer }] : [];
  }));
  const statusLine = $derived(
    !statusResolved ? 'Connecting…' : available ? 'End-to-end encrypted' : 'Not available on this account',
  );

  function labelFor(pubkey: string, runtimeLabel?: string): string {
    return personLabel(profiles[pubkey], pubkey, npubs[pubkey], runtimeLabel);
  }

  function pictureFor(pubkey: string, runtimeAvatar?: string): string | undefined {
    const picture = profiles[pubkey]?.picture;
    return typeof picture === 'string' && picture ? picture : runtimeAvatar;
  }

  /** Profile and npub lookups are opportunistic: the key stays usable without them. */
  function ensurePerson(pubkey: string): void {
    if (requestedPeople.has(pubkey)) return;
    requestedPeople.add(pubkey);
    void common.getProfile(pubkey)
      .then((result) => { profiles[pubkey] = result.profile ?? null; })
      .catch(() => { /* fall back to the npub */ });
    void common.encodeNip19({ type: 'npub', hex: pubkey })
      .then((result) => { if (result.ok && result.value) npubs[pubkey] = result.value; })
      .catch(() => { /* fall back to the short key */ });
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

  /** Reads every page, so nobody's older conversations silently fall off the list. */
  async function refreshConversations(): Promise<void> {
    if (!available) return;
    const collected: DmConversation[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const page = await dm.conversations(cursor ? { cursor } : {});
        collected.push(...(page.conversations ?? []));
        cursor = page.cursor && !seenCursors.has(page.cursor) ? page.cursor : undefined;
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      conversations = collected;
      for (const conversation of collected) {
        const peer = directPeer(conversation, ownerPubkey);
        if (peer) ensurePerson(peer.pubkey);
      }
    } catch {
      // The open conversation still works; the list catches up on the next message.
    } finally {
      conversationsLoaded = true;
    }
  }

  function scheduleConversationRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshConversations();
    }, CONVERSATION_REFRESH_DELAY_MS);
  }

  /** Each person keeps their own draft, so text can't go to whoever you open next. */
  function switchDraft(nextPeer: string): void {
    if (peerPubkey) drafts.set(peerPubkey, draft);
    draft = drafts.get(nextPeer) ?? '';
  }

  async function releaseConversation(revision: number): Promise<boolean> {
    if (!subscriptionId) return true;
    const previous = subscriptionId;
    subscriptionId = '';
    await dm.unsubscribe(previous).catch(() => ({ ok: false }));
    return revision === conversationRevision;
  }

  async function openConversation(pubkey: string): Promise<void> {
    const revision = ++conversationRevision;
    if (!await releaseConversation(revision)) return;
    switchDraft(pubkey);
    peerPubkey = pubkey;
    messages = [];
    error = '';
    ensurePerson(pubkey);
    if (!available || !conversationId) {
      loading = false;
      return;
    }
    loading = true;
    try {
      const openedConversationId = conversationId;
      const subscriptionPromise = dm.subscribe({ conversationId: openedConversationId });
      const historyPromise = dm.messages({ conversationId: openedConversationId, limit: 200 });
      void historyPromise.then((history) => {
        if (revision !== conversationRevision) return;
        mergeMessages(history.messages);
        // Reading history clears this conversation's unread count.
        scheduleConversationRefresh();
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

  async function chooseConversation(pubkey: string): Promise<void> {
    await openConversation(pubkey);
    await tick();
    composerElement?.focus();
  }

  async function closeConversation(): Promise<void> {
    const revision = ++conversationRevision;
    await releaseConversation(revision);
    switchDraft('');
    peerPubkey = '';
    messages = [];
    error = '';
    await tick();
    newPeerElement?.focus();
  }

  async function startConversation(): Promise<void> {
    if (startingConversation) return;
    startingConversation = true;
    newPeerError = '';
    const resolved = await resolvePeerInput(newPeerInput, ownerPubkey, (entity) => common.decodeNip19(entity));
    startingConversation = false;
    if ('error' in resolved) {
      newPeerError = resolved.error;
      return;
    }
    newPeerInput = '';
    await chooseConversation(resolved.pubkey);
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
      // The runtime reports refusals, such as "not a mutual follow", as a resolved `error`.
      const refusal = (result as { error?: unknown }).error;
      if (typeof refusal === 'string' && refusal) throw new Error(refusal);
      if (!isDmMessage(result.message)) throw new Error('Message send returned no valid receipt');
      mergeMessage(result.message);
      draft = '';
      scheduleConversationRefresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Message was not sent';
    } finally {
      sending = false;
    }
  }

  async function openProfile(pubkey: string): Promise<void> {
    if (!pubkey) return;
    await intent.invoke('napplet:profile/open', { payload: { pubkey }, behavior: { focus: true, reuse: true } });
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  }

  async function loadStatus(isDisposed: () => boolean): Promise<void> {
    const status = await dm.status();
    if (isDisposed()) return;
    available = status.available;
    ownerPubkey = status.ownerPubkey ?? '';
    statusResolved = true;
    if (!available) return;
    void refreshConversations();
    if (!inboxSubscriptionId) {
      void dm.subscribe({}).then((subscription) => {
        if (isDisposed()) void dm.unsubscribe(subscription.subscriptionId).catch(() => ({ ok: false }));
        else inboxSubscriptionId = subscription.subscriptionId;
      }).catch(() => { /* the list still refreshes after reads and sends */ });
    }
  }

  async function checkAgain(): Promise<void> {
    statusResolved = false;
    error = '';
    try {
      await loadStatus(() => false);
      if (available && peerPubkey) await openConversation(peerPubkey);
    } catch (cause) {
      statusResolved = true;
      error = cause instanceof Error ? cause.message : 'Direct messaging is unavailable';
    }
  }

  onMount(() => {
    let disposed = false;
    let openSubscription: Subscription | null = null;
    let messageSubscription: Subscription | null = null;
    void (async () => {
      try {
        await loadStatus(() => disposed);
        if (disposed) return;
        openSubscription = intent.onDelivery((event) => {
          if (event.archetype !== 'dm' || event.action !== 'open' || event.convention !== 'napplet:dm/open') return;
          const payload = parseOpenPayload(event.payload);
          if (payload) void openConversation(payload.pubkey);
        });
        messageSubscription = dm.onMessage((message, liveSubscriptionId) => {
          if (!isDmMessage(message)) return;
          if (liveSubscriptionId === inboxSubscriptionId) scheduleConversationRefresh();
          if (liveSubscriptionId !== subscriptionId || message.conversationId !== conversationId) return;
          mergeMessage(message);
          // Reading an actively displayed conversation clears the runtime-owned
          // unread count that drives the shell header badge.
          void dm.messages({ conversationId, limit: 1 }).catch(() => ({ messages: [] }));
        });
      } catch (cause) {
        statusResolved = true;
        error = cause instanceof Error ? cause.message : 'Direct messaging is unavailable';
      }
    })();
    return () => {
      disposed = true;
      openSubscription?.close();
      messageSubscription?.close();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (subscriptionId) void dm.unsubscribe(subscriptionId);
      if (inboxSubscriptionId) void dm.unsubscribe(inboxSubscriptionId);
    };
  });
</script>

{#snippet Avatar(pubkey: string, picture: string | undefined, label: string)}
  <span class="avatar" aria-hidden="true">
    {label.slice(0, 1).toUpperCase()}
    {#if picture}<img use:resourceImageBatch={picture} alt="" />{/if}
  </span>
{/snippet}

<main class="aim-window" data-testid="dm-window" data-view={peerPubkey ? 'conversation' : 'list'}>
  <header class="aim-titlebar">
    <svg class="running-man" viewBox={AIM_RUNNING_MAN_VIEW_BOX} aria-hidden="true">
      <path class="aim-logo-outline" d={AIM_RUNNING_MAN_OUTLINE_PATH}></path>
      <path class="aim-logo-fill" d={AIM_RUNNING_MAN_FILL_PATH}></path>
    </svg>
    <div>
      <strong>Direct Messenger</strong>
      <small data-testid="dm-status">{statusLine}</small>
    </div>
  </header>

  {#if statusResolved && !available && !peerPubkey}
    <section class="unavailable" data-testid="dm-unavailable">
      <strong>Private messages need a signer</strong>
      <p>This account can't encrypt messages. Sign in with a browser extension or remote signer, then check again.</p>
      <button type="button" class="action" onclick={() => { void checkAgain(); }} data-testid="dm-check-again">Check again</button>
      {#if error}<p class="notice" role="alert" data-testid="dm-error">{error}</p>{/if}
    </section>
  {:else}
  <div class="layout">
    <aside class="sidebar" aria-label="Conversations">
      <!-- Not a <form>: the allow-scripts sandbox blocks submission before `submit` fires. -->
      <div class="new-conversation" data-testid="dm-new-conversation">
        <label for="dm-new-peer">New conversation</label>
        <div class="new-conversation-row">
          <input
            id="dm-new-peer"
            bind:this={newPeerElement}
            bind:value={newPeerInput}
            placeholder="npub or public key"
            autocomplete="off"
            spellcheck="false"
            disabled={!available}
            aria-invalid={newPeerError ? 'true' : undefined}
            aria-describedby={newPeerError ? 'dm-new-peer-error' : undefined}
            oninput={() => { newPeerError = ''; }}
            onkeydown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void startConversation();
            }}
            data-testid="dm-new-peer"
          />
          <button type="button" class="action" disabled={!available || !newPeerInput.trim() || startingConversation} onclick={() => { void startConversation(); }} data-testid="dm-start">Start</button>
        </div>
        {#if newPeerError}<p class="field-error" id="dm-new-peer-error" role="alert" data-testid="dm-new-peer-error">{newPeerError}</p>{/if}
      </div>

      <div class="conversation-list" data-testid="dm-conversations">
        {#each directConversations as { conversation, peer } (conversation.id)}
          <button
            type="button"
            class="conversation-row"
            class:active={peer.pubkey === peerPubkey}
            aria-current={peer.pubkey === peerPubkey ? 'true' : undefined}
            onclick={() => { void chooseConversation(peer.pubkey); }}
            data-testid="dm-conversation"
          >
            {@render Avatar(peer.pubkey, pictureFor(peer.pubkey, peer.avatar), labelFor(peer.pubkey, peer.label))}
            <span class="conversation-text">
              <b>{labelFor(peer.pubkey, peer.label)}</b>
              {#if conversation.updatedAt}<small>{formatMessageTime(conversation.updatedAt)}</small>{/if}
            </span>
            {#if conversation.unread > 0}
              <span class="unread" aria-label={`${conversation.unread} unread`}>{conversation.unread}</span>
            {/if}
          </button>
        {:else}
          {#if available && conversationsLoaded}
            <p class="hint">No conversations yet. Enter someone's npub above, or message an online friend from Instant Messenger.</p>
          {/if}
        {/each}
      </div>
    </aside>

    <section class="conversation" aria-label="Conversation">
      {#if !peerPubkey}
        <div class="placeholder" data-testid="dm-empty">
          <strong>Pick a conversation</strong>
          <p>Choose one from the list, or start a new one with an npub.</p>
        </div>
      {:else}
        <header class="peer-bar">
          <button type="button" class="back" onclick={() => { void closeConversation(); }} aria-label="Back to conversations" data-testid="dm-back">←</button>
          <button
            class="peer-profile-link"
            type="button"
            onclick={() => { void openProfile(peerPubkey); }}
            title={`View ${peerLabel}'s profile`}
            data-testid="dm-open-profile"
          >
            {@render Avatar(peerPubkey, peerPicture, peerLabel)}
            <span class="peer-text">
              <b>{peerLabel}</b>
              {#if peerHasName}<small title={npubs[peerPubkey] ?? peerPubkey}>{shortKey(npubs[peerPubkey] ?? peerPubkey)}</small>{/if}
            </span>
          </button>
        </header>

        {#if error}
          <p class="notice" role="alert" data-testid="dm-error">{error}</p>
        {/if}

        <div class="transcript" bind:this={transcriptElement} data-testid="dm-transcript" aria-live="polite">
          {#if loading}
            <p class="empty">Opening conversation…</p>
          {:else if messages.length === 0}
            <p class="empty">{available ? 'No messages yet. You can message friends who follow you back while you\'re both online.' : 'Messages can\'t be loaded on this account.'}</p>
          {/if}
          {#each messages as message (message.id)}
            <p class="message" class:mine={message.senderPubkey === ownerPubkey} class:failed={message.status === 'failed'}>
              <span class="message-meta">
                <strong>{message.senderPubkey === ownerPubkey ? 'You' : peerLabel}</strong>
                <time>{formatMessageTime(message.createdAt)}</time>
                {#if message.status === 'failed'}<em>Not sent</em>{/if}
              </span>
              <span class="message-body">{message.content}</span>
            </p>
          {/each}
        </div>

        {#if !available}
          <div class="composer-blocked" data-testid="dm-unavailable">
            <span>Sign in with a browser extension or remote signer to message {peerLabel}.</span>
            <button type="button" class="action" onclick={() => { void checkAgain(); }} data-testid="dm-check-again">Check again</button>
          </div>
        {:else}
          <div class="composer">
            <textarea
              bind:this={composerElement}
              bind:value={draft}
              aria-label={`Message ${peerLabel}`}
              placeholder={`Message ${peerLabel}…`}
              rows="2"
              onkeydown={handleComposerKeydown}
              data-testid="dm-input"
            ></textarea>
            <button
              class="action send"
              type="button"
              disabled={!draft.trim() || sending}
              onclick={() => { void send(); }}
              data-testid="dm-send"
            >{sending ? 'Sending…' : 'Send'}</button>
          </div>
        {/if}
      {/if}

      {#if !peerPubkey && error}
        <p class="notice" role="alert" data-testid="dm-error">{error}</p>
      {/if}
    </section>
  </div>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    min-width: 300px;
    background: var(--hg-bg-base);
    color: var(--hg-text-primary);
    font: 12px/1.35 var(--hg-font-body);
  }

  button, textarea, input { font: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }
  button:focus-visible, input:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--hg-accent-primary);
    outline-offset: 1px;
  }

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
    display: flex;
    flex-direction: column;
    gap: 5px;
    height: 100vh;
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
    border-radius: 5px;
    text-shadow: 0 1px var(--aim-title-shadow);
  }

  .aim-titlebar div:last-child { display: grid; }
  .aim-titlebar small { opacity: .85; font-size: 10px; }
  .running-man { width: 27px; height: 27px; flex: 0 0 auto; }
  .running-man .aim-logo-outline { fill: var(--aim-theme-background); }
  .running-man .aim-logo-fill { fill: var(--aim-theme-primary); }

  .action {
    min-width: 54px;
    padding: 3px 9px;
    border: 1px solid var(--hg-border-default);
    border-radius: 3px;
    color: var(--hg-text-primary);
    background: linear-gradient(var(--aim-control-top), var(--aim-control-bottom));
    box-shadow: inset 0 1px color-mix(in srgb, var(--hg-text-primary) 18%, transparent);
    white-space: nowrap;
  }

  .unavailable {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 24px 16px;
    border: 1px solid var(--hg-border-default);
    background: var(--hg-bg-surface);
    text-align: center;
  }
  .unavailable strong { font-size: 14px; }
  .unavailable p { max-width: 42ch; margin: 0 0 6px; color: var(--hg-text-muted); }
  .unavailable .notice { margin-top: 6px; color: var(--hg-accent-danger); }
  .composer-blocked {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px 12px;
    padding: 7px;
    border-top: 1px solid var(--hg-border-muted);
    color: var(--hg-text-muted);
    background: var(--hg-bg-elevated);
  }

  .notice {
    margin: 0;
    padding: 5px 7px;
    color: var(--hg-accent-danger);
    border: 1px solid currentColor;
    background: color-mix(in srgb, var(--hg-accent-danger) 10%, var(--hg-bg-surface));
  }

  .layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(190px, 260px) minmax(0, 1fr);
    gap: 5px;
  }

  .sidebar, .conversation {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--hg-border-default);
    background: var(--hg-bg-surface);
  }

  .new-conversation { padding: 7px; border-bottom: 1px solid var(--hg-border-muted); background: var(--hg-bg-elevated); }
  .new-conversation label { display: block; margin-bottom: 4px; font-weight: 700; }
  .new-conversation-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; }
  .new-conversation input, textarea {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--hg-border-default);
    color: var(--hg-text-primary);
    background: var(--hg-bg-surface);
  }
  .new-conversation input { padding: 3px 6px; min-width: 0; }
  .new-conversation input:disabled { opacity: .6; }
  input::placeholder, textarea::placeholder { color: var(--hg-text-muted); opacity: .75; }
  .field-error { margin: 4px 0 0; color: var(--hg-accent-danger); }

  .conversation-list { flex: 1; min-height: 0; overflow: auto; }
  .conversation-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 7px;
    align-items: center;
    width: 100%;
    padding: 6px 7px;
    border: 0;
    border-bottom: 1px solid var(--hg-border-muted);
    color: inherit;
    background: none;
    text-align: left;
  }
  .conversation-row:hover { background: color-mix(in srgb, var(--hg-accent-primary) 12%, var(--hg-bg-surface)); }
  .conversation-row.active { background: color-mix(in srgb, var(--hg-accent-primary) 22%, var(--hg-bg-surface)); }
  .conversation-text, .peer-text { display: grid; min-width: 0; }
  .conversation-text b, .peer-text b, .conversation-text small, .peer-text small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .conversation-text small, .peer-text small { color: var(--hg-text-muted); font-size: 10px; }
  .unread {
    min-width: 8px;
    padding: 0 5px;
    border-radius: 8px;
    color: var(--hg-bg-base);
    background: var(--hg-accent-primary);
    font-weight: 700;
    text-align: center;
  }
  .hint { margin: 0; padding: 9px; color: var(--hg-text-muted); }

  .avatar {
    position: relative;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid var(--hg-border-default);
    border-radius: 3px;
    overflow: hidden;
    color: var(--hg-text-primary);
    background: color-mix(in srgb, var(--hg-accent-primary) 26%, var(--hg-bg-elevated));
    font-weight: 700;
  }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }

  .placeholder {
    flex: 1;
    display: grid;
    place-content: center;
    gap: 4px;
    padding: 16px;
    text-align: center;
  }
  .placeholder strong { font-size: 14px; }
  .placeholder p { margin: 0; color: var(--hg-text-muted); }

  .peer-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 7px;
    border-bottom: 1px solid var(--hg-border-muted);
    background: var(--hg-bg-elevated);
  }
  .back { display: none; padding: 2px 8px; border: 1px solid var(--hg-border-default); border-radius: 3px; color: inherit; background: none; }
  .peer-profile-link {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    text-align: left;
  }
  .peer-profile-link:hover b, .peer-profile-link:focus-visible b { text-decoration: underline; text-underline-offset: 2px; }

  .transcript { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
  .message { display: grid; gap: 1px; margin: 0 0 9px; }
  .message-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
  .message-meta strong { color: color-mix(in srgb, var(--hg-accent-primary) 72%, var(--hg-text-primary)); }
  .message.mine .message-meta strong { color: var(--hg-accent-primary); }
  .message-meta time { color: var(--hg-text-muted); font-size: 10px; }
  .message-meta em { color: var(--hg-accent-danger); font-size: 10px; font-style: normal; }
  .message-body { white-space: pre-wrap; overflow-wrap: anywhere; }
  .message.failed .message-body { color: var(--hg-text-muted); }
  .empty { margin: 0; color: var(--hg-text-muted); font-style: italic; }

  .composer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 5px;
    padding: 5px;
    border-top: 1px solid var(--hg-border-muted);
  }
  textarea { min-height: 44px; max-height: 40vh; resize: vertical; padding: 6px 7px; }
  .send { min-width: 76px; padding-block: 6px; font-weight: 700; }

  @media (max-width: 560px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .aim-window[data-view='conversation'] .sidebar { display: none; }
    .aim-window[data-view='list'] .conversation { display: none; }
    .back { display: block; }
  }
</style>
