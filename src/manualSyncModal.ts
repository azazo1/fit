import { App, Modal, Notice } from "obsidian";
import { ManualSyncPreview, FitSync } from "./fitSync";
import { FileChange, FileClash } from "./util/changeTracking";
import { SyncResult } from "./syncResult";

type ManualSection = "local" | "remote";

export class ManualSyncModal extends Modal {
	private fitSync: FitSync;
	private preview: ManualSyncPreview | null = null;
	private selectedLocal = new Set<string>();
	private selectedRemote = new Set<string>();
	private commitInput: HTMLTextAreaElement | null = null;
	private statusEl: HTMLElement | null = null;
	private localListEl: HTMLElement | null = null;
	private remoteListEl: HTMLElement | null = null;
	private conflictListEl: HTMLElement | null = null;

	constructor(app: App, fitSync: FitSync) {
		super(app);
		this.fitSync = fitSync;
	}

	onOpen() {
		this.renderLoading();
		this.refresh();
	}

	onClose() {
		this.contentEl.empty();
	}

	private renderLoading() {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Manual sync" });
		this.statusEl = this.contentEl.createEl("p", { text: "Scanning changes...", cls: "fit-manual-status" });
	}

	private async refresh() {
		try {
			this.preview = await this.fitSync.previewManualSync();
			this.selectedLocal = new Set(this.preview.safeLocal.map(change => change.path));
			this.selectedRemote = new Set(this.preview.safeRemote.map(change => change.path));
			this.render();
		} catch (error) {
			this.renderError(error);
		}
	}

	private render() {
		if (!this.preview) return;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Manual sync" });
		this.statusEl = contentEl.createEl("p", { cls: "fit-manual-status" });
		this.setStatus("Select files, write a commit message, then push or pull.");

		const controls = contentEl.createDiv({ cls: "fit-manual-controls" });
		const refreshButton = controls.createEl("button", { text: "Scan" });
		refreshButton.addEventListener("click", () => this.refresh());
		const pushButton = controls.createEl("button", { text: "Push selected" });
		pushButton.addEventListener("click", () => this.pushSelected());
		const pullButton = controls.createEl("button", { text: "Pull selected" });
		pullButton.addEventListener("click", () => this.pullSelected());

		const messageWrap = contentEl.createDiv({ cls: "fit-manual-message" });
		messageWrap.createEl("label", { text: "Commit message" });
		this.commitInput = messageWrap.createEl("textarea");
		this.commitInput.value = "Update vault";

		this.localListEl = contentEl.createDiv({ cls: "fit-manual-section" });
		this.remoteListEl = contentEl.createDiv({ cls: "fit-manual-section" });
		this.conflictListEl = contentEl.createDiv({ cls: "fit-manual-section" });
		this.renderChangeSection("local", "Local changes to push", this.preview.safeLocal, this.localListEl);
		this.renderChangeSection("remote", "Remote changes to pull", this.preview.safeRemote, this.remoteListEl);
		this.renderConflictSection(this.preview.clashes);
	}

	private renderChangeSection(section: ManualSection, title: string, changes: FileChange[], container: HTMLElement) {
		container.empty();
		const header = container.createEl("h3", { text: `${title} (${changes.length})` });
		const buttonRow = container.createDiv({ cls: "fit-manual-section-actions" });
		const allButton = buttonRow.createEl("button", { text: "All" });
		allButton.addEventListener("click", () => {
			this.setSelected(section, changes.map(change => change.path));
			this.render();
		});
		const noneButton = buttonRow.createEl("button", { text: "None" });
		noneButton.addEventListener("click", () => {
			this.setSelected(section, []);
			this.render();
		});

		if (changes.length === 0) {
			container.createEl("p", { text: "No changes.", cls: "fit-manual-empty" });
			return;
		}

		const list = container.createEl("ul", { cls: "fit-manual-list" });
		for (const change of changes) {
			const item = list.createEl("li", { cls: "fit-manual-row" });
			const label = item.createEl("label");
			const checkbox = label.createEl("input", { type: "checkbox" });
			checkbox.checked = this.getSelected(section).has(change.path);
			checkbox.addEventListener("change", () => {
				const selected = this.getSelected(section);
				if (checkbox.checked) {
					selected.add(change.path);
				} else {
					selected.delete(change.path);
				}
			});
			label.createSpan({ text: ` ${change.type} `, cls: "fit-manual-op" });
			label.createEl("code", { text: change.path });
		}
		header.setText(`${title} (${changes.length})`);
	}

	private renderConflictSection(clashes: FileClash[]) {
		if (!this.conflictListEl) return;
		this.conflictListEl.empty();
		this.conflictListEl.createEl("h3", { text: `Conflicts and blocked files (${clashes.length})` });
		if (clashes.length === 0) {
			this.conflictListEl.createEl("p", { text: "No conflicts.", cls: "fit-manual-empty" });
			return;
		}
		const list = this.conflictListEl.createEl("ul", { cls: "fit-manual-list" });
		for (const clash of clashes) {
			const item = list.createEl("li", { cls: "fit-manual-row fit-manual-conflict" });
			item.createSpan({ text: `${clash.localState} / ${clash.remoteOp} `, cls: "fit-manual-op" });
			item.createEl("code", { text: clash.path });
		}
	}

	private getSelected(section: ManualSection): Set<string> {
		return section === "local" ? this.selectedLocal : this.selectedRemote;
	}

	private setSelected(section: ManualSection, paths: string[]) {
		if (section === "local") {
			this.selectedLocal = new Set(paths);
		} else {
			this.selectedRemote = new Set(paths);
		}
	}

	private async pushSelected() {
		const paths = Array.from(this.selectedLocal);
		const message = this.commitInput?.value.trim() ?? "";
		if (paths.length === 0) {
			this.setStatus("No local files selected.");
			return;
		}
		if (!message) {
			this.setStatus("Commit message is required.");
			return;
		}
		this.setStatus("Pushing selected local changes...");
		const result = await this.fitSync.pushManualSelection(paths, message);
		this.handleResult(result, "Push complete.");
	}

	private async pullSelected() {
		const paths = Array.from(this.selectedRemote);
		if (paths.length === 0) {
			this.setStatus("No remote files selected.");
			return;
		}
		this.setStatus("Pulling selected remote changes...");
		const result = await this.fitSync.pullManualSelection(paths);
		this.handleResult(result, "Pull complete.");
	}

	private handleResult(result: SyncResult, successMessage: string) {
		if (!result.success) {
			const message = "message" in result.error
				? result.error.message
				: result.error.detailMessage;
			this.setStatus(`Failed: ${message}`);
			new Notice(`Manual sync failed: ${message}`);
			return;
		}
		const changed = result.changeGroups.reduce((count, group) => count + group.changes.length, 0);
		this.setStatus(`${successMessage} ${changed} file operation(s).`);
		new Notice(`${successMessage} ${changed} file operation(s).`);
		this.refresh();
	}

	private renderError(error: unknown) {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Manual sync" });
		const message = error instanceof Error ? error.message : String(error);
		this.contentEl.createEl("p", { text: `Failed to scan changes: ${message}`, cls: "fit-manual-status" });
		const retryButton = this.contentEl.createEl("button", { text: "Retry" });
		retryButton.addEventListener("click", () => this.refresh());
	}

	private setStatus(message: string) {
		if (this.statusEl) {
			this.statusEl.setText(message);
		}
	}
}
