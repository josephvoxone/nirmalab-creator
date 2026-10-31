import { BlockList, isIP } from 'node:net';

/**
 * How many reverse proxies sit in front of the app and are trusted to write X-Forwarded-For.
 *
 * Fastify's `trustProxy: <n>` trusts the n closest hops (the TCP peer is hop 1) and takes the client address
 * from the entry the n-th proxy appended; everything the client wrote itself (the left of the chain) is
 * ignored. Production is Cloudflare -> Traefik -> app = 2 hops. Under-trusting is safe (the key is a proxy
 * address: coarse, never forgeable); over-trusting lets a client choose its own key. So the default is 1 —
 * Traefik always fronts the container — and 2 is set explicitly once `GET /api/auth/client-ip` shows the
 * real client address (see the C-sec report).
 */
export const DEFAULT_TRUST_PROXY_HOPS = 1;
const MAX_TRUST_PROXY_HOPS = 8;

export function parseTrustProxyHops(raw: unknown, fallback = DEFAULT_TRUST_PROXY_HOPS): number {
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n <= MAX_TRUST_PROXY_HOPS ? n : fallback;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** Loopback / private / link-local / CGNAT: where a reverse proxy in the same host or docker network lives. */
export function isPrivatePeer(address: string | undefined): boolean {
  if (!address) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped ? mapped[1]! : address;
  const family = isIP(plain);
  return family !== 0 && PRIVATE.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Fastify option for `hops` trusted proxies. Fastify 5 treats a bare NUMBER as "trust nothing" (hop count cannot
 * check the immediate peer), so this is a function: hop 0 (the TCP peer) is trusted only when it is a private/loopback
 * address — a public client that merely sends a long X-Forwarded-For stays itself — and hops 1..n-1 are the
 * entries the trusted proxies appended.
 */
export function trustProxyFor(hops: number): false | ((address: string, hop: number) => boolean) {
  if (hops <= 0) return false;
  return (address, hop) => hop < hops && (hop > 0 || isPrivatePeer(address));
}

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and /ips-v6, checked 2026-11-01).
 * Behind Cloudflare → Traefik the address the app resolves is a Cloudflare EDGE node that differs from request to
 * request; the real visitor is in the `CF-Connecting-IP` header Cloudflare writes. That header is only believable
 * when the connection really came from one of these ranges (Traefik writes the TCP peer into X-Forwarded-For, so a
 * direct hit on the origin cannot pretend to be Cloudflare). Override with env `CLOUDFLARE_IP_RANGES` (comma list)
 * if Cloudflare ever changes them.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
];

function rangeList(ranges: readonly string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    const [net, bits] = range.trim().split('/');
    const family = isIP(net ?? '');
    if (!net || !bits || family === 0 || !/^\d{1,3}$/.test(bits)) continue;
    try { list.addSubnet(net, Number(bits), family === 4 ? 'ipv4' : 'ipv6'); } catch { /* skip a malformed range */ }
  }
  return list;
}

let cloudflare = rangeList(CLOUDFLARE_RANGES);
export function useCloudflareRanges(ranges: readonly string[] | undefined): void {
  cloudflare = rangeList(ranges && ranges.length ? ranges : CLOUDFLARE_RANGES);
}

export function isCloudflarePeer(address: string | undefined): boolean {
  if (!address) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped ? mapped[1]! : address;
  const family = isIP(plain);
  return family !== 0 && cloudflare.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

/** The visitor's address: `CF-Connecting-IP` when the resolved peer is a Cloudflare node and the value is an IP; else the peer itself. */
export function resolveClientIp(peer: string, cfConnectingIp: string | string[] | undefined): string {
  if (!isCloudflarePeer(peer)) return peer;
  const raw = (Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp)?.trim();
  return raw && isIP(raw) !== 0 ? raw : peer;
}
