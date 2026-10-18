// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { common, dm, intent } from '@napplet/sdk';

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
  common: { getProfile: vi.fn() },
  dm: {
    status: vi.fn().mockResolvedValue({ available: true, ownerPubkey: 'a'.repeat(64) }),
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
}));

describe('direct messenger live conversation startup', () => {
  afterEach(() => {
    vi.clearAllMocks();
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
});
