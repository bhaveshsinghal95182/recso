/**
 * Clean up a media path that came from a human.
 *
 * Windows Explorer's "Copy as path" wraps the path in double quotes, and that
 * is the normal way to get a path onto the clipboard. Media Foundation rejects
 * the quoted form outright with ERROR_INVALID_NAME (0x8007007B), which reads as
 * "your file is broken" rather than "there are quotes around it".
 *
 * Backslashes, forward slashes and surrounding whitespace are all fine on their
 * own -- verified against the decoder -- so this only strips what actually
 * breaks: wrapping quotes and stray whitespace.
 */
export function normalizeMediaPath(input: string): string {
  let path = input.trim();

  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  ) {
    path = path.slice(1, -1).trim();
  }

  return path;
}
