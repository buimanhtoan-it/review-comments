# Review Comments

**Review code and documents without changing the source.**

Select a passage, leave a comment, and keep track of what still needs attention. When you are ready to hand off your feedback, copy it with file paths, source excerpts, and replies included.

Review Comments adds a review layer to files in your workspace. It works without a pull request, a Git repository, or an account. Comments are saved separately from the files you review.

By **ToanBui** · [Source code](https://github.com/buimanhtoan-it/review-comments) · [Report an issue](https://github.com/buimanhtoan-it/review-comments/issues) · [ISC license](LICENSE)

## Installation

Requires **VS Code 1.96 or newer**. The extension ID is **`ToanBui.toanbui-review-comments`**.

Once published, install **Review Comments** by **ToanBui** from the Extensions view, or run:

```powershell
code --install-extension ToanBui.toanbui-review-comments;
```

Before the Marketplace release, or to try a locally built version, run **Extensions: Install from VSIX…** in the Command Palette and select `toanbui-review-comments-1.0.1.vsix`. Reload the editor if prompted.

If you installed an earlier local build with the ID `ToanBui.review-comments` or `local-tools.review-comments`, uninstall that build before installing this one, then reload the editor. These builds share command and sidebar IDs and should not run together. Uninstalling the extension does not remove saved threads in your workspace's `.review-comments/` directory.

## What you can do

- **Comment where it matters.** Attach a discussion to selected text or the current line in code, Markdown, LaTeX, and other text files.
- **Leave whole-file feedback.** Add a file comment to a PDF, image, or other workspace file from the Explorer.
- **Keep track of feedback.** Reply, edit, resolve, or reopen discussions. Browse them by file and filter or search the sidebar.
- **Read without losing your place.** Open Quick Preview beside your editor, or use Go to Source to return to the commented text.
- **Share feedback with context.** Copy open comments or all comments as Markdown or JSON, or export them to a file.

A **thread** is one initial comment and its replies. **Open** means it has not been marked resolved; it may be a question, reminder, or request for changes. **Resolved** means you have marked it as handled. Resolving a thread does not delete it or change the source. Replying to a resolved thread does not reopen it; use **Reopen** when it needs attention again.

## Your first comment

1. Open a folder in VS Code and open a saved text file inside it.
2. Select the text you want to discuss. With no selection, the comment applies to the current line.
3. Right-click and choose **Add Comment**, or press **Ctrl+Alt+M** on Windows/Linux (**Cmd+Alt+M** on macOS).
4. Write your feedback and click **Save Comment**. You can also use **Ctrl+Enter** (**Cmd+Enter** on macOS); **Enter** adds a new line.
5. Open **Review Comments** in the Activity Bar to see your saved threads, grouped by file.

Click a thread in the sidebar to open **Quick Preview**. Use **Go to Source** to jump back to the text. You can reply in the inline discussion or in the preview.

If a thread already ends on the line you selected, **Add Comment** opens that discussion so you can reply instead of creating another thread there.

> Files must be inside an open workspace folder. Save an untitled file before commenting on it. Adding, editing, or resolving a comment never inserts text into the source file.

## Everyday examples

### Review a function before a handoff

In `src/average.ts`, select this return statement:

```typescript
export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
```

Add a comment:

> What should happen when `values` is empty? Please define the behavior and add a test for it.

After updating the function yourself, reply with what changed and choose **Resolve**. The discussion stays available if you need to **Reopen** it later.

### Review documentation or a manuscript

In a Markdown or LaTeX file, select an unclear sentence and add:

> Please define "active user" here. Does it mean someone who signed in, or someone who completed an action?

Use **Next Open Comment** to work through the remaining feedback. There is no need to insert `TODO` markers or review notes into the document itself.

### Leave feedback on a PDF or image

Right-click `docs/user-guide.pdf` in the Explorer and choose **Add File Comment**. Write:

> Page 3: the labels in the setup screenshot are too small. Please use a closer crop.

This is a note **about the whole file**. "Page 3" is part of your comment, not a clickable page annotation. Review Comments does not draw highlights on PDF pages or image regions, and it does not modify those files.

### Turn open feedback into a handoff

Run **Review Comments: Copy Open Comments**, then paste into an issue, a message to a teammate, or a writing/coding assistant you already use.

By default, the clipboard contains Markdown with:

- A summary of the copied threads.
- File paths and line/column locations for text comments.
- The saved source selection and, when available, a short excerpt of surrounding text.
- The comment and its replies, with authors and timestamps.
- A warning when the saved source location can no longer be matched or verified.

An example instruction to put before the pasted feedback:

> Address the open review comments below. Use the file paths and quoted text to locate each issue. If the source has changed, check the current content before editing. Summarize what you changed and flag anything that needs clarification.

Copying only puts text on your clipboard. It does not contact another service, apply edits, or resolve comments automatically. Inspect the copied excerpts before sharing them.

## Copy and export: choose the right scope

All commands below are available from the Command Palette with the **Review Comments:** prefix. Common actions also appear in the sidebar, editor title bar, and review action row above the first line of a text file.

- **Copy Thread** — the selected thread, including all its replies and saved source context.
- **Copy Open Comments** — every open thread across all folders in the current workspace, including its replies.
- **Copy All Comments** — all open and resolved threads across the workspace.
- **Copy All Comments in This File** — all threads for one file, including resolved threads; available by right-clicking the file group in the Comments sidebar or the file in the Explorer.
- **Copy Open Comments in This File** — only open threads for the selected file group, or the current file when run without a selection. The review action row calls this **Copy Open in This File**.
- **Copy Resolved Comments in This File** — only resolved threads for that file, including their replies.
- **Copy All Comments in This File as JSON** — all threads for that file as JSON, regardless of your default copy format.
- **Copy All Comments as JSON** — all threads as structured JSON, regardless of your default copy format.
- **Export Comments…** — choose all or open comments, choose Markdown or JSON, then save the result to a file.

**Sidebar filters and search do not limit Copy, Export, or Next/Previous Open Comment.** For example, filtering the sidebar to one matching file does not make **Copy Open Comments** a single-file action. Use a file-specific command for that.

Markdown locations are 1-based for reading. JSON positions are 0-based, use UTF-16 character offsets, and have an exclusive range end. JSON export is a structured handoff; there is no import command.

### Right-click a file group in the Comments sidebar

The parent row, such as `HocKy_2/cong_bo_1/paper.tex`, represents one source file, not a directory. Right-click it to copy **all**, **open**, or **resolved** threads in that file, or copy all of them **as JSON**. The menu also offers **Open Source File** and **Add File Comment**.

These actions target the file you right-clicked, even when another file is active in the editor. Copy includes saved replies and uses the latest loaded threads for that file, not just the rows currently visible after filtering/searching. With no matching threads, a status-bar message appears and the clipboard is left unchanged. The sidebar's top-level Copy buttons still apply to the whole workspace.

## Find and follow up

- **Filter Comments…** shows all, open, or resolved threads, or **Unverified source locations**, in the sidebar.
- **Search Comments…** searches file paths, comment and reply text, authors, and stored tags. **Clear Filters** resets both the status filter and search.
- **Next Open Comment** / **Previous Open Comment** move through open threads across the workspace, not just the active file or visible sidebar results.
- **Quick Preview** opens a scrollable panel where you can select text, reply, edit, and copy the full thread.
- **Collapse Inline Comments** collapses saved inline discussions without resolving or deleting them. It leaves new threads with unsaved comments, active comment edits, and pending saves expanded.
- **Attach to Current Selection…** updates a thread's source excerpt and location. First select the replacement text in the same file, then run the command and confirm. This replaces the old saved excerpt.
- **Delete Thread** deletes a thread and every reply after confirmation. **Delete Resolved Threads…** permanently removes resolved threads across the workspace, regardless of sidebar filters. These actions have no built-in undo.

The open count refers to **threads**, not individual replies. Default highlights distinguish open threads in yellow, the active thread in orange, and resolved threads with a dashed green border. A dotted red border warns that the saved source location needs checking. Colors can be customized.

### When a source location cannot be verified

The extension tries to keep a text comment attached to its saved passage as the file is edited. If the passage cannot be found unambiguously or cannot be checked during copy/export, the thread is marked **Location unverified**.

This warning asks you to check the location; it does not prove that the file was edited. A missing or unreadable source can also produce it. Disk verification during copy/export is limited to readable UTF-8 source files up to 16 MiB.

The saved source selection is captured when you create a thread. Only **Attach to Current Selection…** explicitly replaces that selection and its surrounding context; ordinary source edits do not. Copy/export uses the latest saved selection, which may differ from the one used when the initial comment was written. Surrounding context is a short excerpt, not the full paragraph or file.

### If an edit conflicts with a newer comment

Copy your unsaved draft first, then choose **Cancel** in that comment editor to load the latest version. Edit again and reconcile your draft with the newer text. Refreshing alone deliberately keeps your draft and its original editing baseline, so retrying the same save will not clear the conflict.

## Keyboard shortcuts

- **Add Comment:** `Ctrl+Alt+M` — macOS: `Cmd+Alt+M`.
- **Save a comment or reply:** `Ctrl+Enter` — macOS: `Cmd+Enter`, while the comment editor is focused.
- **Copy Open Comments:** `Ctrl+Alt+C` — macOS: `Cmd+Alt+C`, while a source editor or the Comments sidebar is focused.
- **Next Open Comment:** `Alt+F8`.
- **Previous Open Comment:** `Shift+Alt+F8`.

On macOS, Alt is the Option key. Your keyboard or system settings may also require Fn for F8. If another extension uses a shortcut, use the Command Palette or change the binding in Keyboard Shortcuts.

## Settings

Open Settings and search for `reviewComments`.

- **`reviewComments.author`** — name recorded on new comments and replies. Default: `Reviewer`. Changing it does not rename existing comments; it is a label, not a verified identity.
- **`reviewComments.copyFormat`** — default format for Copy commands: `markdown` or `json`. Default: `markdown`.
- **`reviewComments.sidebarClickAction`** — open `preview` or jump to `source` when you click a sidebar thread. Default: `preview`.
- **`reviewComments.toolbar`** — show the review action row `whenComments` exist, `always`, or turn it `off`. Default: `whenComments`. Requires `editor.codeLens` to be enabled.
- **`reviewComments.titleButtons`** — show copy and review-action buttons in the editor title bar. Default: `true`.
- **`reviewComments.statusBar`** — show open-thread counts and a shortcut to review actions. Default: `true`.
- **`reviewComments.highlights`** — outline commented text and show scrollbar markers. Default: `true`.
- **`reviewComments.highlightResolved`** — also highlight resolved threads. Default: `true`.
- **`reviewComments.copyNotifications`** — show an additional notification after copying. Default: `false`; a brief status-bar message already confirms the copy.

## Storage and sharing

Each saved thread is a JSON file under `.review-comments/threads/` in the workspace folder that contains the reviewed file. In a remote workspace, storage is on that remote filesystem, not necessarily on your computer. Use **Open Comment Storage** to reveal it.

- No account, external review service, or telemetry is built into this extension.
- Stored threads and exports can include source excerpts, nearby text, file paths, author names, and timestamps. They are not encrypted by the extension; multi-folder JSON exports also include workspace root URIs.
- To share editable threads, deliberately include `.review-comments/threads/` with the corresponding project files. There is no built-in live collaboration, cloud sync, or pull-request synchronization.
- To keep notes out of Git, add `.review-comments/` to your project's `.gitignore`. This does not remove files that Git already tracks or prevent other backup/sync tools from copying them.
- Saved comments persist when you close the editor. Unsaved drafts in Quick Preview are kept only while that panel stays open; save them before closing it.

## Requirements and limits

- VS Code **1.96 or newer**, with a local or remote filesystem workspace. Browser-only/virtual workspaces and untitled files are not supported.
- Inline comments require a text document. PDFs, images, and other non-text files receive whole-file comments only; the installed editor/viewer determines how those files open.
- Comment bodies are displayed as plain text, not rendered Markdown.
- File renames made through the editor are tracked within the same workspace folder. Renames outside the editor and moves between workspace folders are not guaranteed to follow automatically.
- Review Comments manages feedback. It does not edit your source, verify that a fix is correct, or automatically mark feedback as resolved.

## Development and packaging

Use **Node.js 22 or newer** and npm. From the repository root, run each command after the previous one succeeds:

```powershell
npm ci;
npm test;
npm run package;
```

`npm run package` compiles the TypeScript source and creates `toanbui-review-comments-1.0.1.vsix`. Only the manifest, README, license, compiled runtime, media, and JSON schemas are included. Source maps, tests, local review data, development settings, and credentials are not part of the package.

Open this project in VS Code and press **F5** to launch an Extension Development Host. To run the integration suite in a disposable VS Code workspace:

```powershell
npm run test:integration;
```

By default, integration tests use VS Code **1.96.4** to check the minimum supported release line. Set `VSCODE_TEST_VERSION` to another version or `stable` to test a downloaded release. To use an existing VS Code installation, set `VSCODE_EXECUTABLE_PATH` to its executable; this takes precedence over the version setting. Tests still use a temporary workspace, profile, and extensions directory.

To exercise a packaged extension rather than the source build, also set `REVIEW_COMMENTS_EXTENSION_PATH` to the installed extension directory. Its version must match this project's `package.json`. Unset these variables after testing to return to the defaults.

### Publishing (maintainer)

Review Comments is a separate extension from [Combine Code in Folder](https://github.com/buimanhtoan-it/combine-code-in-folder). Its Marketplace identity is `ToanBui.toanbui-review-comments`; do not reuse `combine-code-in-folder` as the package name.

1. Create `buimanhtoan-it/review-comments` on GitHub if it does not exist, then push this project's source there. The repository, homepage, and issue links in `package.json` target that repository.
2. Confirm the publisher is `ToanBui` and the version has not already been published. For later releases, update both `package.json` and `package-lock.json`, for example with `npm version patch --no-git-tag-version`.
3. Run the tests, build the VSIX, and install it in the editor for a smoke test.
4. Upload the VSIX through [Manage Publishers & Extensions](https://marketplace.visualstudio.com/manage) under **ToanBui**, or authenticate and publish from this folder:

```powershell
npx vsce login ToanBui;
npm run publish:marketplace;
```

The publish command uploads the extension to the Visual Studio Marketplace; `npm run package` only builds a local file. Do **not** use `npm publish`. Keep access tokens out of source files and Git. Authentication must use an account with permission to publish under `ToanBui`; see the [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

The CLI login above uses a Personal Access Token (PAT). Microsoft has announced the retirement of global Azure DevOps PATs on **December 1, 2026**; for automated publishing, follow the official guide's Microsoft Entra ID authentication flow instead of setting up a long-lived PAT.

## Feedback

Report bugs or request features in [GitHub Issues](https://github.com/buimanhtoan-it/review-comments/issues). Include your VS Code version, extension version, and steps to reproduce. Remove private source excerpts and personal information before attaching stored threads or exports.

## Support This Project

If you find Review Comments useful, consider supporting its development. Your support helps me maintain the project, fix bugs, and build new features.

[![Buy me a coffee on Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/buimanhtoanit)

Thank you for your support!

## License

[ISC](LICENSE) — Copyright (c) 2026 Toan Bui.
