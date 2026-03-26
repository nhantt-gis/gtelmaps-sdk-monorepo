# GTEL Maps SDK: Development & Maintenance Guide

This document defines the professional workflow for managing, customizing, and maintaining forked packages within the GTEL Maps SDK monorepo.

---

## 1. Forked Package Lifecycle

Maintaining a fork requires ensuring custom modifications persist at the top of the history while facilitating seamless updates when new upstream versions are released.

### Initial Setup (First-time)

Fork the repository on GitHub/GitLab, then prepare your custom development branch:

```bash
# 1. Clone your fork locally (temporarily)
git clone [MAIN_REPO_URL] temp-folder
cd temp-folder

# 2. Add the upstream repository and fetch tags
git remote add upstream [UPSTREAM_REPO_URL]
git fetch upstream --tags

# 3. Connect to the main project (origin) and push
git remote set-url origin [MAIN_REPO_URL]
git push origin HEAD

# 4. Create a custom branch from a stable tag (e.g., v1.0.0)
git checkout tags/v1.0.0 -b dev-v1.0.0-gtelmaps
git push origin dev-v1.0.0-gtelmaps
```

After setup, add the package to the main project as a submodule:

```bash
git submodule add -b dev-v1.0.0-gtelmaps [MAIN_REPO_URL] [path/to/submodule]
```

### Daily Development & Customization

When modifying code within a forked package:

1. **Enter the submodule directory:** `cd [path/to/submodule]`
2. **Commit changes:**
   ```bash
   git add .
   git commit -m "feat(gtelmaps): implement custom logic"
   git push origin dev-v1.0.0-gtelmaps
   ```
3. **Update Main Project:** Return to the monorepo root, stage the submodule change, and commit the new pointer.

---

## 2. Maintenance & Upgrades

When the upstream repository releases a new tag (e.g., `v1.1.0`), follow this clean upgrade flow:

### Step 1: Prepare the Submodule

```bash
cd [path/to/submodule]
git fetch upstream --tags
```

### Step 2: Create a New Version Branch

Create a new branch from your current development branch to ensure safety:

```bash
# From current branch (v1.0.0)
git checkout dev-v1.0.0-gtelmaps
# Create new version branch (v1.1.0)
git checkout -b dev-v1.1.0-gtelmaps
```

### Step 3: Rebase Custom Commits

Replay your custom commits on top of the new upstream tag:

```bash
git rebase tags/v1.1.0
```

_If conflicts occur: Resolve files -> `git add .` -> `git rebase --continue`._

### Step 4: Push to Fork

Since rebase modifies history, a force push is required:

```bash
git push origin dev-v1.1.0-gtelmaps --force-with-lease
```

---

## 3. Submodule & Subtree Management

The SDK relies on Git submodules for its core components while using git subtree for specific nested modules.

### 3.1. Submodule Management

The SDK relies on Git submodules for its core components.

#### Register and Install Submodules

Use these commands to register and clone required SDK components as submodules:

```bash
git submodule add -b dev-v1.0.0-gtelmaps [MAIN_REPO_URL] [path/to/submodule]
```

#### Update Submodules

To update all submodules to the commit currently registered in the main repository:

```bash
git pull origin main
git submodule update --init --recursive
pnpm install
```

To update all submodules to the latest commit on their respective branches (use with caution):

```bash
git submodule update --remote --recursive
```

#### Check Submodule Status

```bash
git submodule status
```

#### Remove Submodules

To completely unregister and remove a submodule from the project history and filesystem:

```bash
git submodule deinit -f [path/to/submodule]
git rm -f --cached [path/to/submodule]
rm -rf .git/modules/[path/to/submodule]
```

### 3.2. Technical Integration Utility (Subtree)

For specific nested modules, use git subtree for better integration into a subdirectory:

#### Register and Install Subtrees

```bash
cd [path/to/submodule]
git remote add [TREE_NAME] [TREE_REPO_URL]
git subtree add --prefix=[path/to/subtree] [TREE_NAME] dev-v1.0.0-gtelmaps --squash
```

#### Remove Subtree

```bash
cd [path/to/submodule]
git rm -r [path/to/subtree]
git remote remove [TREE_NAME]
```
