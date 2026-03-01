# How-To: Installing Asciinema for Recording

Use this guide to install Asciinema and produce a `.cast` recording file that can be uploaded through the landing-page admin console.

## Installing

### macOS (Homebrew)

```bash
brew install asciinema
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y asciinema
```

### Fedora / RHEL

```bash
sudo dnf install -y asciinema
```

### Python (cross-platform fallback)

```bash
python3 -m pip install --user asciinema
```

If installed with `pip --user`, ensure your user bin path is in `PATH`.

## Verify Installation

```bash
asciinema --version
```

You should see a version output such as `asciinema 2.x`.

## Record a Session

From your project root:

```bash
asciinema rec onboarding-demo.cast
```

- Run the terminal workflow you want to demonstrate.
- Press `Ctrl+D` or type `exit` to stop recording.
- Confirm that `onboarding-demo.cast` was created.

## Keep Recording Size Compatible

The admin upload endpoint limits files to 5 MB.

Tips:
- Keep recordings concise.
- Avoid very long sessions.
- Prefer fewer repeated commands.

## Optional: Local Playback Test

```bash
asciinema play onboarding-demo.cast
```

This lets you validate the recording before upload.
