## Download

| System                                    | File                          |
| ----------------------------------------- | ----------------------------- |
| Windows 10 or 11 (64-bit)                 | `Recso-Setup-{{version}}.exe` |
| Linux, any distribution (64-bit x86)      | `Recso-x86_64.AppImage`       |
| Debian, Ubuntu, Mint, Pop!\_OS (optional) | `recso_{{version}}_amd64.deb` |

Recso keeps itself up to date on Windows and in the AppImage: when a new version has downloaded, it offers to restart, and otherwise updates the next time you quit.

## Windows

Run `Recso-Setup-{{version}}.exe`. The installer asks whether to install for you or for everyone on the PC (everyone needs an administrator), and whether to add `recso-cli` to your PATH, which only matters for scripting.

The installer isn't code-signed yet, so Windows and your browser warn about it. Each warning has a way through:

- **Edge: "isn't commonly downloaded".** Hover over the download, click **…**, then **Keep**, **Show more** and **Keep anyway**.
- **Chrome: "suspicious download blocked" or "may be dangerous".** Click **Keep**, or open the downloads page and choose **Download suspicious file**.
- **"Windows protected your PC" (SmartScreen).** Click **More info**, then **Run anyway**.
- **"Smart App Control blocked an app".** There is no "run anyway" for this one. The only way is to turn Smart App Control off: Windows Security → App & browser control → Smart App Control settings → Off. On some Windows 11 versions it can't be turned back on without resetting Windows, so skip this if that matters to you.
- **The installer disappears, or Windows Security says it found a threat.** Open Windows Security → Virus & threat protection → Protection history, find the entry for the installer, choose **Actions → Allow on device**, then download it again.
- **A work or school PC refuses to run it.** Your organization's policy blocks unsigned apps; only its IT team can allow it.

If you installed an earlier `.appx` version of Recso, uninstall it first (Settings → Apps → Installed apps) so you don't end up with two.

**Camera or microphone missing in Recso?** Settings → Privacy & security → Camera (and Microphone) → turn on **Let desktop apps access your camera** (or microphone).

Recso needs a graphics card with Direct3D 11, which every PC from the last decade has. Some virtual machines and remote desktop sessions don't, and there Recso can't finish a recording.

To uninstall: Settings → Apps → Installed apps → Recso → Uninstall.

## Linux

Recso records through your desktop's screen-sharing portal, the same one browsers use. If screen sharing works in Firefox or Chrome, Recso can record. It needs a distribution from 2022 or later (Ubuntu 22.04, Debian 12, Fedora 36, Mint 21 or newer; rolling distributions are fine).

### AppImage (every distribution)

1. Download `Recso-x86_64.AppImage` and move it somewhere permanent, such as `~/Applications`. Keep its name: updates replace this file, and the menu entry points at it.
2. Make it executable: `chmod +x ~/Applications/Recso-x86_64.AppImage`, or in your file manager, Properties → Permissions → **Allow executing file as program**.
3. Run it. The first run adds Recso to your app menu; after that, start it from there.

**If it doesn't start, install FUSE 2.** AppImages need it, and many distributions no longer include it. Running it from a terminal shows "AppImages require FUSE to run".

| Distribution                                               | Command                                      |
| ---------------------------------------------------------- | -------------------------------------------- |
| Ubuntu 24.04 and later, Mint 22, Pop!\_OS 24.04, Debian 13 | `sudo apt install libfuse2t64`               |
| Ubuntu 22.04, Mint 21, Pop!\_OS 22.04, Debian 12           | `sudo apt install libfuse2`                  |
| Fedora                                                     | `sudo dnf install fuse-libs`                 |
| Fedora Silverblue and Kinoite                              | `rpm-ostree install fuse-libs`, then restart |
| Arch, Manjaro, EndeavourOS                                 | `sudo pacman -S fuse2`                       |
| openSUSE                                                   | `sudo zypper install libfuse2`               |

**On Ubuntu 24.04 and later (and some distributions based on it)**, Ubuntu blocks the sandbox the AppImage uses, so it closes straight away; from a terminal you'd see "No usable sandbox" or "The SUID sandbox helper binary was found, but is not configured correctly". Start it once from a terminal with `~/Applications/Recso-x86_64.AppImage --no-sandbox`; the menu entry it adds already includes that. Or install the `.deb` instead, which doesn't have this problem.

**NixOS:** run it with `appimage-run` (`nix-shell -p appimage-run --run "appimage-run ./Recso-x86_64.AppImage"`), or enable `programs.appimage` with `binfmt = true`.

**Gear Lever and AppImageLauncher** work too: Recso notices when one of them has added it and doesn't add a second menu entry.

To uninstall: delete the AppImage, `~/.local/share/applications/recso.desktop` and `~/.local/share/icons/hicolor/*/apps/recso.png`. Settings and the library are in `~/.config/recso`.

### .deb (Debian, Ubuntu, Mint, Pop!\_OS)

```bash
sudo apt install ./recso_{{version}}_amd64.deb
```

This needs neither FUSE nor the sandbox step, and adds `recso-cli`. It doesn't update itself: install each new `.deb` the same way. To uninstall: `sudo apt remove recso`.

### Clicks for auto zoom on GNOME, KDE and other Wayland desktops

Auto zoom zooms in where you click. On Hyprland and on X11, Recso sees clicks without any setup. GNOME, KDE and other Wayland desktops don't share clicks with apps, so Recso reads them from your mouse and touchpad directly, which needs you in the `input` group:

```bash
sudo usermod -aG input $USER
```

Then log out and back in. Recso shows a note on the recording screen while it can't see clicks.

Members of the `input` group can read every input device, keyboards included. Recso only reads mouse buttons, but if you'd rather not grant that, skip this step: recording works the same, and auto zoom just won't see your clicks.
