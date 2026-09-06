/** Joins non-empty class names for shared presentation components. */
export function classNames(...parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => part !== null && part !== undefined && part.length > 0).join(" ");
}
