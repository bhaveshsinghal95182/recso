/**
 * Screens the API sends the window to: the recorder when an API recording
 * starts, the editor for `projects.open`.
 *
 * A message sent before the renderer has mounted is lost, and `recso
 * --background` followed at once by `recso-cli projects open` is exactly
 * that. So the request waits here: the renderer is nudged, and takes it
 * both when nudged and when it mounts. Only the newest request counts.
 */

export type AutomationNavigation =
  | { screen: 'recorder' }
  | { screen: 'editor'; projectDir: string };

export class PendingNavigation {
  private pending: AutomationNavigation | null = null;

  constructor(private readonly nudge: () => void) {}

  request(navigation: AutomationNavigation): void {
    this.pending = navigation;
    this.nudge();
  }

  /** The waiting request, once: a second take returns null. */
  take(): AutomationNavigation | null {
    const navigation = this.pending;
    this.pending = null;
    return navigation;
  }
}
