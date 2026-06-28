import { App, Modal, Notice, Setting, ButtonComponent } from "obsidian";
import { ManualSyncPreview, FitSync } from "./fitSync";
import { FileChange, FileClash } from "./util/changeTracking";
import { SyncResult } from "./syncResult";

type ManualSection = "local" | "remote";

export class ManualSyncModal extends Modal {
	private fitSync: FitSync;
	private preview: ManualSyncPreview | null = null;
	private selectedLocal = new Set<string>();
	private selectedRemote = new Set<string>();
	private commitMessage = "Update vault";
	private commitInput: HTMLTextAreaElement | null = null;
	private statusEl: HTMLElement | null = null;
	private pushButton: ButtonComponent | null = null;
	private pullButton: ButtonComponent | null = null;

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
		this.prepareContent();
		this.statusEl = new Setting(this.contentEl)
			.setName("Status")
			.setDesc("Scanning changes...")
			.descEl;
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
		this.prepareContent();

		this.statusEl = new Setting(contentEl)
			.setName("Status")
			.setDesc(this.getSummaryStatus())
			.addButton(button => button
				.setButtonText("Scan")
				.onClick(() => this.refresh()))
			.addButton(button => {
				this.pullButton = button;
				button.setButtonText("Pull selected").onClick(() => this.pullSelected());
			})
			.addButton(button => {
				this.pushButton = button;
				button.setCta().setButtonText("Push selected").onClick(() => this.pushSelected());
			})
			.descEl;

		new Setting(contentEl)
			.setName("Commit message")
			.setDesc("Used when pushing selected local changes.")
			.addTextArea(text => {
				text.setValue(this.commitMessage)
					.onChange(value => { this.commitMessage = value; });
				this.commitInput = text.inputEl;
				text.inputEl.addClass("fit-manual-commit-input");
			});

		this.renderChangeSection("local", "Local changes to push", this.preview.safeLocal, contentEl);
		this.renderChangeSection("remote", "Remote changes to pull", this.preview.safeRemote, contentEl);
		this.renderConflictSection(this.preview.clashes, contentEl);
		this.updateActionButtons();
	}

	private renderChangeSection(section: ManualSection, title: string, changes: FileChange[], container: HTMLElement) {
		new Setting(container)
			.setHeading()
			.setName(`${title} (${changes.length})`)
			.setDesc(this.getSectionDescription(section))
			.addButton(button => button
				.setButtonText("All")
				.onClick(() => {
					this.setSelected(section, changes.map(change => change.path));
					this.render();
				}))
			.addButton(button => button
				.setButtonText("None")
				.onClick(() => {
					this.setSelected(section, []);
					this.render();
				}));

		if (changes.length === 0) {
			container.createDiv({ text: "No changes.", cls: "fit-manual-empty" });
			return;
		}

		const list = container.createDiv({ cls: "fit-manual-list" });
		for (const change of changes) {
			const item = list.createEl("label", { cls: "fit-manual-row" });
			const checkbox = item.createEl("input", { attr: { type: "checkbox" } });
			checkbox.checked = this.getSelected(section).has(change.path);
			checkbox.addEventListener("change", () => {
				const selected = this.getSelected(section);
				if (checkbox.checked) {
					selected.add(change.path);
				} else {
					selected.delete(change.path);
				}
				this.updateActionButtons();
			});
			this.createOperationBadge(item, change.type);
			item.createSpan({ text: change.path, cls: "fit-manual-path" });
		}
	}

	private renderConflictSection(clashes: FileClash[], container: HTMLElement) {
		new Setting(container)
			.setHeading()
			.setName(`Conflicts and blocked files (${clashes.length})`)
			.setDesc("Resolve these files outside this dialog before syncing them.");

		if (clashes.length === 0) {
			container.createDiv({ text: "No conflicts.", cls: "fit-manual-empty" });
			return;
		}
		const list = container.createDiv({ cls: "fit-manual-list" });
		for (const clash of clashes) {
			const item = list.createDiv({ cls: "fit-manual-row fit-manual-conflict" });
			this.createOperationBadge(item, clash.localState);
			this.createOperationBadge(item, clash.remoteOp);
			item.createSpan({ text: clash.path, cls: "fit-manual-path" });
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
		const message = this.commitInput?.value.trim() ?? this.commitMessage.trim();
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
		this.prepareContent();
		const message = error instanceof Error ? error.message : String(error);
		this.statusEl = new Setting(this.contentEl)
			.setName("Status")
			.setDesc(`Failed to scan changes: ${message}`)
			.addButton(button => button
				.setCta()
				.setButtonText("Retry")
				.onClick(() => this.refresh()))
			.descEl;
	}

	private setStatus(message: string) {
		if (this.statusEl) {
			this.statusEl.textContent = message;
		}
	}

	private prepareContent() {
		this.setTitle("Manual sync");
		this.modalEl.addClass("fit-manual-modal");
		this.contentEl.addClass("fit-manual-content");
		this.contentEl.empty();
		this.commitInput = null;
		this.pushButton = null;
		this.pullButton = null;
	}

	private createOperationBadge(parent: HTMLElement, operation: string) {
		const operationClass = operation.toLowerCase();
		parent.createSpan({
			text: this.formatOperation(operation),
			cls: `fit-manual-op fit-manual-op-${operationClass}`
		});
	}

	private formatOperation(operation: string): string {
		return operation.charAt(0).toUpperCase() + operation.slice(1).toLowerCase();
	}

	private getSummaryStatus(): string {
		if (!this.preview) {
			return "Scanning changes...";
		}
		return `${this.preview.safeLocal.length} local, ${this.preview.safeRemote.length} remote, ${this.preview.clashes.length} blocked.`;
	}

	private getSectionDescription(section: ManualSection): string {
		return section === "local"
			? "Choose files to commit and push to the remote vault."
			: "Choose remote updates to apply to this vault.";
	}

	private updateActionButtons() {
		this.pushButton?.setDisabled(this.selectedLocal.size === 0);
		this.pullButton?.setDisabled(this.selectedRemote.size === 0);
	}
}
