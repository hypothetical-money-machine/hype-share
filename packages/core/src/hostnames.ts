/**
 * One DNS label per RFC 1123: 1 to 63 lowercase alphanumerics or hyphens,
 * not starting or ending with a hyphen. Site ids, slugs, the labels of a
 * configured host suffix, and the subdomain of an incoming Host header are
 * all checked against this one rule, because under hostname serving they are
 * all the same thing.
 */
export const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isHostLabel(value: string): boolean {
  return HOST_LABEL_RE.test(value);
}
