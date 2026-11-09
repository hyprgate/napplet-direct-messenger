// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { common, dm, intent } from '@napplet/sdk';

const OWNER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const PEER_NPUB = 'npub1peerpeerpeerpeerpeerpeerpeerpeerpeerpeer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const subscriptions = vi.hoisted(() => ({
  open: null as null | ((event: { archetype: string; action: string; convention: string; payload: unknown }) => void),
  message: null as null | ((message: Record<string, unknown>, subscriptionId: string) => void),
}));

vi.mock('@napplet/sdk', () => ({
  common: {
    getProfile: vi.fn().mockResolvedValue({ ok: true, profile: null }),
    encodeNip19: vi.fn().mockResolvedValue({ ok: false }),
    decodeNip19: vi.fn(),
  },
  dm: {
    conversations: vi.fn().mockResolvedValue({ conversations: [] }),
    status: vi.fn().mockResolvedValue({ available: true, ownerPubkey: 'a'.repeat(64), implementations: ['ndr'], capabilities: [] }),
    messages: vi.fn(),
    subscribe: vi.fn().mockResolvedValue({ subscriptionId: 'live-1' }),
    unsubscribe: vi.fn().mockResolvedValue({ ok: true }),
    send: vi.fn(),
    onMessage: vi.fn((callback) => {
      subscriptions.message = callback;
      return { close: vi.fn() };
    }),
  },
  intent: {
    invoke: vi.fn(),
    onDelivery: vi.fn((callback) => {
      subscriptions.open = callback;
      return { close: vi.fn() };
    }),
  },
}));

vi.mock('@hyprgate/utils', () => ({
  AIM_RUNNING_MAN_FILL_PATH: '',
  AIM_RUNNING_MAN_OUTLINE_PATH: '',
  AIM_RUNNING_MAN_VIEW_BOX: '0 0 1 1',
  resourceImageBatch: (node: HTMLImageElement, source: string) => {
    node.setAttribute('data-resource-source', source);
    return { destroy() {} };
  },
}));

