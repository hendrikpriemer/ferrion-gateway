// IPv4 addresses and CIDR blocks for the device discovery (R07, stage 2).
//
// IPv4 only, on purpose: the networks a discovery sweeps are plant networks
// (10.x, 172.16.x, 192.168.x), and an IPv6 /64 cannot be swept at all. A
// host named in a scan request must be an IPv4 literal, never a DNS name -
// a name could resolve to anything, and every address has to be checked
// against the gateway's own discovery limit before a single probe leaves.

export interface Cidr {
  // Network address as an unsigned 32-bit number, host bits cleared.
  network: number;
  prefix: number;
}

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => OCTET.test(part))) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

export function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function mask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/**
 * `10.0.4.0/24`, or a bare address as a /32. Host bits must be zero:
 * `10.0.4.7/24` is refused rather than silently widened, since whoever wrote
 * it may have meant the single host.
 */
export function parseCidr(text: string): Cidr | null {
  const [address, prefixText, ...rest] = text.trim().split("/");
  if (rest.length > 0 || address === undefined) return null;
  const value = parseIpv4(address);
  if (value === null) return null;
  if (prefixText === undefined) return { network: value, prefix: 32 };
  if (!/^(3[0-2]|[12]?\d)$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (((value & ~mask(prefix)) >>> 0) !== 0) return null;
  return { network: value, prefix };
}

export function formatCidr(cidr: Cidr): string {
  return `${formatIpv4(cidr.network)}/${cidr.prefix}`;
}

export function cidrContainsAddress(cidr: Cidr, address: number): boolean {
  return ((address & mask(cidr.prefix)) >>> 0) === cidr.network;
}

/** Whether `inner` lies entirely inside `outer`. */
export function cidrContainsCidr(outer: Cidr, inner: Cidr): boolean {
  return inner.prefix >= outer.prefix && cidrContainsAddress(outer, inner.network);
}

/**
 * The addresses a sweep probes: without network and broadcast address from
 * /30 down; a /31 (point-to-point) and a /32 have no such pair.
 */
export function cidrHosts(cidr: Cidr): number[] {
  const size = 2 ** (32 - cidr.prefix);
  if (size <= 2) return Array.from({ length: size }, (_, offset) => cidr.network + offset);
  return Array.from({ length: size - 2 }, (_, offset) => cidr.network + offset + 1);
}

/** The number of addresses `cidrHosts` returns, without building the list. */
export function cidrHostCount(cidr: Cidr): number {
  const size = 2 ** (32 - cidr.prefix);
  return size <= 2 ? size : size - 2;
}
