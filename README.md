Steps to start the dev server:

```bash
pnpm dev
```

what this command does under the hood

```bash
pnpm dev:react
```

Then in another terminal

```bash
pnpm transpile:electron
pnpm dev:electron
```

Steps to create a production build

```bash
pnpm build
pnpm transpile:electron
pnpm dist:win
```

dist:<system name> can be used to build the app for that particular system
