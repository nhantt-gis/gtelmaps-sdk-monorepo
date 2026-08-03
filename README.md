# GTEL Maps SDK Monorepo

This monorepo manages the core components of the GTEL Maps SDK, including rendering tools, style specifications, and customized client libraries. 
It serves as the central hub for the synchronized development and maintenance of all components within the GTEL map ecosystem.

---
## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [pnpm](https://pnpm.io/) (v8 or later)
- [Git](https://git-scm.com/)

### Clone and Install

To clone the repository with all its submodules and install dependencies:

```bash
# Clone the repository with submodules
git clone --recursive git@github.com:gtelmaps/gtelmaps-sdk-monorepo.git
cd gtelmaps-sdk-monorepo

# Install dependencies
pnpm install
```

If you have already cloned the repository without submodules, run:

```bash
git submodule update --init --recursive
pnpm install
```

## What's inside?

This Turborepo includes the following packages/apps:

### Apps and Packages

This repository contains forked and customized packages for the GTEL Maps SDK:

- [gtelmaps-gl-js](https://github.com/gtelmaps/gtelmaps-gl-js): The core map rendering engine.
- [gtelmaps-style-spec](https://github.com/gtelmaps/gtelmaps-style-spec): The style specification for the map.
- [gtelmaps-sdk-js](https://github.com/gtelmaps/gtelmaps-sdk-js): The SDK for the map.
- [gtelmaps-client-js](https://github.com/gtelmaps/gtelmaps-client-js): The client for the map.

Each package/app is 100% [TypeScript](https://www.typescriptlang.org/).

### Utilities

This Turborepo has some additional tools already setup for you:

- [TypeScript](https://www.typescriptlang.org/) for static type checking
- [ESLint](https://eslint.org/) for code linting
- [Prettier](https://prettier.io) for code formatting

### Build

To build all apps and packages, run the following command:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
turbo build
```

Without global `turbo`, use your package manager:

```sh
npx turbo build
yarn dlx turbo build
pnpm exec turbo build
```

### Updating

To pull the latest changes from the main repository and update all submodules:

```bash
# Pull main repo changes
git pull origin main

# Update all submodules to match the new pointers
git submodule update --init --recursive

# Install/Update dependencies
pnpm install
```

You can build a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo build --filter=gtelmaps-gl-js
```

Without global `turbo`:

```sh
npx turbo build --filter=gtelmaps-gl-js
yarn exec turbo build --filter=gtelmaps-gl-js
pnpm exec turbo build --filter=gtelmaps-gl-js
```

### Develop

To develop all apps and packages, run the following command:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
turbo dev
```

Without global `turbo`, use your package manager:

```sh
npx turbo dev
yarn exec turbo dev
pnpm exec turbo dev
```

You can develop a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo dev --filter=gtelmaps-gl-js
```

Without global `turbo`:

```sh
npx turbo dev --filter=gtelmaps-gl-js
yarn exec turbo dev --filter=gtelmaps-gl-js
pnpm exec turbo dev --filter=gtelmaps-gl-js
```

### Remote Caching

> [!TIP]
> Vercel Remote Cache is free for all plans. Get started today at [vercel.com](https://vercel.com/signup?utm_source=remote-cache-sdk&utm_campaign=free_remote_cache).

Turborepo can use a technique known as [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching) to share cache artifacts across machines, enabling you to share build caches with your team and CI/CD pipelines.

By default, Turborepo will cache locally. To enable Remote Caching you will need an account with Vercel. If you don't have an account you can [create one](https://vercel.com/signup?utm_source=turborepo-examples), then enter the following commands:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
turbo login
```

Without global `turbo`, use your package manager:

```sh
npx turbo login
yarn exec turbo login
pnpm exec turbo login
```

This will authenticate the Turborepo CLI with your [Vercel account](https://vercel.com/docs/concepts/personal-accounts/overview).

Next, you can link your Turborepo to your Remote Cache by running the following command from the root of your Turborepo:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo link
```

Without global `turbo`:

```sh
npx turbo link
yarn exec turbo link
pnpm exec turbo link
```

## Useful Links

Learn more about the power of Turborepo:

- [Tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks)
- [Caching](https://turborepo.dev/docs/crafting-your-repository/caching)
- [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching)
- [Filtering](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters)
- [Configuration Options](https://turborepo.dev/docs/reference/configuration)
- [CLI Usage](https://turborepo.dev/docs/reference/command-line-reference)
