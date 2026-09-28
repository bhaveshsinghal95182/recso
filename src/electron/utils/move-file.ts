import fs from 'fs';

/**
 * Move a file, even to another filesystem.
 *
 * `rename` only works within one filesystem. On Windows the temp folder and
 * the recordings folder are usually on the same drive, but on Linux `/tmp` is
 * commonly a tmpfs of its own, and `rename` fails there with EXDEV. Then the
 * file is copied and the original removed -- copied first, so a failure part
 * way leaves the source intact rather than losing the recording.
 */
export function moveFileSync(
  source: string,
  destination: string,
  rename: (from: string, to: string) => void = fs.renameSync,
): void {
  try {
    rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}
