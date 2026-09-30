/**
 * NoteIn — ファイルベースのメモアプリ
 * IndexedDB でファイルハンドルを永続化し、リロード後も復元する。
 */

// iOS Safari など File System Access API を持たないブラウザでは、ディスク上のファイルを扱えないため
// メモ本体を IndexedDB のレコード（content）に保持し、handle を持たない「ローカルファイル」として扱う。
const SUPPORTS_FILE_SYSTEM_ACCESS = 'showOpenFilePicker' in window;

// ═══════════════════════════════════════════
// IndexedDB ラッパー
// ═══════════════════════════════════════════
class FileHandleStore {
    constructor() {
        this.DB_NAME    = 'notein-db';
        this.STORE_NAME = 'file-handles';
        this.db = null;
    }

    open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                }
            };
            req.onsuccess = e => { this.db = e.target.result; resolve(); };
            req.onerror   = e => reject(e.target.error);
        });
    }

    _tx(mode) { return this.db.transaction(this.STORE_NAME, mode).objectStore(this.STORE_NAME); }

    getAll() {
        return new Promise((resolve, reject) => {
            const req = this._tx('readonly').getAll();
            req.onsuccess = () => resolve(req.result ?? []);
            req.onerror   = () => reject(req.error);
        });
    }

    put(record) {
        return new Promise((resolve, reject) => {
            const req = this._tx('readwrite').put(record);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    delete(id) {
        return new Promise((resolve, reject) => {
            const req = this._tx('readwrite').delete(id);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }
}

// ═══════════════════════════════════════════
// メインアプリ
// ═══════════════════════════════════════════
class NoteIn {
    constructor() {
        this.store        = new FileHandleStore();
        this.files        = [];   // { id, handle | content, name, addedAt, permissionGranted }
        this.activeFileId = null;
        this.saveTimeout  = null;
        this.isSaving     = false;
        this.isPreviewMode = false;
        this.lastSavedContent = ""; // 差分チェック用
        this.blocks       = [];     // ブロックごとのデータ
        this.MAX_TASK_DEPTH = 5;

        // 元に戻す/やり直し用のスタック
        this.historyStack = [];
        this.redoStack    = [];
        this.isRestoringHistory = false;

        this.el = {
            noteList:         document.getElementById('note-list'),
            addFileBtn:       document.getElementById('add-file-btn'),
            newNoteBtn:       document.getElementById('new-note-btn'),
            searchInput:      document.getElementById('search-input'),
            emptyState:       document.getElementById('editor-empty-state'),
            activeState:      document.getElementById('editor-active-state'),
            titleInput:       document.getElementById('note-title-input'),
            contentInput:     document.getElementById('note-content-input'),
            blockContainer:   document.getElementById('block-editor-container'),
            globalAddBlockBtn: document.getElementById('global-add-block-btn'),
            previewArea:      document.getElementById('markdown-preview'),
            togglePreviewBtn: document.getElementById('toggle-preview-btn'),
            saveBtn:          document.getElementById('save-btn'),
            charCount:        document.getElementById('char-count'),
            lastSavedTime:    document.getElementById('last-saved-time'),
            filePathInfo:     document.getElementById('file-path-info'),
            exportBtn:        document.getElementById('export-btn'),
            backToListBtn:    document.getElementById('back-to-list-btn'),
            emptyMessage:     document.getElementById('empty-message'),
            emptySub:         document.getElementById('empty-sub'),
            editLabel:        document.querySelector('.edit-label'),
            previewLabel:     document.querySelector('.preview-label'),
            subjectIndicator: document.getElementById('subject-indicator'),
            subjectProgress:  document.getElementById('subject-progress'),

            // Section Settings Dialog
            dialog: {
                el: document.getElementById('block-settings-dialog'),
                input: document.getElementById('dialog-heading-input'),
                closeBtn: document.getElementById('dialog-close-btn'),
                cancelBtn: document.getElementById('dialog-cancel-btn'),
                saveBtn: document.getElementById('dialog-save-btn'),
                deleteBtn: document.getElementById('dialog-delete-btn')
            },
            // Image Preview Dialog
            imageDialog: {
                el: document.getElementById('image-preview-dialog'),
                img: document.getElementById('image-dialog-img'),
                caption: document.getElementById('image-dialog-caption'),
                closeBtn: document.getElementById('image-dialog-close-btn')
            },
            currentEditingBlockId: null
        };

        this.init();
    }

    async init() {
        await this.store.open();
        await this.restoreFromDB();
        this.bindEvents();
        this.applyStorageMode();
        this.registerServiceWorker();
    }

    applyStorageMode() {
        if (SUPPORTS_FILE_SYSTEM_ACCESS) return;
        document.body.classList.add('local-storage-mode');
        this.el.addFileBtn.title = 'ファイルを取り込む';
        this.el.newNoteBtn.title = '新規メモを作成';
        this.el.titleInput.title = 'Enterキーでメモの名前を変更';
        this.el.emptyMessage.textContent = '右上の「＋」でメモを作成してください';
        this.el.emptySub.textContent = 'メモはこの端末のブラウザ内に保存されます';
        // ストレージ逼迫時に Safari がデータを消さないよう永続化を要求する（拒否されても動作は続行）
        navigator.storage?.persist?.().catch(() => {});
    }

    registerServiceWorker() {
        if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker 登録失敗:', err));
    }

    // ───────────────────────────────────────
    // DB からハンドルを復元
    // ───────────────────────────────────────
    async restoreFromDB() {
        const records = await this.store.getAll();
        records.sort((a, b) => a.addedAt - b.addedAt);

        this.files = [];
        for (const rec of records) {
            // ページロード時は queryPermission（ユーザー操作不要）で状態確認
            let permissionGranted = !rec.handle;
            if (rec.handle) {
                try {
                    const status = await rec.handle.queryPermission({ mode: 'readwrite' });
                    permissionGranted = (status === 'granted');
                } catch { /* handle が無効 → permissionGranted = false */ }
            }
            this.files.push({ ...rec, permissionGranted });
        }
        this.renderFileList();
    }

    bindEvents() {
        // 未保存変更がある場合にブラウザを閉じる/リロードする際の警告
        window.addEventListener('beforeunload', (e) => {
            const hasUnsavedChanges = this.files.some(file => file.isDirty);
            if (hasUnsavedChanges) {
                e.preventDefault();
                e.returnValue = ''; // 標準ダイアログを表示
            }
        });

        this.el.addFileBtn.addEventListener('click',   () => this.addFiles());
        this.el.newNoteBtn.addEventListener('click',   () => this.createNewFile());
        this.el.togglePreviewBtn.addEventListener('click', () => this.togglePreview());
        this.el.saveBtn.addEventListener('click',      () => this.saveActiveFile());
        this.el.exportBtn.addEventListener('click',    () => this.exportActiveFile());
        this.el.backToListBtn.addEventListener('click', () => document.body.classList.remove('show-editor'));

        // iOS はバックグラウンド移行後にタブを破棄することがあり beforeunload も発火しないため、隠れた時点で下書きを永続化する
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.persistActiveDraft();
        });
        this.el.contentInput.addEventListener('input', () => this.handleInput());
        this.el.searchInput.addEventListener('input',  e  => this.renderFileList(e.target.value));
        
        // ファイル名変更 (Enterキー)
        this.el.titleInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                // blur ハンドラが入力値を元の名前に戻すため、先に取り出しておく
                const newName = this.el.titleInput.value;
                this.el.titleInput.blur();
                this.renameActiveFile(newName);
            }
        });
        
        // フォーカスが外れた時に元に戻す（未保存の入力キャンセル）
        this.el.titleInput.addEventListener('blur', () => {
            if (this.activeFileId) {
                const file = this.files.find(f => f.id === this.activeFileId);
                if (file && this.el.titleInput.value !== file.name) {
                    this.el.titleInput.value = file.name;
                }
            }
        });

        // Ctrl+S / Cmd+S で手動保存
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.saveActiveFile();
            }
        });

        // 選択された複数項目のコピー機能 (Ctrl+C / Cmd+C)
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                // コピー対象があるかどうか探す
                const selectedTasks = this.el.blockContainer.querySelectorAll('.task-selected');
                const selectedBlocks = this.el.blockContainer.querySelectorAll('.block-selected');
                
                if (selectedTasks.length > 0 || selectedBlocks.length > 0) {
                    e.preventDefault(); // デフォルトのコピーをキャンセル

                    // DOM上で上から表示されている順に取得するために全体から拾ってフィルタする
                    const copyTexts = [];
                    
                    const blockEls = this.el.blockContainer.querySelectorAll('.note-block');
                    blockEls.forEach(blockEl => {
                        if (blockEl.classList.contains('block-selected')) {
                            // ブロックまるごと選択されている場合は見出しを追加（ハッシュや記号なし）
                            const title = blockEl.querySelector('.block-title-input').value;
                            copyTexts.push(title);
                        }
                        
                        const tasks = blockEl.querySelectorAll('.task-item');
                        tasks.forEach(taskEl => {
                            if (taskEl.classList.contains('task-selected') || blockEl.classList.contains('block-selected')) {
                                // タスクが選択されている、もしくは親ブロックが選択されている場合
                                // （「- [ ] 」や「- [x] 」などのMarkdownのチェックボックス記号は含めず純粋なテキストのみを抽出）
                                const text = taskEl.querySelector('.task-input').value;
                                copyTexts.push(text.replace(/\n/g, ' '));
                            }
                        });
                    });

                    if (copyTexts.length > 0) {
                        const copyText = copyTexts.join('\n');
                        navigator.clipboard.writeText(copyText).then(() => {
                            // コピー成功時に少しだけ視覚的フィードバックを出す
                            const popup = document.createElement('div');
                            popup.textContent = '選択中の項目をコピーしました';
                            Object.assign(popup.style, {
                                position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
                                background: 'rgba(0,0,0,0.8)', color: '#fff', padding: '8px 16px',
                                borderRadius: '4px', zIndex: '9999', fontSize: '0.85rem', transition: 'opacity 0.3s'
                            });
                            document.body.appendChild(popup);
                            setTimeout(() => {
                                popup.style.opacity = '0';
                                setTimeout(() => popup.remove(), 300);
                            }, 2000);
                        });
                    }
                }
            }
        });

        this.setupDragRangeSelection();

        // Ctrl+Z / Ctrl+Shift+Z で元に戻す/やり直し
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                // 入力欄にフォーカスがある場合は、ブラウザ標準のテキストのやり直し（Undo/Redo）を優先させる
                if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                    return;
                }

                // block要素やinputでのデフォルトのundoを防ぐ
                e.preventDefault();
                if (e.shiftKey) {
                    this.redo();
                } else {
                    this.undo();
                }
            }
        });

        // ブロック/タスクのホットキー移動 (Ctrl + 矢印)
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                const selectedBlocks = Array.from(this.el.blockContainer.querySelectorAll('.note-block.block-selected'));
                const selectedTasks = Array.from(this.el.blockContainer.querySelectorAll('.task-item.task-selected'));

                // 単一選択時のみ移動可能にする
                if (selectedBlocks.length === 1 && selectedTasks.length === 0) {
                    e.preventDefault();
                    this.recordHistory();
                    const block = selectedBlocks[0];
                    if (e.key === 'ArrowUp' && block.previousElementSibling) {
                        block.parentNode.insertBefore(block, block.previousElementSibling);
                    } else if (e.key === 'ArrowDown' && block.nextElementSibling) {
                        block.parentNode.insertBefore(block, block.nextElementSibling.nextElementSibling);
                    }
                    this.syncAllBlocksFromDOM();
                    block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } else if (selectedTasks.length === 1 && selectedBlocks.length === 0) {
                    e.preventDefault();
                    this.recordHistory();
                    const task = selectedTasks[0];
                    if (e.key === 'ArrowUp' && task.previousElementSibling) {
                        task.parentNode.insertBefore(task, task.previousElementSibling);
                    } else if (e.key === 'ArrowDown' && task.nextElementSibling) {
                        task.parentNode.insertBefore(task, task.nextElementSibling.nextElementSibling);
                    }
                    this.syncAllBlocksFromDOM();
                    task.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        });


        // SortableJS の初期化
        this.sortable = Sortable.create(this.el.blockContainer, {
            handle: '.block-drag-handle',
            filter: 'button, input, textarea, .block-collapse-btn, .edit-block-btn, .block-subject-label',
            preventOnFilter: false,
            animation: 150,
            ghostClass: 'block-ghost',
            multiDrag: true,
            selectedClass: 'block-selected',
            fallbackTolerance: 3,
            delay: 250,
            delayOnTouchOnly: true, // タッチ操作ではスクロールと区別するため長押しで掴む
            scroll: document.getElementById('editor-wrapper'), // 明示的にスクロールコンテナを指定
            scrollSensitivity: 100, // より広い範囲でスクロール判定させる
            scrollSpeed: 20,
            bubbleScroll: true,
            onEnd: (evt) => {
                this.recordHistory();
                this.syncAllBlocksFromDOM();
            }
        });

        // 最下部の全体追加ボタン
        this.el.globalAddBlockBtn.addEventListener('click', () => {
            this.recordHistory();
            // まず現在の全ブロックの入力内容を反映
            this.syncAllBlocksFromDOM();

            // 新しいブロックを最後に追加
            const newBlock = {
                id: `block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                level: 1,
                heading: "New Section",
                tasks: [{ id: `task-${Date.now()}`, isCompleted: false, text: "", reminder: "" }],
                isCollapsed: false
            };
            this.blocks.push(newBlock);
            this.renderBlocks();
            this.syncContentInput();
            
            // 追加後、スムーズに最下部までスクロール
            setTimeout(() => {
                const parent = document.getElementById('editor-wrapper') || window;
                if (parent === window) {
                    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
                } else {
                    parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
                }
            }, 10);
        });

        // Image Preview Dialog bindings
        if (this.el.imageDialog.closeBtn) {
            this.el.imageDialog.closeBtn.addEventListener('click', () => {
                this.el.imageDialog.el.close();
            });
        }
        if (this.el.imageDialog.el) {
            this.el.imageDialog.el.addEventListener('click', (e) => {
                if (e.target === this.el.imageDialog.el) {
                    this.el.imageDialog.el.close();
                }
            });
        }

        // クリップボードからの画像貼り付け (Ctrl+V)
        document.addEventListener('paste', async (e) => {
            if (e.clipboardData && e.clipboardData.items) {
                for (const item of e.clipboardData.items) {
                    if (item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) {
                            e.preventDefault();
                            try {
                                const dataUrl = await this.readAndOptimizeImage(file);
                                let targetBlockId = null;
                                const activeEl = document.activeElement;
                                const closestBlock = activeEl ? activeEl.closest('.note-block') : null;
                                if (closestBlock) {
                                    targetBlockId = closestBlock.dataset.blockId;
                                } else if (this.blocks.length > 0) {
                                    targetBlockId = this.blocks[this.blocks.length - 1].id;
                                }

                                if (targetBlockId) {
                                    this.recordHistory();
                                    this.syncAllBlocksFromDOM();
                                    const targetBlock = this.blocks.find(b => b.id === targetBlockId);
                                    if (targetBlock) {
                                        if (targetBlock.tasks.length === 1 && targetBlock.tasks[0].type !== 'image' && !targetBlock.tasks[0].text) {
                                            targetBlock.tasks = [];
                                        }
                                        targetBlock.tasks.push({
                                            id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                                            type: 'image',
                                            src: dataUrl,
                                            alt: '貼り付け画像',
                                            isCompleted: false
                                        });
                                        this.renderBlocks();
                                        this.syncContentInput();
                                    }
                                }
                            } catch (err) {
                                console.error('画像貼り付けエラー:', err);
                            }
                            break;
                        }
                    }
                }
            }
        });

        // Dialog bindings
        const closeDialog = () => {
            this.el.dialog.el.close();
            this.el.currentEditingBlockId = null;
        };

        this.el.dialog.closeBtn.addEventListener('click', closeDialog);
        this.el.dialog.cancelBtn.addEventListener('click', closeDialog);

        this.el.dialog.saveBtn.addEventListener('click', () => {
            if (!this.el.currentEditingBlockId) return;
            const block = this.blocks.find(b => b.id === this.el.currentEditingBlockId);
            if (block) {
                block.heading = this.el.dialog.input.value;
                this.renderBlocks();
                this.syncContentInput();
                this.recordHistory();
            }
            closeDialog();
        });

        this.el.dialog.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.el.dialog.saveBtn.click();
            }
        });

        this.el.dialog.deleteBtn.addEventListener('click', () => {
            if (!this.el.currentEditingBlockId) return;
            
            // ブロックが1つしかない場合は削除を防止するか、初期化する
            if (this.blocks.length <= 1) {
                alert('少なくとも1つのセクションが必要です。');
                return;
            }

            this.blocks = this.blocks.filter(b => b.id !== this.el.currentEditingBlockId);
            this.renderBlocks();
            this.syncContentInput();
            this.recordHistory();
            closeDialog();
        });
    }

    // ───────────────────────────────────────
    // 履歴管理 (Undo / Redo)
    // ───────────────────────────────────────
    recordHistory() {
        if (this.isRestoringHistory) return;
        this.syncAllBlocksFromDOM();
        const state = JSON.stringify(this.blocks);

        if (this.historyStack.length > 0 && this.historyStack[this.historyStack.length - 1] === state) {
            return;
        }

        this.historyStack.push(state);
        this.redoStack = []; 
        if (this.historyStack.length > 50) this.historyStack.shift();
    }

    undo() {
        if (this.historyStack.length === 0) return;

        this.syncAllBlocksFromDOM();
        const currentState = JSON.stringify(this.blocks);
        
        // もし直前の変更が履歴に無い場合は、Redoのために現在の状態を積んでおく
        if (this.historyStack[this.historyStack.length - 1] !== currentState) {
            this.redoStack.push(currentState);
        } else {
            this.redoStack.push(this.historyStack.pop());
            if (this.historyStack.length === 0) {
                // 初期状態まで戻った場合 (ここは実装の簡略化として処理)
                return; 
            }
        }

        this.isRestoringHistory = true;
        const prevState = this.historyStack[this.historyStack.length - 1]; 
        if (prevState) {
            this.blocks = JSON.parse(prevState);
            this.renderBlocks();
            this.syncContentInput();
        }
        this.isRestoringHistory = false;
    }

    redo() {
        if (this.redoStack.length === 0) return;

        this.isRestoringHistory = true;
        const nextState = this.redoStack.pop();
        // 現在の状態は既にhistoryStackにPop・Pushされているので、そのままPush
        this.historyStack.push(nextState);
        this.blocks = JSON.parse(nextState);
        this.renderBlocks();
        this.syncContentInput();
        this.isRestoringHistory = false;
    }

    // ───────────────────────────────────────
    // 既存ファイルを追加（複数選択可）
    // ───────────────────────────────────────
    async addFiles() {
        if (!SUPPORTS_FILE_SYSTEM_ACCESS) return this.importLocalFiles();
        try {
            const options = {
                multiple: true,
                types: [{ description: 'Markdown / テキスト', accept: { 'text/markdown': ['.md'], 'text/plain': ['.txt'] } }]
            };

            if (this.activeFileId) {
                const activeFile = this.files.find(f => f.id === this.activeFileId);
                if (activeFile && activeFile.handle) {
                    options.startIn = activeFile.handle;
                }
            } else if (this.files.length > 0) {
                options.startIn = this.files[0].handle;
            }

            const handles = await window.showOpenFilePicker(options);

            for (const handle of handles) {
                if (await this.isDuplicate(handle)) continue;

                // ファイルを追加する操作自体がユーザーアクションなので requestPermission が使える
                const perm = await handle.requestPermission({ mode: 'readwrite' });
                const record = {
                    id:                `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    handle,
                    name:              handle.name,
                    addedAt:           Date.now(),
                    permissionGranted: perm === 'granted',
                };
                await this.store.put(record);
                this.files.push(record);
            }
            this.renderFileList();
        } catch (err) {
            if (err.name !== 'AbortError') console.error('ファイル追加エラー:', err);
        }
    }

    // ───────────────────────────────────────
    // 新規ファイルを作成
    // ───────────────────────────────────────
    importLocalFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
        input.onchange = async () => {
            try {
                for (const picked of input.files) {
                    await this.addLocalFile(picked.name, await picked.text());
                }
                this.renderFileList(this.el.searchInput.value);
            } catch (err) {
                alert('ファイルの取り込みに失敗しました: ' + err.message);
            }
        };
        input.click();
    }

    async addLocalFile(name, content) {
        const now = Date.now();
        const record = {
            id:                `${now}-${Math.random().toString(36).slice(2)}`,
            name,
            content,
            addedAt:           now,
            lastModified:      now,
            permissionGranted: true,
        };
        await this.store.put(record);
        this.files.push(record);
        return record;
    }

    // 拡張子が無いと書き出し時に iOS のファイルアプリで開けないため .md を補う
    normalizeLocalFileName(name) {
        const trimmed = name.trim();
        if (!trimmed) return null;
        return /\.(md|markdown|txt)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
    }

    async createNewFile() {
        if (!SUPPORTS_FILE_SYSTEM_ACCESS) {
            const name = this.normalizeLocalFileName(prompt('新しいメモの名前', 'untitled.md') ?? '');
            if (!name) return;
            const record = await this.addLocalFile(name, '');
            this.renderFileList(this.el.searchInput.value);
            await this.selectFile(record.id);
            return;
        }
        try {
            const options = {
                suggestedName: 'untitled.md',
                types: [{ description: 'Markdown / テキスト', accept: { 'text/markdown': ['.md'], 'text/plain': ['.txt'] } }]
            };

            // いま現在開いているファイル（ファイル情報としてDBに保存されている実体）を初期位置（startIn）として渡す
            if (this.activeFileId) {
                const activeFile = this.files.find(f => f.id === this.activeFileId);
                if (activeFile && activeFile.handle) {
                    options.startIn = activeFile.handle;
                }
            } else if (this.files.length > 0) {
                // 開いているファイルが無くても、リストの一番上のファイルの場所を使う
                options.startIn = this.files[0].handle;
            }

            const handle = await window.showSaveFilePicker(options);
            // 空ファイルとして書き込み初期化
            const w = await handle.createWritable();
            await w.write('');
            await w.close();

            const record = {
                id:                `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                handle,
                name:              handle.name,
                addedAt:           Date.now(),
                permissionGranted: true,
            };
            await this.store.put(record);
            this.files.push(record);
            this.renderFileList();
            await this.selectFile(record.id);
        } catch (err) {
            if (err.name !== 'AbortError') alert('ファイルの作成に失敗しました: ' + err.message);
        }
    }

    // ───────────────────────────────────────
    // ファイルを選択（エディタに表示）
    // ───────────────────────────────────────
    async renameActiveFile(newName) {
        if (!this.activeFileId) return;
        const file = this.files.find(f => f.id === this.activeFileId);
        if (!file || file.name === newName) return;

        if (!file.handle) {
            const name = this.normalizeLocalFileName(newName);
            if (!name) {
                this.el.titleInput.value = file.name;
                return;
            }
            file.name = name;
            await this.store.put(file);
            this.el.titleInput.value = name;
            this.el.filePathInfo.textContent = name;
            this.renderFileList(this.el.searchInput.value);
            return;
        }

        try {
            const options = {
                suggestedName: newName,
                types: [{ description: 'Markdown / テキスト', accept: { 'text/markdown': ['.md'], 'text/plain': ['.txt'] } }]
            };
            if (file.handle) {
                options.startIn = file.handle; // 現在のファイル自体を基点として呼び出す
            }

            // 名前が変更された場合は、[別名で保存]と同様の処理で新しいファイルハンドルを作成する
            const newHandle = await window.showSaveFilePicker(options);

            // 現在の内容を新しいファイルに書き込む
            const w = await newHandle.createWritable();
            await w.write(this.el.contentInput.value);
            await w.close();

            // レコード更新
            file.handle = newHandle;
            file.name = newHandle.name;
            await this.store.put(file);

            // UI更新
            this.el.titleInput.value = file.name;
            this.el.filePathInfo.textContent = file.name;
            this.renderFileList(this.el.searchInput.value);
            
            // 状態リセット
            this.lastSavedContent = this.el.contentInput.value;
            file.draft = this.el.contentInput.value;
            this.setUnsavedState(false);
            this.updateSavedStatus();

        } catch (err) {
            if (err.name !== 'AbortError') {
                alert('ファイル名の変更に失敗しました: ' + err.message);
            }
            // 失敗時は元の名前に戻す
            this.el.titleInput.value = file.name;
        }
    }

    async selectFile(id) {
        document.body.classList.add('show-editor');
        // 同じファイルを押した場合はスキップ
        if (this.activeFileId === id) return;

        // 切り替え前に現在のファイルの編集内容をドラフトとしてバックアップ
        if (this.activeFileId) {
            const currentFile = this.files.find(f => f.id === this.activeFileId);
            if (currentFile) {
                // 元ファイルには上書きせず、メモリ上に編集中データを保持
                currentFile.draft = this.el.contentInput.value;
                await this.store.put(currentFile); // 切り替え前のファイルもDBを更新してドラフトを永続化
            }
        }

        const file = this.files.find(f => f.id === id);
        if (!file) return;

        // 権限が必要なら requestPermission（クリック操作がユーザーアクション）
        if (!file.permissionGranted) {
            try {
                const perm = await file.handle.requestPermission({ mode: 'readwrite' });
                file.permissionGranted = (perm === 'granted');
                await this.store.put(file);
            } catch { file.permissionGranted = false; }

            if (!file.permissionGranted) {
                alert('ファイルへのアクセスが許可されませんでした。');
                document.body.classList.remove('show-editor');
                return;
            }
        }

        this.activeFileId = id;
        try {
            let diskContent = file.content ?? '';
            if (file.handle) {
                const blob  = await file.handle.getFile();
                diskContent = await blob.text();
                // 読み込み時に最新の更新日付を保持する
                file.lastModified = blob.lastModified;
            }
            
            // その他のステータスもDBに保存しておく（ドラフトなどの永続化漏れ防止）
            await this.store.put(file);

            // 下書き（編集中データ）があればそれを復元し、なければファイルから取得した内容を使用
            const content = file.draft !== undefined ? file.draft : diskContent;

            this.el.titleInput.value   = file.name;
            this.el.contentInput.value = content;
            this.lastSavedContent      = diskContent; // 差分チェックの基準はディスクに保存された内容
            
            // ブロックエディタの初期化
            this.blocks = this.parseMarkdownToBlocks(content);
            this.renderBlocks();

            this.el.filePathInfo.textContent = file.name;
            this.updateSubjectIndicator();

            this.updateCharCount();
            this.updateSavedStatus();
            this.showActiveState();
            this.renderFileList(); // 日付などのメタデータ更新を反映
            if (this.isPreviewMode) this.updatePreview();
            
            // 切り替えた直後でもドラフトがディスクと違うなら未保存状態として表示
            this.setUnsavedState(content !== diskContent);

            this.historyStack = [];
            this.redoStack = [];
            this.recordHistory();

            this.renderFileList(this.el.searchInput.value);
        } catch (err) {
            console.error('読み込みエラー:', err);
            alert('ファイルの読み込みに失敗しました。');
        }
    }

    // ───────────────────────────────────────
    // リストから除去（ファイルは削除しない）
    // ───────────────────────────────────────
    async removeFromList(id, event) {
        event.stopPropagation(); // リストアイテムのクリックイベントを止める

        const target = this.files.find(f => f.id === id);
        // ローカルファイルは IndexedDB 上にしか実体が無く、リストから外すと内容も失われる
        if (target && !target.handle
            && !confirm(`「${target.name}」を削除します。この端末からメモの内容が消え、元に戻せません。よろしいですか？`)) {
            return;
        }

        if (this.activeFileId === id) {
            document.body.classList.remove('show-editor');
            clearTimeout(this.saveTimeout);
            this.saveTimeout  = null;
            this.activeFileId = null;
            this.showEmptyState();
        }
        await this.store.delete(id);
        this.files = this.files.filter(f => f.id !== id);
        this.renderFileList(this.el.searchInput.value);
    }

    // ───────────────────────────────────────
    // 入力監視（自動保存なし）
    // ───────────────────────────────────────
    handleInput() {
        if (!this.activeFileId) return;
        this.updateCharCount();
        // 自動保存なし: 未保存状態をUIに反映するのみ
        const isDirty = this.el.contentInput.value !== this.lastSavedContent;
        this.setUnsavedState(isDirty);
    }

    async saveActiveFile() {
        if (!this.activeFileId || this.isSaving) return;

        // 保存直前にブロックの最新状態を同期する
        this.syncAllBlocksFromDOM();

        // 内容に変更がない場合は保存スキップ
        const currentContent = this.el.contentInput.value;
        if (currentContent === this.lastSavedContent) return;

        const file = this.files.find(f => f.id === this.activeFileId);
        if (!file?.permissionGranted) return;

        this.isSaving = true;
        this.el.lastSavedTime.textContent = '保存中...';
        this.el.saveBtn.disabled = true;
        try {
            if (!file.handle) {
                file.content      = currentContent;
                file.lastModified = Date.now();
                file.draft        = currentContent;
                await this.store.put(file);
                this.lastSavedContent = currentContent;
                this.setUnsavedState(false);
            } else {
                // ファイルの以前の中身が残らないように確実に上書きする
                const w = await file.handle.createWritable();
                await w.write(currentContent);
                await w.close();

                this.lastSavedContent = currentContent;
                file.draft = currentContent; // ドラフトも最新状態のディスク内容に揃える

                this.setUnsavedState(false);

                // 最新の更新日時を取得して保存
                try {
                    const fData = await file.handle.getFile();
                    file.lastModified = fData.lastModified;
                    await this.store.put(file);
                } catch (e) {
                    console.warn('ファイルのタイムスタンプ更新に失敗:', e);
                }
            }

            this.updateSavedStatus();
            this.renderFileList(); // 日付順の並びを反映するために再描画
        } catch (err) {
            console.error('保存失敗:', err);
            this.el.lastSavedTime.textContent = '保存失敗 ⚠️';
        } finally {
            this.isSaving = false;
            this.el.saveBtn.disabled = false;
        }
    }

    persistActiveDraft() {
        const file = this.files.find(f => f.id === this.activeFileId);
        if (!file) return;
        this.syncAllBlocksFromDOM();
        file.draft = this.el.contentInput.value;
        this.store.put(file).catch(err => console.warn('下書きの保存に失敗:', err));
    }

    // iOS では共有シートから「ファイルに保存」できる。共有非対応ブラウザではダウンロードにフォールバックする
    async exportActiveFile() {
        const file = this.files.find(f => f.id === this.activeFileId);
        if (!file) return;
        this.syncAllBlocksFromDOM();
        const exported = new File([this.el.contentInput.value], file.name, { type: 'text/plain' });

        if (navigator.canShare?.({ files: [exported] })) {
            try {
                await navigator.share({ files: [exported] });
            } catch (err) {
                if (err.name !== 'AbortError') alert('書き出しに失敗しました: ' + err.message);
            }
            return;
        }

        const url = URL.createObjectURL(exported);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // 未保存インジケーターの切り替え
    setUnsavedState(isDirty) {
        if (isDirty) {
            this.el.saveBtn.classList.add('has-changes');
            this.el.lastSavedTime.textContent = '未保存の変更あり';
        } else {
            this.el.saveBtn.classList.remove('has-changes');
        }

        if (this.activeFileId) {
            const file = this.files.find(f => f.id === this.activeFileId);
            if (file) {
                file.isDirty = isDirty;
                const li = this.el.noteList.querySelector(`li[data-id="${file.id}"]`);
                if (li) {
                    li.classList.toggle('unsaved', isDirty);
                }
            }
        }
    }

    updateSavedStatus() {
        const d = new Date();
        const h = d.getHours().toString().padStart(2, '0');
        const m = d.getMinutes().toString().padStart(2, '0');
        this.el.lastSavedTime.textContent = `保存済み: ${h}:${m}`;
    }

    updateSubjectIndicator() {
        if (!this.activeFileId) return;

        let hasSubject = false;
        let totalTasks = 0;
        let completedTasks = 0;

        for (const block of this.blocks) {
            if (block.isSubject) {
                hasSubject = true;
                for (const task of block.tasks) {
                    if (task.type === 'image') continue; // 画像アイテムはタスク進捗計算から除外
                    const txt = task.text || '';
                    if (txt.trim() === '') continue;
                    totalTasks++;
                    if (task.isCompleted) completedTasks++;
                }
            }
        }

        const file = this.files.find(f => f.id === this.activeFileId);
        let fileChanged = false;
        if (file) {
            if (file.isSubject !== hasSubject) {
                file.isSubject = hasSubject;
                fileChanged = true;
                this.store.put(file);
            }
        }

        if (!hasSubject) {
            this.el.subjectIndicator.classList.add('hidden');
        } else {
            this.el.subjectIndicator.classList.remove('hidden');
            const percentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
            this.el.subjectProgress.textContent = `${percentage}% (${completedTasks}/${totalTasks})`;
        }
        
        if (fileChanged) {
            this.renderFileList(this.el.searchInput.value);
        }
    }

    // ───────────────────────────────────────
    // Markdown プレビュー
    // ───────────────────────────────────────
    togglePreview() {
        this.isPreviewMode = !this.isPreviewMode;
        if (this.isPreviewMode) {
            this.updatePreview();
            this.el.blockContainer.classList.add('hidden');
            if (this.el.globalAddBlockBtn) this.el.globalAddBlockBtn.classList.add('hidden');
            this.el.previewArea.classList.remove('hidden');
            this.el.editLabel.classList.add('hidden');
            this.el.previewLabel.classList.remove('hidden');
        } else {
            this.el.blockContainer.classList.remove('hidden');
            if (this.el.globalAddBlockBtn) this.el.globalAddBlockBtn.classList.remove('hidden');
            this.el.previewArea.classList.add('hidden');
            this.el.editLabel.classList.remove('hidden');
            this.el.previewLabel.classList.add('hidden');
            // 非表示状態から復帰した際に高さを再計算する
            this.el.blockContainer.querySelectorAll('.task-input').forEach(ta => this.autoResize(ta));
        }
    }

    updatePreview() {
        this.el.previewArea.innerHTML = marked.parse(this.el.contentInput.value);
    }

    // ───────────────────────────────────────
    // 画像関連ヘルパー
    // ───────────────────────────────────────
    async pickImageFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = async (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) {
                    resolve(null);
                    return;
                }
                try {
                    const dataUrl = await this.readAndOptimizeImage(file);
                    resolve({
                        name: file.name.replace(/\.[^/.]+$/, ""), // 拡張子を除いたファイル名をデフォルトのキャプションに
                        dataUrl
                    });
                } catch (err) {
                    console.error('画像読み込みエラー:', err);
                    alert('画像の読み込みに失敗しました。');
                    resolve(null);
                }
            };
            input.oncancel = () => resolve(null);
            input.click();
        });
    }

    readAndOptimizeImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const MAX_WIDTH = 1600;
                    const MAX_HEIGHT = 1600;
                    let width = img.width;
                    let height = img.height;

                    if (width > MAX_WIDTH || height > MAX_HEIGHT) {
                        if (width > height) {
                            height = Math.round((height * MAX_WIDTH) / width);
                            width = MAX_WIDTH;
                        } else {
                            width = Math.round((width * MAX_HEIGHT) / height);
                            height = MAX_HEIGHT;
                        }

                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                        resolve(canvas.toDataURL(mime, 0.85));
                    } else {
                        resolve(e.target.result);
                    }
                };
                img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    showImageModal(src, caption) {
        if (!this.el.imageDialog.el) return;
        this.el.imageDialog.img.src = src;
        this.el.imageDialog.caption.textContent = caption || '';
        this.el.imageDialog.el.showModal();
    }

    async addImageToBlock(blockId) {
        const image = await this.pickImageFile();
        if (!image) return;

        this.recordHistory();
        this.syncAllBlocksFromDOM();

        const targetBlock = this.blocks.find(b => b.id === blockId);
        if (targetBlock) {
            // 空の未入力タスクが1つだけなら置き換え
            if (targetBlock.tasks.length === 1 && targetBlock.tasks[0].type !== 'image' && !targetBlock.tasks[0].text) {
                targetBlock.tasks = [];
            }
            targetBlock.tasks.push({
                id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                type: 'image',
                src: image.dataUrl,
                alt: image.name,
                isCompleted: false
            });
            this.renderBlocks();
            this.syncContentInput();
        }
    }

    async changeImageItem(blockId, taskId) {
        const image = await this.pickImageFile();
        if (!image) return;

        this.recordHistory();
        this.syncAllBlocksFromDOM();

        const targetBlock = this.blocks.find(b => b.id === blockId);
        if (targetBlock) {
            const targetItem = targetBlock.tasks.find(t => t.id === taskId);
            if (targetItem) {
                targetItem.src = image.dataUrl;
                if (!targetItem.alt) targetItem.alt = image.name;
                this.renderBlocks();
                this.syncContentInput();
            }
        }
    }

    deleteItem(blockId, taskId) {
        this.recordHistory();
        this.syncAllBlocksFromDOM();
        const targetBlock = this.blocks.find(b => b.id === blockId);
        if (targetBlock) {
            targetBlock.tasks = targetBlock.tasks.filter(t => t.id !== taskId);
            if (targetBlock.tasks.length === 0) {
                targetBlock.tasks.push({ id: `task-${Date.now()}`, type: 'task', isCompleted: false, text: "" });
            }
            this.renderBlocks();
            this.syncContentInput();
        }
    }

    // ───────────────────────────────────────
    // ブロックエディタ関連
    // ───────────────────────────────────────
    parseMarkdownToBlocks(text) {
        const blocks = [];
        const lines = text.split('\n');
        let currentBlock = null;

        // タスクを解析する正規表現 (e.g. "- [ ] タスク内容")
        const taskRegex = /^(?:-\s*\[([ xX])\]\s*)?(.*?)$/;
        // 画像を解析する正規表現 (Markdown: ![alt](src) またはタスク付き: - [ ] ![alt](src))
        // 末尾の <!-- width="300px" --> や src内の =300x も考慮
        const imageRegex = /^(?:-\s*\[([ xX])\]\s*)?!\[(.*?)\]\((.+?)\)(?:\s*<!--\s*width=["']?(\d+%?|\d+px)["']?\s*-->)?$/;
        // HTML imgタグのサポート (<img ... src="..." ... alt="..." ... width="...">)
        const imgTagRegex = /^(?:-\s*\[([ xX])\]\s*)?<img\s+([^>]+)\/?>$/i;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
            
            if (headingMatch) {
                if (currentBlock) blocks.push(currentBlock);
                let headingText = headingMatch[2];
                let isSubject = false;
                if (headingText.includes('🎯')) {
                    isSubject = true;
                    headingText = headingText.replace('🎯', '').trim();
                }
                currentBlock = {
                    id: `block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    level: headingMatch[1].length,
                    heading: headingText,
                    isSubject: isSubject,
                    tasks: [],
                    isCollapsed: true,
                };
            } else {
                if (!currentBlock) {
                    currentBlock = {
                        id: `block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        level: 1,
                        heading: "Untitled Section",
                        isSubject: false,
                        tasks: [],
                        isCollapsed: true,
                    };
                }
                if (line.trim() !== '') {
                    const trimmedLine = line.trim();
                    const imgMatch = trimmedLine.match(imageRegex);
                    const tagMatch = trimmedLine.match(imgTagRegex);

                    if (imgMatch) {
                        let src = imgMatch[3];
                        let width = imgMatch[4] || null;
                        // srcの末尾に =300x や =300 がある場合
                        const widthParamMatch = src.match(/\s+=(\d+%?|\d+px)x?$/);
                        if (widthParamMatch) {
                            width = widthParamMatch[1];
                            src = src.replace(/\s+=(\d+%?|\d+px)x?$/, '').trim();
                        }
                        currentBlock.tasks.push({
                            id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            type: 'image',
                            alt: imgMatch[2] || '',
                            src: src,
                            width: width ? (String(width).endsWith('px') || String(width).endsWith('%') ? width : `${width}px`) : '',
                            isCompleted: false
                        });
                    } else if (tagMatch) {
                        const attrsStr = tagMatch[2];
                        const srcM = attrsStr.match(/src=["']([^"']+)["']/i);
                        const altM = attrsStr.match(/alt=["']([^"']*)["']/i);
                        const widthM = attrsStr.match(/width=["']([^"']+)["']/i);
                        if (srcM) {
                            const widthVal = widthM ? widthM[1] : '';
                            currentBlock.tasks.push({
                                id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                                type: 'image',
                                alt: altM ? altM[1] : '',
                                src: srcM[1],
                                width: widthVal ? (String(widthVal).endsWith('px') || String(widthVal).endsWith('%') ? widthVal : `${widthVal}px`) : '',
                                isCompleted: false
                            });
                        }
                    } else {
                        const match = trimmedLine.match(taskRegex);
                        const rawText = match ? match[2].trim() : trimmedLine;
                        currentBlock.tasks.push({
                            id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            type: 'task',
                            isCompleted: match && match[1] && match[1].toLowerCase() === 'x',
                            text: rawText.replace(/<br\s*\/?>/gi, '\n'),
                            depth: this.getIndentDepth(line)
                        });
                    }
                }
            }
        }
        if (currentBlock) blocks.push(currentBlock);

        if (blocks.length === 0) {
            blocks.push({
                id: `block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                level: 1,
                heading: "New Section",
                isSubject: false,
                tasks: [{ id: `task-${Date.now()}`, type: 'task', isCompleted: false, text: "" }],
                isCollapsed: false
            });
        } else {
            blocks.forEach(b => {
                if (b.tasks.length === 0) {
                    b.tasks.push({ id: `task-${Date.now()}`, type: 'task', isCompleted: false, text: "" });
                }
            });
        }
        return blocks;
    }

    serializeBlocksToMarkdown() {
        return this.blocks.map(b => {
            const prefix = '#'.repeat(b.level);
            
            const taskLines = b.tasks.map(t => {
                if (t.type === 'image' || t.src) {
                    const alt = (t.alt || '').replace(/\n/g, ' ');
                    if (t.width) {
                        const widthStr = String(t.width).endsWith('px') || String(t.width).endsWith('%') ? t.width : `${t.width}px`;
                        return `<img src="${t.src}" alt="${alt}" width="${widthStr}">`;
                    }
                    return `![${alt}](${t.src})`;
                }
                const check = t.isCompleted ? '[x]' : '[ ]';
                // テキスト内の改行を <br> に変換して、Markdown上の1行1タスク構造を維持する
                const safeText = (t.text || '').replace(/\n/g, '<br>');
                const indent = '  '.repeat(t.depth || 0);
                return `${indent}- ${check} ${safeText}`;
            }).join('\n');
            
            const subjectMarker = b.isSubject ? '🎯 ' : '';
            return `${prefix} ${subjectMarker}${b.heading}\n${taskLines}`;
        }).join('\n\n').trim();
    }

    syncContentInput() {
        const md = this.serializeBlocksToMarkdown();
        this.el.contentInput.value = md;
        this.handleInput(); // 未保存マークなどの更新
        this.updateSubjectIndicator();
    }

    syncAllBlocksFromDOM() {
        const existingBlocks = this.el.blockContainer.querySelectorAll('.note-block');
        const newBlocks = [];
        
        existingBlocks.forEach((blockEl) => {
            const id = blockEl.dataset.blockId;
            const targetBlock = this.blocks.find(b => b.id === id);
            if (targetBlock) {
                const subjectCheckbox = blockEl.querySelector('.block-subject-checkbox');
                if (subjectCheckbox) {
                    targetBlock.isSubject = subjectCheckbox.checked;
                }

                const items = blockEl.querySelectorAll('.task-item, .image-item');
                targetBlock.tasks = Array.from(items).map(item => {
                    const itemId = item.dataset.taskId;
                    if (item.classList.contains('image-item')) {
                        const orig = (targetBlock.tasks || []).find(t => t.id === itemId);
                        const captionInput = item.querySelector('.image-caption-input');
                        const previewBox = item.querySelector('.image-preview-box');
                        const width = item.dataset.width || (previewBox && previewBox.style.width) || (orig && orig.width) || '';
                        return {
                            id: itemId,
                            type: 'image',
                            src: (orig && orig.src) || item.dataset.src || '',
                            alt: captionInput ? captionInput.value : ((orig && orig.alt) || ''),
                            width: width,
                            isCompleted: false
                        };
                    } else {
                        const check = item.querySelector('.task-checkbox');
                        const input = item.querySelector('.task-input');
                        return {
                            id: itemId,
                            type: 'task',
                            isCompleted: check ? check.checked : false,
                            text: input ? input.value : '',
                            depth: Number(item.dataset.depth) || 0,
                            isCollapsed: item.dataset.collapsed === 'true'
                        };
                    }
                });
                newBlocks.push(targetBlock);
            }
        });
        
        // 順番を含めてブロック全体を更新する
        this.blocks = newBlocks;
        this.syncContentInput();
    }

    renderBlocks() {
        // スクロール可能な親要素を取得 (今回は .textarea-wrapper などの直近の祖先か window )
        const scrollParent = document.getElementById('editor-wrapper') || window;
        const prevScrollTop = scrollParent.scrollTop || window.scrollY;
        
        // 再描画時の高さ消失によるスクロールのガタつき（チラつき）を防ぐ
        const prevMinHeight = this.el.blockContainer.style.minHeight;
        this.el.blockContainer.style.minHeight = this.el.blockContainer.offsetHeight + 'px';

        this.el.blockContainer.innerHTML = '';
        this.blocks.forEach((block) => {
            const blockEl = this.createBlockElement(block);
            this.el.blockContainer.appendChild(blockEl);
        });

        // いったん元のスクロール位置に戻す
        if (scrollParent === window) {
            window.scrollTo(window.scrollX, prevScrollTop);
        } else {
            scrollParent.scrollTop = prevScrollTop;
        }

        // 描画後にすべてのテキストエリアの高さを調整し、固定を解除
        setTimeout(() => {
            this.el.blockContainer.querySelectorAll('.task-input').forEach(ta => this.autoResize(ta));
            this.el.blockContainer.style.minHeight = prevMinHeight;
        }, 0);
    }

    createBlockElement(block) {
        const blockEl = document.createElement('div');
        blockEl.className = 'note-block';
        blockEl.dataset.blockId = block.id; // 要素とデータの紐付け用ID
        if (block.isCollapsed) blockEl.classList.add('collapsed');

        let tasksHtml = block.tasks.map(t => {
            if (t.type === 'image' || t.src) {
                const widthStyle = t.width ? `width: ${t.width};` : '';
                const imgWidthStyle = t.width ? 'width: 100%;' : '';
                return `
                <div class="image-item" data-task-id="${t.id}" data-type="image" data-src="${this.escapeHtml(t.src || '')}" data-width="${this.escapeHtml(t.width || '')}">
                    <div class="image-item-top">
                        <span class="image-drag-handle task-drag-handle" title="ドラッグして並べ替え">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                        </span>
                        <input type="text" class="image-caption-input" placeholder="画像の説明・キャプション..." value="${this.escapeHtml(t.alt || '')}">
                        <div class="image-actions">
                            <button class="image-action-btn reset-size-btn" title="画像サイズをリセット">リセット</button>
                            <button class="image-action-btn change-image-btn" title="別の画像に変更">変更</button>
                            <button class="image-action-btn delete-image-btn" title="画像を削除">×</button>
                        </div>
                    </div>
                    <div class="image-preview-box" title="ドラッグしてリサイズ / クリックで拡大" style="${widthStyle}">
                        <img src="${this.escapeHtml(t.src || '')}" alt="${this.escapeHtml(t.alt || '')}" loading="lazy" style="${imgWidthStyle}">
                        <div class="image-resize-handle" title="ドラッグして画像のサイズを変更"></div>
                        <div class="image-size-indicator">${t.width || ''}</div>
                    </div>
                </div>
                `;
            }
            const charCount = t.text ? t.text.length : 0;
            const depth = t.depth || 0;
            return `
            <div class="task-item ${t.isCompleted ? 'completed' : ''}" data-task-id="${t.id}" data-type="task" data-depth="${depth}" data-collapsed="${t.isCollapsed ? 'true' : 'false'}" style="--task-depth: ${depth};">
                <button class="task-collapse-btn" title="サブタスクを折りたたむ">▼</button>
                <span class="task-drag-handle" title="ドラッグして並べ替え">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </span>
                <input type="checkbox" class="task-checkbox" ${t.isCompleted ? 'checked' : ''}>
                <textarea class="task-input" placeholder="項目を入力..." rows="1">${this.escapeHtml(t.text || '')}</textarea>
                <span class="task-char-count">${charCount} 文字</span>
                <button class="add-subtask-btn" title="サブタスクを追加" ${depth >= this.MAX_TASK_DEPTH ? 'disabled' : ''}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
                </button>
                <button class="delete-task-btn" title="行を削除">×</button>
            </div>
            `;
        }).join('');

        blockEl.innerHTML = `
            <div class="block-header block-drag-handle" title="ドラッグして並べ替え">
                <button class="block-collapse-btn" title="折りたたむ">▼</button>
                <div class="block-title-container">
                    <span class="heading-prefix">${'#'.repeat(block.level)}</span>
                    <span class="block-title-display">${this.escapeHtml(block.heading) || 'Untitled'}</span>
                </div>
                <div class="block-actions">
                    <label class="block-subject-label" title="このセクションをサブジェクトとして設定">
                        <input type="checkbox" class="block-subject-checkbox" ${block.isSubject ? 'checked' : ''}> 🎯
                    </label>
                    <button class="edit-block-btn" title="セクション設定">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </button>
                </div>
            </div>
            <div class="block-content-body task-list">
                ${tasksHtml}
                <div class="block-bottom-actions">
                    <div class="block-bottom-left-actions">
                        <button class="add-task-btn" title="項目を追加">+ 追加</button>
                        <button class="add-image-btn" title="このセクションに画像を追加">📷 画像を追加</button>
                    </div>
                    <div class="block-bottom-right-actions">
                        <button class="add-block-below-btn" title="この下に新しいセクションを追加">+ 下にセクションを追加</button>
                    </div>
                </div>
            </div>
        `;

        const titleDisplay = blockEl.querySelector('.block-title-display');
        const collapseBtn = blockEl.querySelector('.block-collapse-btn');
        const editBlockBtn = blockEl.querySelector('.edit-block-btn');
        const addTaskBtn = blockEl.querySelector('.add-task-btn');
        const addImageBtn = blockEl.querySelector('.add-image-btn');
        const addBlockBelowBtn = blockEl.querySelector('.add-block-below-btn');
        const taskList = blockEl.querySelector('.task-list');
        const subjectCheckbox = blockEl.querySelector('.block-subject-checkbox');

        if (block.isCollapsed) {
            collapseBtn.textContent = '▶';
        }
        this.applyTaskCollapse(blockEl);

        // サブジェクトの切り替えイベント
        subjectCheckbox.addEventListener('change', (e) => {
            block.isSubject = e.target.checked;
            this.syncContentInput();
            this.recordHistory();
        });

        // 編集ダイアログを開く
        editBlockBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // ドラッグなどに影響させない
            this.el.currentEditingBlockId = block.id;
            this.el.dialog.input.value = block.heading;
            this.el.dialog.el.showModal();
        });

        // タスク＆画像リストのドラッグ＆ドロップ初期化
        let draggedDescendants = [];
        Sortable.create(taskList, {
            group: 'tasks', // 違うブロック間でも行を移動できるようにする
            handle: '.task-drag-handle',
            draggable: '.task-item, .image-item',
            animation: 150,
            ghostClass: 'task-ghost',
            multiDrag: true, // 複数選択（Shift/Ctrl）を有効化
            selectedClass: 'task-selected', // 選択時のCSSクラス
            fallbackTolerance: 3,
            delay: 250,
            delayOnTouchOnly: true, // タッチ操作ではスクロールと区別するため長押しで掴む
            scroll: document.getElementById('editor-wrapper'), // 明示的にスクロール元を指定
            scrollSensitivity: 100, // スクロール判定を広く
            scrollSpeed: 20,
            bubbleScroll: true,
            // 折りたたまれた子孫は非表示のまま元の位置に取り残されるため、親と一緒に移動させる
            onStart: (evt) => {
                draggedDescendants = evt.item.dataset.collapsed === 'true' ? this.getDescendantItems(evt.item) : [];
            },
            onEnd: (evt) => {
                if (draggedDescendants.length > 0) {
                    evt.item.after(...draggedDescendants);
                    draggedDescendants = [];
                }
                [evt.from, evt.to].forEach(list => this.applyTaskCollapse(list.closest('.note-block')));
                this.recordHistory();
                this.syncAllBlocksFromDOM();
            }
        });

        // collapse/expand block
        let typingTimer; // typingTimer is used by task items now

        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // ドラッグイベント等との競合を防ぐ
            block.isCollapsed = !block.isCollapsed;
            blockEl.classList.toggle('collapsed', block.isCollapsed);
            collapseBtn.textContent = block.isCollapsed ? '▶' : '▼';
            
            // 折りたたみが解除された際、内部のテキストエリアの高さを再計算する
            if (!block.isCollapsed) {
                blockEl.querySelectorAll('.task-input').forEach(ta => this.autoResize(ta));
            }
            this.recordHistory();
        });

        // 画像のマウスリサイズ用ドラッグ処理
        let isResizing = false;

        taskList.addEventListener('mousedown', (e) => {
            const handle = e.target.closest('.image-resize-handle');
            if (!handle) return;

            e.preventDefault();
            e.stopPropagation();

            const previewBox = handle.closest('.image-preview-box');
            const imageItem = handle.closest('.image-item');
            const img = previewBox ? previewBox.querySelector('img') : null;
            const indicator = previewBox ? previewBox.querySelector('.image-size-indicator') : null;
            if (!previewBox || !imageItem) return;

            isResizing = true;
            previewBox.classList.add('resizing');

            const startX = e.clientX;
            const startWidth = previewBox.offsetWidth;
            const maxContainerWidth = imageItem.clientWidth - 24;

            const onMouseMove = (moveEvent) => {
                const diffX = moveEvent.clientX - startX;
                let newWidth = Math.max(120, Math.min(maxContainerWidth, startWidth + diffX));
                const newWidthPx = `${Math.round(newWidth)}px`;

                previewBox.style.width = newWidthPx;
                if (img) img.style.width = '100%';
                if (indicator) indicator.textContent = newWidthPx;
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                setTimeout(() => {
                    isResizing = false;
                    previewBox.classList.remove('resizing');
                }, 50);

                const finalWidth = `${Math.round(previewBox.offsetWidth)}px`;
                imageItem.dataset.width = finalWidth;

                this.updateTasksFromDOM(blockEl, block);
                this.recordHistory();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // タスク・画像リストのイベントデリゲーション
        taskList.addEventListener('input', (e) => {
            if (e.target.classList.contains('task-input')) {
                // 文字数更新
                const item = e.target.closest('.task-item');
                const charCountEl = item.querySelector('.task-char-count');
                if (charCountEl) {
                    charCountEl.textContent = `${e.target.value.length} 文字`;
                }

                this.updateTasksFromDOM(blockEl, block);
                this.autoResize(e.target);
                clearTimeout(typingTimer);
                typingTimer = setTimeout(() => this.recordHistory(), 1000);
            } else if (e.target.classList.contains('image-caption-input')) {
                this.updateTasksFromDOM(blockEl, block);
                clearTimeout(typingTimer);
                typingTimer = setTimeout(() => this.recordHistory(), 1000);
            }
        });

        taskList.addEventListener('change', (e) => {
            if (e.target.classList.contains('task-checkbox')) {
                const item = e.target.closest('.task-item');
                item.classList.toggle('completed', e.target.checked);
                this.updateTasksFromDOM(blockEl, block);
                this.recordHistory();
            }
        });

        taskList.addEventListener('click', (e) => {
            const taskCollapseBtn = e.target.closest('.task-collapse-btn');
            if (taskCollapseBtn) {
                const item = taskCollapseBtn.closest('.task-item');
                item.dataset.collapsed = item.dataset.collapsed === 'true' ? 'false' : 'true';
                this.applyTaskCollapse(blockEl);
                if (item.dataset.collapsed === 'false') {
                    this.getDescendantItems(item).forEach(el => el.querySelectorAll('.task-input').forEach(ta => this.autoResize(ta)));
                }
                this.updateTasksFromDOM(blockEl, block);
                this.recordHistory();
                return;
            }

            const subtaskBtn = e.target.closest('.add-subtask-btn');
            if (subtaskBtn) {
                this.addSubtask(block.id, subtaskBtn.closest('.task-item').dataset.taskId);
                return;
            }

            // タスク削除
            if (e.target.classList.contains('delete-task-btn')) {
                const item = e.target.closest('.task-item');
                const inputs = Array.from(blockEl.querySelectorAll('.task-item, .image-item'));
                if (inputs.length > 1) {
                    item.remove();
                    this.applyTaskCollapse(blockEl);
                    this.updateTasksFromDOM(blockEl, block);
                } else {
                    item.querySelector('.task-input').value = '';
                    item.querySelector('.task-checkbox').checked = false;
                    item.classList.remove('completed');
                    const charCountEl = item.querySelector('.task-char-count');
                    if (charCountEl) charCountEl.textContent = `0 文字`;
                    this.updateTasksFromDOM(blockEl, block);
                    this.autoResize(item.querySelector('.task-input'));
                }
                this.recordHistory();
                return;
            }

            // 画像削除
            if (e.target.classList.contains('delete-image-btn')) {
                const item = e.target.closest('.image-item');
                if (item) {
                    this.deleteItem(block.id, item.dataset.taskId);
                }
                return;
            }

            // 画像サイズリセット
            if (e.target.classList.contains('reset-size-btn')) {
                const item = e.target.closest('.image-item');
                if (item) {
                    const previewBox = item.querySelector('.image-preview-box');
                    const img = previewBox?.querySelector('img');
                    if (previewBox) {
                        previewBox.style.width = '';
                        if (img) img.style.width = '';
                    }
                    delete item.dataset.width;
                    this.updateTasksFromDOM(blockEl, block);
                    this.recordHistory();
                }
                return;
            }

            // 画像差し替え
            if (e.target.classList.contains('change-image-btn')) {
                const item = e.target.closest('.image-item');
                if (item) {
                    this.changeImageItem(block.id, item.dataset.taskId);
                }
                return;
            }

            // 画像クリックで拡大モーダル表示
            if (isResizing) return;
            const previewBox = e.target.closest('.image-preview-box');
            if (previewBox && !e.target.closest('.image-resize-handle')) {
                const img = previewBox.querySelector('img');
                const item = previewBox.closest('.image-item');
                const caption = item?.querySelector('.image-caption-input')?.value || img?.alt || '';
                if (img && img.src) {
                    this.showImageModal(img.src, caption);
                }
                return;
            }
        });

        // エンターキーで次の行を作成、バックスペースで空行を消す
        taskList.addEventListener('keydown', (e) => {
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
                && !e.isComposing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
                && e.target.matches('.task-input, .image-caption-input')) {
                const dir = e.key === 'ArrowUp' ? -1 : 1;
                if (this.isCaretOnEdgeLine(e.target, dir) && this.jumpToAdjacentItem(e.target, dir)) {
                    e.preventDefault();
                }
                return;
            }

            if (e.target.classList.contains('task-input')) {
                const item = e.target.closest('.task-item');
                
                if (e.key === 'Enter') {
                    if (e.isComposing) return; // IME入力での確定Enterを無視
                    
                    if (e.shiftKey) {
                        // Shift+Enterの場合はデフォルトの改行処理を行わせ、自動リサイズ
                        setTimeout(() => this.autoResize(e.target), 0);
                        return;
                    }

                    e.preventDefault();
                    this.recordHistory();
                    this.syncAllBlocksFromDOM();
                    const targetBlock = this.blocks.find(b => b.id === block.id);
                    const idx = targetBlock.tasks.findIndex(t => t.id === item.dataset.taskId);
                    const depth = targetBlock.tasks[idx].depth || 0;
                    // 折りたたみ中の親の直後に挿入すると隠れた子を奪ってしまうため、子孫の後ろに挿入する
                    let insertIdx = idx + 1;
                    if (targetBlock.tasks[idx].isCollapsed) {
                        while (insertIdx < targetBlock.tasks.length && (targetBlock.tasks[insertIdx].depth || 0) > depth) {
                            insertIdx++;
                        }
                    }
                    const newTask = { id: `task-${Date.now()}`, type: 'task', isCompleted: false, text: "", depth };
                    targetBlock.tasks.splice(insertIdx, 0, newTask);
                    this.renderBlocks();
                    this.syncContentInput(); // Ensure it saves
                    this.focusTaskInput(newTask.id);
                }
                
                if (e.key === 'Tab') {
                    if (e.isComposing) return;
                    e.preventDefault();
                    this.shiftTaskDepth(block.id, item.dataset.taskId, e.shiftKey ? -1 : 1);
                    return;
                }

                if (e.key === 'Backspace' && e.target.value === '') {
                    e.preventDefault();
                    this.recordHistory();
                    const inputs = Array.from(blockEl.querySelectorAll('.task-item, .image-item'));
                    if (inputs.length > 1) {
                        const idx = inputs.indexOf(item);
                        this.syncAllBlocksFromDOM();
                        const targetBlock = this.blocks.find(b => b.id === block.id);
                        targetBlock.tasks.splice(idx, 1);
                        this.renderBlocks();
                        this.syncContentInput();
                        
                        setTimeout(() => {
                            const newInputs = this.el.blockContainer.querySelectorAll(`[data-block-id="${block.id}"] .task-input`);
                            if (idx > 0 && newInputs[idx - 1]) {
                                newInputs[idx - 1].focus();
                            } else if (newInputs[0]) {
                                newInputs[0].focus();
                            }
                        }, 0);
                    }
                }
            }
        });

        // 項目追加イベント
        addTaskBtn.addEventListener('click', () => {
            this.recordHistory();
            this.syncAllBlocksFromDOM();
            const targetBlock = this.blocks.find(b => b.id === block.id);
            targetBlock.tasks.push({ id: `task-${Date.now()}`, type: 'task', isCompleted: false, text: "" });
            this.renderBlocks();
            this.syncContentInput();
        });

        // 画像追加イベント
        if (addImageBtn) {
            addImageBtn.addEventListener('click', () => {
                this.addImageToBlock(block.id);
            });
        }

        // 下にセクションを追加するイベント
        addBlockBelowBtn.addEventListener('click', () => {
            this.recordHistory();
            this.syncAllBlocksFromDOM();
            
            const currentIndex = this.blocks.findIndex(b => b.id === block.id);
            if (currentIndex !== -1) {
                const newBlock = {
                    id: `block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    level: block.level, // 現在のセクションと同じ見出しレベルを適用
                    heading: "",
                    tasks: [{ id: `task-${Date.now()}`, type: 'task', isCompleted: false, text: "" }],
                    isCollapsed: false,
                };
                
                this.blocks.splice(currentIndex + 1, 0, newBlock);
                this.renderBlocks();
                this.syncContentInput();
                
                setTimeout(() => {
                    const addedBlock = this.el.blockContainer.querySelector(`.note-block[data-block-id="${newBlock.id}"]`);
                    if (addedBlock) {
                        addedBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 50);
            }
        });


        return blockEl;
    }

    // textarea 内の文字選択は他の行へ広げられないため、なぞりが別の行に入ったら行単位の選択に切り替える
    setupDragRangeSelection() {
        const rangeSelected = new Set();
        let startItem = null;

        const clearRange = () => {
            rangeSelected.forEach(el => el.classList.remove('task-selected'));
            rangeSelected.clear();
        };

        this.el.blockContainer.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            clearRange();
            startItem = e.target.closest('.task-input') ? e.target.closest('.task-item') : null;
        });

        document.addEventListener('mousemove', e => {
            if (!startItem || !(e.buttons & 1)) return;
            const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest('.task-item');
            if (!hovered || !this.el.blockContainer.contains(hovered)) return;

            if (hovered === startItem) {
                clearRange();
                return;
            }

            const items = Array.from(this.el.blockContainer.querySelectorAll('.task-item')).filter(el => el.offsetParent !== null);
            const [from, to] = [items.indexOf(startItem), items.indexOf(hovered)].sort((a, b) => a - b);
            clearRange();
            items.slice(from, to + 1).forEach(el => {
                el.classList.add('task-selected');
                rangeSelected.add(el);
            });
            if (document.activeElement?.classList.contains('task-input')) document.activeElement.blur();
            window.getSelection()?.removeAllRanges();
        });

        document.addEventListener('mouseup', () => { startItem = null; });
    }

    getIndentDepth(line) {
        const indent = line.match(/^[ \t]*/)[0];
        const width = indent.replace(/\t/g, '  ').length;
        return Math.min(Math.floor(width / 2), this.MAX_TASK_DEPTH);
    }

    focusTaskInput(taskId) {
        setTimeout(() => {
            const input = this.el.blockContainer.querySelector(`.task-item[data-task-id="${taskId}"] .task-input`);
            if (input) input.focus();
        }, 0);
    }

    addSubtask(blockId, parentTaskId) {
        this.recordHistory();
        this.syncAllBlocksFromDOM();
        const targetBlock = this.blocks.find(b => b.id === blockId);
        if (!targetBlock) return;
        const parentIdx = targetBlock.tasks.findIndex(t => t.id === parentTaskId);
        if (parentIdx === -1) return;

        const parentDepth = targetBlock.tasks[parentIdx].depth || 0;
        if (parentDepth >= this.MAX_TASK_DEPTH) return;

        // 既存の子孫の末尾に追加し、兄弟サブタスクの並び順を保つ
        let insertIdx = parentIdx + 1;
        while (insertIdx < targetBlock.tasks.length && (targetBlock.tasks[insertIdx].depth || 0) > parentDepth) {
            insertIdx++;
        }

        const newTask = { id: `task-${Date.now()}`, type: 'task', isCompleted: false, text: "", depth: parentDepth + 1 };
        targetBlock.tasks.splice(insertIdx, 0, newTask);
        targetBlock.tasks[parentIdx].isCollapsed = false;
        targetBlock.isCollapsed = false;
        this.renderBlocks();
        this.syncContentInput();
        this.focusTaskInput(newTask.id);
    }

    shiftTaskDepth(blockId, taskId, delta) {
        // recordHistory は DOM から tasks を作り直すため、対象タスクを取得する前に呼ぶ
        this.recordHistory();
        const targetBlock = this.blocks.find(b => b.id === blockId);
        if (!targetBlock) return;
        const idx = targetBlock.tasks.findIndex(t => t.id === taskId);
        if (idx === -1) return;

        const task = targetBlock.tasks[idx];
        const current = task.depth || 0;
        // 直上の項目より2段以上深くすると親のいないサブタスクになるため、直上+1 を上限とする
        const prev = targetBlock.tasks[idx - 1];
        const maxDepth = prev && prev.type !== 'image' ? Math.min((prev.depth || 0) + 1, this.MAX_TASK_DEPTH) : 0;
        const next = Math.max(0, Math.min(current + delta, maxDepth));
        if (next === current) return;

        // 子孫も一緒に移動させ、親子関係を崩さない
        for (let i = idx + 1; i < targetBlock.tasks.length && (targetBlock.tasks[i].depth || 0) > current; i++) {
            const child = targetBlock.tasks[i];
            child.depth = Math.max(0, Math.min((child.depth || 0) + (next - current), this.MAX_TASK_DEPTH));
        }
        task.depth = next;
        // 折りたたみ中の親の下へ入れると、操作中の行が隠れてしまう
        this.expandAncestors(targetBlock.tasks, idx);
        this.renderBlocks();
        this.syncContentInput();
        this.focusTaskInput(taskId);
    }

    expandAncestors(tasks, idx) {
        let depth = tasks[idx].depth || 0;
        for (let i = idx - 1; i >= 0 && depth > 0; i--) {
            const ancestorDepth = tasks[i].depth || 0;
            if (ancestorDepth < depth) {
                tasks[i].isCollapsed = false;
                depth = ancestorDepth;
            }
        }
    }

    getDescendantItems(item) {
        const depth = Number(item.dataset.depth) || 0;
        const descendants = [];
        for (let el = item.nextElementSibling;
             el && el.matches('.task-item, .image-item') && (Number(el.dataset.depth) || 0) > depth;
             el = el.nextElementSibling) {
            descendants.push(el);
        }
        return descendants;
    }

    // 子を持たない行の折りたたみボタンは、行頭の位置を揃えるため非表示にするだけで領域は残す
    applyTaskCollapse(blockEl) {
        if (!blockEl) return;
        const items = Array.from(blockEl.querySelectorAll('.task-item, .image-item'));
        let collapsedDepth = Infinity;

        items.forEach((item, i) => {
            const depth = Number(item.dataset.depth) || 0;
            if (depth <= collapsedDepth) collapsedDepth = Infinity;
            item.classList.toggle('task-hidden', depth > collapsedDepth);

            const btn = item.querySelector('.task-collapse-btn');
            if (!btn) return;
            const next = items[i + 1];
            const hasChildren = !!next && (Number(next.dataset.depth) || 0) > depth;
            const isCollapsed = hasChildren && item.dataset.collapsed === 'true';

            btn.classList.toggle('no-children', !hasChildren);
            btn.textContent = isCollapsed ? '▶' : '▼';
            btn.title = isCollapsed ? 'サブタスクを展開' : 'サブタスクを折りたたむ';
            item.classList.toggle('task-collapsed', isCollapsed);
            if (isCollapsed && collapsedDepth === Infinity) collapsedDepth = depth;
        });
    }

    // 折り返しを含めた見た目上の先頭行・最終行にキャレットがあるかを、同じ書式の複製要素の高さで判定する
    isCaretOnEdgeLine(input, dir) {
        if (input.selectionStart !== input.selectionEnd) return false;
        if (input.tagName !== 'TEXTAREA') return true;

        const style = getComputedStyle(input);
        const mirror = document.createElement('div');
        ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'wordBreak']
            .forEach(prop => { mirror.style[prop] = style[prop]; });
        Object.assign(mirror.style, {
            position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px',
            width: `${input.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word'
        });
        document.body.appendChild(mirror);

        const measure = text => { mirror.textContent = text + '\u200b'; return mirror.offsetHeight; };
        const beforeCaret = input.value.slice(0, input.selectionStart);
        const caretHeight = measure(beforeCaret);
        const edgeHeight = dir < 0 ? measure('') : measure(input.value);
        mirror.remove();
        return caretHeight === edgeHeight;
    }

    jumpToAdjacentItem(currentInput, dir) {
        const inputs = Array.from(this.el.blockContainer.querySelectorAll('.task-input, .image-caption-input'))
            .filter(el => el.offsetParent !== null);
        const target = inputs[inputs.indexOf(currentInput) + dir];
        if (!target) return false;

        target.focus();
        const pos = dir < 0 ? target.value.length : 0;
        target.setSelectionRange(pos, pos);
        target.scrollIntoView({ block: 'nearest' });
        return true;
    }

    autoResize(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    }

    updateTasksFromDOM(blockEl, block) {
        const items = blockEl.querySelectorAll('.task-item, .image-item');
        block.tasks = Array.from(items).map(item => {
            const itemId = item.dataset.taskId;
            if (item.classList.contains('image-item')) {
                const orig = (block.tasks || []).find(t => t.id === itemId);
                const captionInput = item.querySelector('.image-caption-input');
                const previewBox = item.querySelector('.image-preview-box');
                const width = item.dataset.width || (previewBox && previewBox.style.width) || (orig && orig.width) || '';
                return {
                    id: itemId,
                    type: 'image',
                    src: (orig && orig.src) || item.dataset.src || '',
                    alt: captionInput ? captionInput.value : ((orig && orig.alt) || ''),
                    width: width,
                    isCompleted: false
                };
            } else {
                return {
                    id: itemId,
                    type: 'task',
                    isCompleted: item.querySelector('.task-checkbox').checked,
                    text: item.querySelector('.task-input').value,
                    depth: Number(item.dataset.depth) || 0,
                    isCollapsed: item.dataset.collapsed === 'true'
                };
            }
        });
        this.syncContentInput();
    }

    // ───────────────────────────────────────
    // リスト描画
    // ───────────────────────────────────────
    renderFileList(filter = '') {
        this.el.noteList.innerHTML = '';

        // modified順（降順） → なければ addedAt 順 でソート
        const sortedFiles = [...this.files].sort((a, b) => {
            const timeA = a.lastModified || a.addedAt || 0;
            const timeB = b.lastModified || b.addedAt || 0;
            return timeB - timeA;
        });

        const filtered = sortedFiles.filter(f =>
            f.name.toLowerCase().includes(filter.toLowerCase())
        );

        if (filtered.length === 0) {
            const msg = this.files.length === 0
                ? 'ファイルが登録されていません'
                : '検索結果なし';
            this.el.noteList.innerHTML =
                `<li style="padding:16px;font-size:0.82rem;color:#6c757d;">${msg}</li>`;
            return;
        }

        filtered.forEach(file => {
            const isActive = file.id === this.activeFileId;
            const needsPerm = !file.permissionGranted;

            const li = document.createElement('li');
            li.className = [
                'note-item',
                isActive     ? 'active'           : '',
                needsPerm    ? 'needs-permission' : '',
                file.isDirty ? 'unsaved'          : ''
            ].join(' ').trim();
            li.dataset.id = file.id;

            const ext = file.name.endsWith('.md') ? 'Markdown' : 'Text';
            const timestamp = file.lastModified || file.addedAt;
            const dateStr = timestamp ? new Date(timestamp).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const titlePrefix = file.isSubject ? '🎯 ' : '';

            li.innerHTML = `
                <div class="note-item-body">
                    <div class="note-item-title">${titlePrefix}${this.escapeHtml(file.name)}</div>
                    <div class="note-item-meta">
                        <span>${ext}</span>
                        ${dateStr ? `<span class="note-item-date">${dateStr}</span>` : ''}
                    </div>
                </div>
                <button class="note-item-remove" title="${file.handle ? 'リストから非表示にする（ファイルは削除されません）' : 'メモを削除する'}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
            `;

            li.querySelector('.note-item-remove')
              .addEventListener('click', e => {
                  e.stopPropagation();
                  this.removeFromList(file.id, e);
              });

            li.addEventListener('click', () => this.selectFile(file.id));
            this.el.noteList.appendChild(li);
        });
    }

    // ───────────────────────────────────────
    // ユーティリティ
    // ───────────────────────────────────────
    async isDuplicate(newHandle) {
        for (const f of this.files) {
            if (!f.handle) continue;
            try { if (await f.handle.isSameEntry(newHandle)) return true; } catch { /* skip */ }
        }
        return false;
    }

    showEmptyState() {
        this.el.emptyState.classList.remove('hidden');
        this.el.activeState.classList.add('hidden');
    }

    showActiveState() {
        this.el.emptyState.classList.add('hidden');
        this.el.activeState.classList.remove('hidden');
    }

    updateCharCount() {
        this.el.charCount.textContent = `${this.el.contentInput.value.length} 文字`;
    }

    escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.noteInApp = new NoteIn();
});
