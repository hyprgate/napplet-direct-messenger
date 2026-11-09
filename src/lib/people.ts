import type { CommonNip19DecodeResult, CommonProfileData, DmConversation } from '@napplet/sdk';

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

export function shortKey(key: string): string {
  return key.length > 18 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key;
}

/** Best-effort name: profile first, then what the runtime knows, then the npub. */
export function personLabel(
  profile: CommonProfileData | null | undefined,
  pubkey: string,
  npub?: string,
  runtimeLabel?: string,
): string {
  const candidates = [profile?.displayName, profile?.display_name, profile?.name, profile?.nip05, runtimeLabel];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return shortKey(npub ?? pubkey);
}

/** The other person in a direct conversation. Group threads have no single peer. */
export function directPeer(conversation: DmConversation, ownerPubkey: string) {
  if (conversation.kind !== 'direct') return null;
  return conversation.participants.find((peer) => peer.pubkey !== ownerPubkey) ?? null;
}

export function sortConversations(conversations: DmConversation[]): DmConversation[] {
  return [...conversations].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Turn what someone typed into a public key, or a message saying what to fix. */
export async function resolvePeerInput(
  value: string,
  ownerPubkey: string,
  decode: (entity: string) => Promise<CommonNip19DecodeResult>,
): Promise<{ pubkey: string } | { error: string }> {
  const target = value.trim().replace(/^nostr:/, '');
  if (!target) return { error: 'Enter an npub or public key.' };
  let pubkey: string | undefined;
  if (HEX_PUBKEY.test(target)) {
    pubkey = target.toLowerCase();
  } else if (/^(npub|nprofile)1/.test(target)) {
    const decoded = await decode(target).catch(() => null);
    pubkey = decoded?.ok ? decoded.pubkey ?? decoded.hex : undefined;
  }
  if (!pubkey || !HEX_PUBKEY.test(pubkey)) return { error: "That doesn't look like an npub or public key." };
  if (pubkey === ownerPubkey) return { error: "That's your own key. Enter someone else's." };
  return { pubkey };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Clock time today, otherwise the date too. `timestamp` is in seconds. */
export function formatMessageTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp * 1_000);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