describe('direct messenger live conversation startup', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(dm.status).mockResolvedValue({ available: true, ownerPubkey: OWNER, implementations: ['ndr'], capabilities: [] });
    vi.mocked(dm.conversations).mockResolvedValue({ conversations: [] });
    vi.mocked(common.getProfile).mockResolvedValue({ ok: true, pubkey: PEER, profile: null });
    vi.mocked(common.encodeNip19).mockResolvedValue({ ok: false });
    subscriptions.open = null;
    subscriptions.message = null;
    document.body.innerHTML = '';
  });

  it('does not register a receiver after unmount while DM status is pending', async () => {
    const status = deferred<Awaited<ReturnType<typeof dm.status>>>();
    vi.mocked(dm.status).mockReturnValueOnce(status.promise);
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(dm.status).toHaveBeenCalled());
    await unmount(component);
    status.resolve({ available: true, ownerPubkey: 'a'.repeat(64), implementations: [], capabilities: [] });
    await Promise.resolve();
    expect(intent.onDelivery).not.toHaveBeenCalled();
    expect(dm.onMessage).not.toHaveBeenCalled();
  });

  it('opens the live subscription before profile or history resolve and preserves streamed messages', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const profile = deferred<{ ok: true; pubkey: string; profile: null }>();
    const history = deferred<{ messages: Array<Record<string, unknown>> }>();
    vi.mocked(common.getProfile).mockReturnValueOnce(profile.promise);
    vi.mocked(dm.messages)
      .mockResolvedValue({ messages: [] })
      .mockReturnValueOnce(history.promise as never);

    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(intent.onDelivery).toHaveBeenCalled());

    const peerPubkey = 'b'.repeat(64);
    subscriptions.open?.({ archetype: 'dm', action: 'open', convention: 'napplet:dm/open', payload: { pubkey: peerPubkey } });
    await vi.waitFor(() => {
      expect(dm.subscribe).toHaveBeenCalledWith({
        conversationId: `direct:${['a'.repeat(64), peerPubkey].sort().join(',')}`,
      });
    });
    expect(vi.mocked(dm.subscribe).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(common.getProfile).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(dm.subscribe).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dm.messages).mock.invocationCallOrder[0]!,
    );

    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain('Opening conversation…');
    });

    subscriptions.message?.({
      id: 'live-message',
      conversationId: `direct:${['a'.repeat(64), peerPubkey].sort().join(',')}`,
      senderPubkey: peerPubkey,
      content: 'arrived live',
      createdAt: 20,
      status: 'received',
    }, 'live-1');
    await vi.waitFor(() => expect(document.body.textContent).toContain('arrived live'));

    history.resolve({
      messages: [{
        id: 'history-message',
        conversationId: `direct:${['a'.repeat(64), peerPubkey].sort().join(',')}`,
        senderPubkey: peerPubkey,
        content: 'from history',
        createdAt: 10,
        status: 'received',
      }],
    });
    profile.resolve({ ok: true, pubkey: peerPubkey, profile: null });

    await vi.waitFor(() => expect(document.body.textContent).toContain('from history'));
    expect(document.body.textContent).toContain('arrived live');
    unmount(component);
  });

  it('ignores malformed persisted and streamed entries without aborting the conversation', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(common.getProfile).mockResolvedValue({ ok: true, pubkey: 'b'.repeat(64), profile: null });
    vi.mocked(dm.messages).mockResolvedValue({
      messages: [undefined, null, {
        id: 'valid-history',
        conversationId: `direct:${['a'.repeat(64), 'b'.repeat(64)].sort().join(',')}`,
        senderPubkey: 'b'.repeat(64),
        content: 'valid history',
        createdAt: 10,
        status: 'received',
      }],
    } as never);

    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(intent.onDelivery).toHaveBeenCalled());
    subscriptions.open?.({ archetype: 'dm', action: 'open', convention: 'napplet:dm/open', payload: { pubkey: 'b'.repeat(64) } });

    await vi.waitFor(() => expect(document.body.textContent).toContain('valid history'));
    expect(document.querySelector('[data-testid="dm-error"]')).toBeNull();

    subscriptions.message?.(undefined as never, 'live-1');
    await Promise.resolve();
    expect(document.querySelector('[data-testid="dm-error"]')).toBeNull();
    expect(document.body.textContent).toContain('valid history');
    unmount(component);
  });

  it('names itself, and explains what a read-only account needs instead of offering a dead composer', async () => {
    vi.mocked(dm.status).mockResolvedValue({ available: false, ownerPubkey: OWNER, implementations: ['ndr'], capabilities: [] });
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-unavailable"]')).not.toBeNull());
    expect(document.querySelector('.aim-titlebar strong')?.textContent).toBe('Direct Messenger');
    expect(document.querySelector('[data-testid="dm-input"]')).toBeNull();
    expect(document.querySelector('[data-testid="dm-new-peer"]')).toBeNull();
    expect(dm.conversations).not.toHaveBeenCalled();

    vi.mocked(dm.status).mockResolvedValue({ available: true, ownerPubkey: OWNER, implementations: ['ndr'], capabilities: [] });
    document.querySelector<HTMLButtonElement>('[data-testid="dm-check-again"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-unavailable"]')).toBeNull());
    expect(dm.conversations).toHaveBeenCalled();
    unmount(component);
  });

  it('does not ask the runtime for a conversation it cannot read when an intent arrives on a read-only account', async () => {
    vi.mocked(dm.status).mockResolvedValue({ available: false, ownerPubkey: OWNER, implementations: ['ndr'], capabilities: [] });
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(intent.onDelivery).toHaveBeenCalled());
    subscriptions.open?.({ archetype: 'dm', action: 'open', convention: 'napplet:dm/open', payload: { pubkey: PEER } });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-open-profile"]')).not.toBeNull());
    expect(dm.subscribe).not.toHaveBeenCalled();
    expect(dm.messages).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="dm-error"]')).toBeNull();
    unmount(component);
  });

  it('lists every page of conversations with profile names and unread counts', async () => {
    vi.mocked(dm.conversations)
      .mockResolvedValueOnce({
        conversations: [{ id: 'one', kind: 'direct', unread: 2, updatedAt: 100, participants: [{ pubkey: OWNER }, { pubkey: PEER }] }],
        cursor: 'next',
      })
      .mockResolvedValueOnce({
        conversations: [
          { id: 'two', kind: 'direct', unread: 0, updatedAt: 200, participants: [{ pubkey: OWNER }, { pubkey: 'c'.repeat(64), label: 'Runtime label' }] },
          { id: 'group', kind: 'group', unread: 0, participants: [{ pubkey: OWNER }, { pubkey: PEER }, { pubkey: 'd'.repeat(64) }] },
        ],
      });
    vi.mocked(common.getProfile).mockImplementation(async (target) => (
      target === PEER
        ? { ok: true, pubkey: PEER, profile: { display_name: 'Ines Okafor', picture: 'https://media.example/ines.png' } }
        : { ok: true, pubkey: String(target), profile: null }
    ));
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => {
      const rows = [...document.querySelectorAll('[data-testid="dm-conversation"]')];
      expect(rows.map((row) => row.querySelector('b')?.textContent)).toEqual(['Runtime label', 'Ines Okafor']);
    });
    expect(dm.conversations).toHaveBeenLastCalledWith({ cursor: 'next' });
    expect(document.querySelector('.unread')?.textContent).toBe('2');
    expect(document.querySelector('[data-resource-source]')?.getAttribute('data-resource-source')).toBe('https://media.example/ines.png');
    unmount(component);
  });

  it('falls back to the npub for a person with no profile and opens their profile from the name', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(dm.messages).mockResolvedValue({ messages: [] });
    vi.mocked(common.encodeNip19).mockResolvedValue({ ok: true, value: PEER_NPUB });
    vi.mocked(intent.invoke).mockResolvedValue({ ok: true } as never);
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(intent.onDelivery).toHaveBeenCalled());
    subscriptions.open?.({ archetype: 'dm', action: 'open', convention: 'napplet:dm/open', payload: { pubkey: PEER } });
    const link = await vi.waitFor(() => {
      const element = document.querySelector<HTMLButtonElement>('[data-testid="dm-open-profile"]');
      expect(element?.textContent).toContain('npub1peerp');
      return element!;
    });
    link.click();
    expect(intent.invoke).toHaveBeenCalledWith('napplet:profile/open', { payload: { pubkey: PEER }, behavior: { focus: true, reuse: true } });
    unmount(component);
  });

  it('starts a conversation from an npub and says what is wrong with anything else', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(dm.messages).mockResolvedValue({ messages: [] });
    vi.mocked(common.decodeNip19).mockResolvedValue({ ok: true, nip19Type: 'npub', hex: PEER });
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-new-peer"]')?.hasAttribute('disabled')).toBe(false));
    const input = document.querySelector<HTMLInputElement>('[data-testid="dm-new-peer"]')!;
    // The allow-scripts sandbox never fires `submit`, so this can't rely on a form.
    expect(document.querySelector('form')).toBeNull();

    input.value = 'not a key';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-new-peer-error"]')?.textContent).toContain('npub or public key'));
    expect(dm.subscribe).not.toHaveBeenCalledWith({ conversationId: expect.any(String) });

    input.value = PEER_NPUB;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-testid="dm-start"]')?.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>('[data-testid="dm-start"]')!.click();
    await vi.waitFor(() => expect(dm.subscribe).toHaveBeenCalledWith({
      conversationId: `direct:${[OWNER, PEER].sort().join(',')}`,
    }));
    expect(common.decodeNip19).toHaveBeenCalledWith(PEER_NPUB);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-input"]')).not.toBeNull());
    unmount(component);
  });

  async function openedComposer(pubkey: string): Promise<HTMLTextAreaElement> {
    subscriptions.open?.({ archetype: 'dm', action: 'open', convention: 'napplet:dm/open', payload: { pubkey } });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-open-profile"]')?.textContent).toContain(pubkey.slice(0, 4)));
    return vi.waitFor(() => {
      const element = document.querySelector<HTMLTextAreaElement>('[data-testid="dm-input"]');
      expect(element).not.toBeNull();
      return element!;
    });
  }

  it('shows the runtime refusal, resolved or rejected, and keeps the draft', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(dm.messages).mockResolvedValue({ messages: [] });
    vi.mocked(dm.send)
      .mockResolvedValueOnce({ error: 'Messages can only be sent to mutual follows' } as never)
      .mockRejectedValueOnce(new Error('Both friends must be online to send a message'));
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(intent.onDelivery).toHaveBeenCalled());
    const input = await openedComposer(PEER);
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const sendButton = () => document.querySelector<HTMLButtonElement>('[data-testid="dm-send"]')!;
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    sendButton().click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-error"]')?.textContent).toContain('mutual follows'));
    expect(input.value).toBe('hello');
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    sendButton().click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="dm-error"]')?.textContent).toContain('must be online'));
    expect(input.value).toBe('hello');
    unmount(component);
  });

  it('keeps a draft with its person, so it cannot go to whoever is opened next', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(dm.messages).mockResolvedValue({ messages: [] });
    const other = 'c'.repeat(64);
    const component = mount(App, { target: document.body });
    await vi.waitFor(() => expect(intent.onDelivery).toHaveBeenCalled());
    const input = await openedComposer(PEER);
    input.value = 'for the first person';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await openedComposer(other);
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('[data-testid="dm-input"]')!.value).toBe(''));

    await openedComposer(PEER);
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('[data-testid="dm-input"]')!.value).toBe('for the first person'));
    unmount(component);
  });
});
