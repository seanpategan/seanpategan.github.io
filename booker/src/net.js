// From sat-fordhamprep (site/src/net.ts), unchanged apart from the types.

/**
 * Rate-limit key for the client: the IPv4 address, or the IPv6 /64 (one customer's whole
 * allocation), so rotating through a prefix doesn't buy fresh limits.
 */
export function clientKey(ip) {
  if (!ip.includes(":")) return `ip:${ip}`;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `ip6:${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
