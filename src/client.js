/* dsh-everything-search 客户端 bundle：无构建步骤，手写 __ModuleLoader__ 格式。
 *
 * 职责：占用 ui-workspace 声明的两个 directoryFlow slot（侧栏「新建工作区」
 * 与对话空态的工作区选择），用 DSH 自己的 UI 原语（Modal / Button / Input /
 * 图标，均来自平台 seed 模块 @deepseek-ai/dsh-client-ui-primitives）渲染
 * 「选择工作区目录」对话框：
 *   - 左栏：最近使用 / 快速访问 / 此电脑（盘符）
 *   - 右栏：逐级浏览（面包屑 + 双击进入 + 上一级）或 Everything 搜索结果
 *   - 顶部：搜索框，输入即用 Everything 搜文件夹（宿主端 es.exe）
 * 宿主能力全部经同源 /api/dsh-everything-search.* RPC 获取。
 */
window.__ModuleLoader__.load({ id: "dsh-everything-search", factory: (require) => {
	var module = { exports: {} }; var exports = module.exports;

	const React = require("react");
	const { createElement: h, useState, useEffect, useRef, useCallback, useMemo, Component } = React;

	/**
	 * 平台 seed 模块（@deepseek-ai/dsh-client-ui-primitives）。
	 * 它属于「随版本可能变动」的接口面：一旦被移出 seed 或某个导出改名，
	 * 顶层 require 抛错会让整个 bundle 加载失败、对话框完全不出现。
	 * 所以这里降级为「能拿到就用、拿不到就用自带 DOM 渲染」（两套外观都由本文件自带 CSS 兜底）。
	 */
	let primitivesError = null;
	const primitives = (() => {
		try {
			return require("@deepseek-ai/dsh-client-ui-primitives") ?? {};
		} catch (error) {
			primitivesError = String(error?.message ?? error);
			console.warn("[dsh-everything-search] 平台 seed 模块不可用，改用自带 DOM 渲染：", error);
			return {};
		}
	})();

	/** 实际用的是平台原语还是自带降级（写进 client-loaded 事件，便于无 token 排障）。 */
	const primitivesKind = typeof primitives.Modal === "function" ? "seed" : "fallback";
	/** 原语 CSS 探针结果（临时诊断，见 apply 里的 probePrimitives）。 */
	let probeReport = null;

	/** 取一个原子/图标：类型不对就退回 fallback（图标退回空组件）。 */
	const pick = (name, fallback) => {
		const value = primitives[name];
		return typeof value === "function" ? value : fallback;
	};

	/** 图标缺失时的空组件：不影响布局，也不会让 React 抛「Element type is invalid」。 */
	const NullIcon = () => null;

	/** 自带 Modal（平台 Modal 缺失时使用）：固定定位遮罩 + 卡片，Esc/遮罩关闭。 */
	function FallbackModal(props) {
		const open = props.open === true;
		const onClose = props.onClose;
		useEffect(() => {
			if (!open) return;
			const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
			document.addEventListener("keydown", onKeyDown);
			return () => document.removeEventListener("keydown", onKeyDown);
		}, [open, onClose]);
		if (!open) return null;
		const className = props.className === undefined ? "edsFallbackCard" : "edsFallbackCard " + props.className;
		return h("div", { className: "edsFallbackRoot", role: "presentation" }, [
			h("div", { className: "edsFallbackMask", key: "mask", "aria-hidden": "true", onClick: onClose }),
			h("div", { className: className, key: "card", role: "dialog", "aria-modal": "true", "aria-label": props.title }, [
				h("div", { className: "edsFallbackHeader", key: "header" }, [
					h("h2", { className: "edsFallbackTitle", key: "title" }, props.title),
					h("button", {
						className: "edsFallbackClose", key: "close", type: "button",
						"aria-label": props.closeLabel ?? "close", onClick: onClose,
					}, "✕"),
				]),
				props.children === undefined ? null : props.children,
				props.footer === undefined ? null : h("div", { className: "edsFallbackFooter", key: "footer" }, props.footer),
			]),
		]);
	}

	/** 自带 Button：变体只区分主/次，够用即可。 */
	function FallbackButton(props) {
		const { variant, size, icon, className, children, ...rest } = props;
		const classes = ["edsFallbackButton"];
		if (variant === "primary") classes.push("edsFallbackButtonPrimary");
		if (className !== undefined && className !== null && className !== "") classes.push(String(className));
		return h("button", { type: "button", className: classes.join(" "), ...rest }, [
			icon === undefined || icon === null ? null : h("span", { className: "edsFallbackIcon", key: "i" }, icon),
			children === undefined || children === null ? null : h("span", { key: "l" }, children),
		]);
	}

	/** 自带 Input：单行输入 + 可选前置图标。 */
	function FallbackInput(props) {
		const { icon, className, ...rest } = props;
		const classes = ["edsFallbackInputWrap"];
		if (className !== undefined && className !== null && className !== "") classes.push(String(className));
		return h("span", { className: classes.join(" ") }, [
			icon === undefined || icon === null ? null : h("span", { className: "edsFallbackIcon", key: "i" }, icon),
			h("input", { className: "edsFallbackInput", key: "in", ...rest }),
		]);
	}

	const RawModal = pick("Modal", FallbackModal);
	const RawButton = pick("Button", FallbackButton);
	const RawInput = pick("Input", FallbackInput);

	/**
	 * 带自带类名的 Button / Input 包装：
	 * 外观由本插件自己的 CSS（.edsBtn / .edsInputWrap）保证，不依赖宿主原语的 CSS Module——
	 * 实测桌面版某些版本里原语组件能取到、但它们自己的样式没生效（按钮/输入框变成裸控件）。
	 * 行为（点击、禁用、焦点）仍走宿主原语。
	 */
	function Button(props) {
		const classes = ["edsBtn"];
		if (props.variant === "primary") classes.push("edsBtnPrimary");
		else if (props.variant === "ghost") classes.push("edsBtnGhost");
		else classes.push("edsBtnOutline");
		if (props.size === "sm") classes.push("edsBtnSm");
		if (typeof props.className === "string" && props.className !== "") classes.push(props.className);
		return h(RawButton, { ...props, className: classes.join(" ") });
	}

	function Input(props) {
		const classes = ["edsInputWrap"];
		if (typeof props.className === "string" && props.className !== "") classes.push(props.className);
		return h(RawInput, { ...props, className: classes.join(" ") });
	}

	const Modal = RawModal;
	const IconSearchOutlineRegular = pick("IconSearchOutlineRegular", NullIcon);
	const IconChevronRightOutlineRegular = pick("IconChevronRightOutlineRegular", NullIcon);
	const IconChevronUpOutlineRegular = pick("IconChevronUpOutlineRegular", NullIcon);
	const IconChevronDownOutlineRegular = pick("IconChevronDownOutlineRegular", NullIcon);
	const IconFolderCloseRegular = pick("IconFolderCloseRegular", NullIcon);
	const IconFolderOpenRegular = pick("IconFolderOpenRegular", NullIcon);
	const IconClockOutlineRegular = pick("IconClockOutlineRegular", NullIcon);
	const IconProjectAddOutlineRegular = pick("IconProjectAddOutlineRegular", NullIcon);
	const IconDatabaseOutlineRegular = pick("IconDatabaseOutlineRegular", NullIcon);
	const IconCheckOutlineRegular = pick("IconCheckOutlineRegular", NullIcon);
	const IconCloseOutlineRegular = pick("IconCloseOutlineRegular", NullIcon);

	const NS = "dsh-everything-search";
	const PREFIX = NS + ".";
	const RECENTS_KEY = NS + ".recents.v1";
	const RECENTS_OPEN_KEY = NS + ".recentsOpen.v1";
	/** 最近使用最多留 5 条。 */
	const RECENTS_MAX = 5;
	const SEARCH_DEBOUNCE_MS = 160;
	const SEARCH_MIN_CHARS = 1;

	const zh = {
		title: "选择工作区目录",
		close: "关闭",
		searchPlaceholder: "搜索文件夹（Everything 索引，输入即搜）",
		searchClear: "清空搜索",
		recents: "最近使用",
		quick: "快速访问",
		drives: "此电脑",
		home: "主目录",
		desktop: "桌面",
		downloads: "下载",
		documents: "文档",
		pictures: "图片",
		music: "音乐",
		videos: "视频",
		up: "上一级",
		newFolder: "新建文件夹",
		newFolderPlaceholder: "文件夹名称",
		create: "创建",
		cancel: "取消",
		choose: "选择此文件夹",
		current: "当前",
		selected: "已选",
		empty: "这个目录下没有子文件夹",
		startHint: "从左侧选盘符逐级浏览，或在上方输入关键词用 Everything 直接搜文件夹",
		results: "条结果",
		searchScope: "Everything 搜索",
		blockedShow: "已屏蔽",
		blockedHide: "隐藏已屏蔽",
		blockedBadge: "已屏蔽",
		renameAria: "文件夹名称",
		renameFailed: "重命名失败：",
		renameHint: "F2 重命名",
		renameNeedsRestart: "重命名需要重启一次 DSH：改名是宿主端能力，客户端已就绪，宿主端端点要重启后才会加载。",
		loading: "加载中…",
		searching: "正在搜索…",
		searchEmpty: "没有匹配的文件夹",
		searchHint: "输入关键词，用 Everything 直接搜全盘文件夹",
		searchUnavailable: "Everything 搜索不可用（手动浏览不受影响）：",
		free: "可用",
		confirmCreate: "确定",
	};
	const en = {
		title: "Select Workspace Directory",
		close: "Close",
		searchPlaceholder: "Search folders (Everything index, instant)",
		searchClear: "Clear search",
		recents: "Recent",
		quick: "Quick access",
		drives: "This PC",
		home: "Home",
		desktop: "Desktop",
		downloads: "Downloads",
		documents: "Documents",
		pictures: "Pictures",
		music: "Music",
		videos: "Videos",
		up: "Up one level",
		newFolder: "New folder",
		newFolderPlaceholder: "Folder name",
		create: "Create",
		cancel: "Cancel",
		choose: "Select this folder",
		current: "Current",
		selected: "Selected",
		empty: "No subfolders here",
		startHint: "Pick a drive on the left to browse, or type above to search every indexed folder",
		results: "results",
		searchScope: "Everything search",
		blockedShow: "Hidden",
		blockedHide: "Hide blocked",
		blockedBadge: "blocked",
		renameAria: "Folder name",
		renameFailed: "Rename failed: ",
		renameHint: "F2 to rename",
		renameNeedsRestart: "Renaming needs one DSH restart: it is a host-side capability, and the endpoint loads only after a restart.",
		loading: "Loading…",
		searching: "Searching…",
		searchEmpty: "No matching folders",
		searchHint: "Type to search every indexed folder through Everything",
		searchUnavailable: "Everything search unavailable (manual browsing still works): ",
		free: "free",
		confirmCreate: "OK",
	};

	/** 样式：全部走 DSH 主题 token，浅色/深色自动跟随。 */
	const CSS = `
.edsDialog.edsDialog {
	width: min(760px, 100%);
	max-width: calc(100vw - 32px);
	/* 底部必须留白：Modal 卡片默认是 padding 0 0 24px，清零会让 footer
	 * 贴住卡片下边缘，卡片那条底线就会切到按钮上。 */
	padding: 0 0 20px;
	gap: 0;
	--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
	--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.edsBody { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px 8px; }
.edsSearchRow { display: flex; align-items: center; gap: 8px; }
/* 只用专门的类做「撑满整行」，绝不用「父容器 > span」这种宽选择器：
 * 否则行内其它 span（例如曾经的加载转圈）也会被 flex:1 横向拉长，
 * 12px 高的椭圆配上旋转动画就会在某一帧变成一条竖直长条。 */
.edsSearchField { flex: 1 1 auto; min-width: 0; display: flex; }
/* DSH 的 Input 外壳是 inline-flex（按内容宽度），这里让它撑满整行 */
.edsSearchField > span, .edsCreateField > span { flex: 1 1 auto; min-width: 0; width: 100%; }
.edsSearchField input, .edsCreateField input { width: 100%; }
.edsColumns { display: flex; gap: 12px; height: min(380px, 48vh); }
.edsRail { width: 176px; flex: none; overflow: auto; padding-right: 6px; border-right: 0.5px solid var(--dsw-alias-border-l2); }
.edsRailGroup { padding: 8px 8px 2px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
/* 可折叠的分组标题（最近使用）：整行可点，右侧带条目数。 */
.edsRailGroupButton { display: flex; align-items: center; gap: 4px; width: 100%; padding: 6px 8px 2px; border: 0; background: transparent; font: inherit; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); text-align: left; cursor: pointer; }
.edsRailGroupButton:hover { color: var(--dsw-alias-label-secondary); }
.edsRailCaret { flex: none; display: inline-flex; align-items: center; }
.edsRailGroupLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edsRailItem { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px; text-align: left; cursor: pointer; }
.edsRailItem:hover { background: var(--dsw-alias-bg-layer-2); }
.edsRailItem[data-active="true"] { background: var(--dsw-alias-bg-multi-select); }
.edsRailLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edsRailMeta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.edsMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.edsHead { display: flex; align-items: center; gap: 6px; min-height: 26px; }
.edsCrumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; overflow: hidden; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.edsCrumb { border: 0; background: transparent; padding: 2px 4px; border-radius: 6px; font: inherit; color: inherit; cursor: pointer; white-space: nowrap; }
.edsCrumb:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.edsCrumbLast { color: var(--dsw-alias-label-primary); font-weight: 510; }
.edsCrumbSep { color: var(--dsw-alias-label-tertiary); flex: none; }
.edsList { flex: 1; min-height: 0; overflow: auto; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 4px; }
.edsRow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; font-size: 13px; line-height: 18px; cursor: default; }
.edsRow:hover { background: var(--dsw-alias-bg-layer-2); }
.edsRow[data-selected="true"] { background: var(--dsw-alias-bg-multi-select); }
/* 被屏蔽的条目只在「显示已屏蔽」时出现，置灰以便一眼区分。 */
.edsRow[data-blocked="true"] { opacity: 0.55; }
.edsRowIcon { flex: none; display: flex; color: var(--dsw-alias-label-secondary); }
.edsRowName { flex: none; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
/* 改名行：整行变输入框（宽度随行伸展），其余列照旧。 */
.edsRenameField { flex: 1 1 auto; min-width: 0; display: flex; }
.edsRenameField > span { flex: 1 1 auto; min-width: 0; width: 100%; }
.edsRenameField input { width: 100%; }
.edsRowName b { font-weight: 600; color: var(--dsw-alias-brand-primary); }
.edsRowMeta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.edsRowBadge { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.edsHint { padding: 10px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.edsAlert { margin: 0 4px 4px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.edsCreateRow { display: flex; align-items: center; gap: 6px; }
.edsCreateField { flex: 1 1 auto; min-width: 0; display: flex; }
.edsFooter { display: flex; align-items: center; gap: 8px; width: 100%; padding-top: 12px; }
.edsFooterPath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* ---- 控件外观自带：不依赖宿主原语的 CSS Module，按 DSH token 对齐 ---- */
.edsBtn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 20px; white-space: nowrap; cursor: pointer; }
.edsBtn:hover:enabled { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.edsBtn:disabled { opacity: 0.5; cursor: default; }
.edsBtnSm { height: 28px; padding: 0 10px; font-size: 13px; }
.edsBtnOutline { background: var(--dsw-alias-bg-layer-1); }
.edsBtnGhost { border-color: transparent; background: transparent; }
.edsBtnPrimary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, #fff); }
.edsBtnPrimary:hover:enabled { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); filter: brightness(1.06); }
.edsInputWrap { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.edsInputWrap:focus-within { border-color: var(--dsw-alias-brand-primary); }
.edsInputWrap input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.edsInputWrap input::placeholder { color: var(--dsw-alias-label-dimmed); }
/* 卡片兜底：即使宿主 Modal 的样式没生效，也还是圆角卡片 */
.edsDialog.edsDialog { border-radius: 24px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); }

/* ---- 降级渲染（平台 seed 模块拿不到时）自带的外观，按 DSH token 对齐原语 ---- */
.edsFallbackRoot { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-top-clearance, 24px)) 24px; }
.edsFallbackMask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }
.edsFallbackCard { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 0; overflow: hidden; border-radius: 24px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); }
.edsFallbackHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.edsFallbackTitle { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.edsFallbackClose { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 14px; cursor: pointer; }
.edsFallbackClose:hover { background: var(--dsw-alias-interactive-bg-hover); }
.edsFallbackFooter { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.edsFallbackButton { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 20px; cursor: pointer; }
.edsFallbackButton:hover:enabled { background: var(--dsw-alias-bg-layer-2); }
.edsFallbackButton:disabled { opacity: 0.5; cursor: default; }
.edsFallbackButtonPrimary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, #fff); }
.edsFallbackButtonPrimary:hover:enabled { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); filter: brightness(1.06); }
.edsFallbackIcon { display: inline-flex; align-items: center; justify-content: center; color: inherit; }
.edsFallbackInputWrap { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.edsFallbackInputWrap:focus-within { border-color: var(--dsw-alias-brand-primary); }
.edsFallbackInput { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.edsFallbackInput::placeholder { color: var(--dsw-alias-label-dimmed); }
.edsCrash { display: flex; flex-direction: column; gap: 8px; margin: 12px 24px; padding: 14px 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.edsCrashTitle { font-size: 14px; font-weight: 600; }
.edsCrashBody { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.edsCrashHint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
`;

	/* ------------------------------------------------------------------ *
	 * 小工具
	 * ------------------------------------------------------------------ */

	function messageOf(error) {
		if (error === null || error === undefined) return "unknown error";
		if (typeof error === "string") return error;
		return typeof error.message === "string" ? error.message : String(error);
	}

	function parentOf(path) {
		if (typeof path !== "string" || path === "") return null;
		const trimmed = path.replace(/[\\/]+$/, "");
		if (/^[A-Za-z]:$/.test(trimmed)) return null;
		const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
		if (index < 0) return null;
		const parent = trimmed.slice(0, index);
		return parent === "" ? null : (/^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent);
	}

	function segmentsOf(path) {
		if (typeof path !== "string" || path === "") return [];
		const out = [];
		let rest = path;
		if (/^[A-Za-z]:/.test(rest)) {
			out.push({ label: rest.slice(0, 2), path: rest.slice(0, 2) + "\\" });
			rest = rest.slice(2);
		}
		for (const part of rest.split(/[\\/]+/)) {
			if (part === "") continue;
			const base = out.length > 0 ? out[out.length - 1].path : "";
			const next = base.endsWith("\\") ? base + part : base + "\\" + part;
			out.push({ label: part, path: next });
		}
		return out;
	}

	function formatBytes(value) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
		const units = ["B", "KB", "MB", "GB", "TB"];
		let index = 0;
		let size = value;
		while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
		return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
	}

	/** 把命中片段加粗。 */
	function highlight(text, query) {
		const needle = query.trim();
		if (needle === "") return [text];
		const lower = text.toLowerCase();
		const target = needle.toLowerCase();
		const parts = [];
		let cursor = 0;
		for (;;) {
			const at = lower.indexOf(target, cursor);
			if (at < 0) break;
			if (at > cursor) parts.push(text.slice(cursor, at));
			parts.push(h("b", { key: "m" + at }, text.slice(at, at + target.length)));
			cursor = at + target.length;
		}
		if (cursor === 0) return [text];
		if (cursor < text.length) parts.push(text.slice(cursor));
		return parts;
	}

	function readRecents() {
		try {
			const raw = window.localStorage.getItem(RECENTS_KEY);
			const parsed = raw === null ? [] : JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string").slice(0, RECENTS_MAX) : [];
		} catch {
			return [];
		}
	}

	function writeRecents(list) {
		try { window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX))); } catch { /* 无 localStorage 无妨 */ }
	}

	/** 最近使用栏的展开状态（默认展开，记住上次选择）。 */
	function readRecentsOpen() {
		try {
			return window.localStorage.getItem(RECENTS_OPEN_KEY) !== "0";
		} catch {
			return true;
		}
	}

	function writeRecentsOpen(open) {
		try { window.localStorage.setItem(RECENTS_OPEN_KEY, open ? "1" : "0"); } catch { /* 无 localStorage 无妨 */ }
	}

	/**
	 * 内置噪声规则（与宿主端 src/index.js 的 DEFAULT_NOISE 一致）：
	 * AI 工具普遍把工作目录编码进文件夹名（`E:\OpencodeProject\x` → `E--OpencodeProject-x`、
	 * `-e-OpencodeProject-…`，非 ASCII 走 `~XXXX~` 十六进制转义），所以按名字形状判定；
	 * paths 只覆盖少数已知的状态目录树。宿主可通过 config.json 扩展，并经 `noise` 端点下发。
	 */
	const DEFAULT_NOISE_NAMES = ["^--", "^-{1,2}[A-Za-z]-", "^[A-Za-z]-{2}", "~[0-9A-Fa-f]{4}~", "-{5,}"];
	const DEFAULT_NOISE_PATHS = [
		"\\\\.dsh\\\\sessions\\\\",
		"\\\\.trae-cn\\\\memory\\\\projects\\\\",
		"\\\\.qoder-cn\\\\(logs|projects|tmp|sessions)\\\\",
		"\\\\.codex\\\\sessions\\\\",
		"\\\\.claude\\\\projects\\\\",
	];

	/** 编译规则字符串；坏正则跳过（不因为一条坏规则让整个对话框失灵）。 */
	function compileNoise(sources) {
		const out = [];
		for (const source of Array.isArray(sources) ? sources : []) {
			if (typeof source !== "string" || source === "") continue;
			try {
				out.push(new RegExp(source, "i"));
			} catch { /* 跳过坏规则 */ }
		}
		return out;
	}

	/** 默认规则编译结果（宿主规则取回之前先用它）。 */
	const DEFAULT_NOISE_MATCHER = {
		names: compileNoise(DEFAULT_NOISE_NAMES),
		paths: compileNoise(DEFAULT_NOISE_PATHS),
	};

	/**
	 * 是否属于「噪声目录」：AI 工具自己的会话/临时目录，默认不显示。
	 * @param path - 绝对路径。
	 * @param matcher - 已编译规则（宿主下发或内置）。
	 * @returns 是否应从结果/列表/最近使用里剔除。
	 */
	function isNoisePath(path, matcher) {
		if (typeof path !== "string" || path === "") return false;
		const normalized = path.replace(/\//g, "\\");
		const base = normalized.replace(/\\+$/, "").split("\\").filter(Boolean).slice(-1)[0] ?? "";
		const rules = matcher ?? DEFAULT_NOISE_MATCHER;
		if (rules.names.some(re => re.test(base))) return true;
		return rules.paths.some(re => re.test(normalized + "\\"));
	}

	/* ------------------------------------------------------------------ *
	 * RPC：优先 connection.rpc.call，退回同源 fetch
	 * ------------------------------------------------------------------ */

	function makeCall(rpc) {
		async function plain(endpoint, payload) {
			const response = await fetch("/api/" + PREFIX + endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload ?? {}),
			});
			let json;
			try { json = await response.json(); } catch { throw new Error("HTTP " + response.status); }
			const result = json !== null && typeof json === "object" && json.type === "server-response" && json.result !== undefined
				? json.result
				: json;
			if (result !== null && typeof result === "object" && result.ok === true) return result.value;
			const error = result !== null && typeof result === "object" && result.error !== undefined ? result.error : null;
			const failure = new Error(error !== null && typeof error.message === "string" ? error.message : "request failed");
			if (error !== null && typeof error.code === "string") failure.code = error.code;
			throw failure;
		}
		return async function call(endpoint, payload) {
			const body = payload ?? {};
			if (rpc !== undefined && rpc !== null && typeof rpc.call === "function") {
				try {
					const result = await rpc.call("/api", PREFIX + endpoint, body);
					if (result !== null && typeof result === "object" && result.ok === true) return result.value;
					const error = result !== null && typeof result === "object" ? result.error : null;
					const failure = new Error(error !== null && typeof error.message === "string" ? error.message : "request failed");
					if (error !== null && typeof error.code === "string") failure.code = error.code;
					throw failure;
				} catch (error) {
					// 带业务码的错误直接上抛；只有通道/信封层异常才走兼容通道
					if (error !== null && typeof error === "object" && typeof error.code === "string") throw error;
				}
			}
			return await plain(endpoint, body);
		};
	}

	/* ------------------------------------------------------------------ *
	 * 对话框
	 * ------------------------------------------------------------------ */

	function EverythingDirectoryFlow(props) {
		const open = props.open === true;
		const busy = props.busy === true;
		const onPicked = typeof props.onPicked === "function" ? props.onPicked : () => {};
		const onCancel = typeof props.onCancel === "function" ? props.onCancel : () => {};
		const call = props.call;
		const t = typeof props.t === "function" ? props.t : (key) => zh[key] ?? key;

		const [status, setStatus] = useState(null);
		const [places, setPlaces] = useState({ home: null, quick: [] });
		const [driveRows, setDriveRows] = useState([]);
		const [view, setView] = useState(null);
		const [viewError, setViewError] = useState(null);
		const [loading, setLoading] = useState(false);
		const [selected, setSelected] = useState(-1);
		const [query, setQuery] = useState("");
		const [results, setResults] = useState(null);
		const [searching, setSearching] = useState(false);
		const [searchError, setSearchError] = useState(null);
		const [recents, setRecents] = useState([]);
		const [recentsOpen, setRecentsOpen] = useState(true);
		const [noiseMatcher, setNoiseMatcher] = useState(DEFAULT_NOISE_MATCHER);
		const [showBlocked, setShowBlocked] = useState(false);
		const [creating, setCreating] = useState(false);
		const [newName, setNewName] = useState("");
		const [createError, setCreateError] = useState(null);
		/** 正在重命名的行：{ path, name, original }；null = 未在改名。 */
		const [renaming, setRenaming] = useState(null);
		const [renameError, setRenameError] = useState(null);
		/** 宿主端是否已加载新端点（用 `noise` 探测：它和 `rename` 是同一批加的）。 */
		const [hostReady, setHostReady] = useState(true);
		/** 搜索重跑计数（改名后刷新结果用）。 */
		const [searchTick, setSearchTick] = useState(0);

		const seqRef = useRef(0);
		const searchWrapRef = useRef(null);
		const listRef = useRef(null);
		const renameWrapRef = useRef(null);

		/** Input 是普通函数组件（不吃 ref），聚焦要落到它内部的原生 input 上。 */
		const focusSearch = useCallback(() => {
			try { searchWrapRef.current?.querySelector("input")?.focus(); } catch { /* 忽略 */ }
		}, []);

		// 进入改名态：聚焦并全选（Windows 资源管理器的 F2 语义）。
		useEffect(() => {
			if (renaming === null) return;
			const input = renameWrapRef.current?.querySelector("input");
			if (input === null || input === undefined) return;
			try { input.focus(); input.select(); } catch { /* 忽略 */ }
		}, [renaming]);

		const searchMode = query.trim() !== "";

		/** 刷新当前目录；selectPath 用于改名后把选中项落回改名后的那一条。 */
		const navigate = useCallback((path, selectPath) => {
			const seq = ++seqRef.current;
			setLoading(true);
			setViewError(null);
			setQuery("");
			setResults(null);
			setSearchError(null);
			setCreating(false);
			setCreateError(null);
			setRenaming(null);
			setRenameError(null);
			return call("list", { path }).then((listing) => {
				if (seq !== seqRef.current) return;
				setView(listing);
				const wanted = typeof selectPath === "string" ? selectPath : null;
				const index = wanted === null ? -1
					: (listing?.entries ?? []).findIndex(entry => entry.path.toLowerCase() === wanted.toLowerCase());
				setSelected(index);
			}).catch((error) => {
				if (seq !== seqRef.current) return;
				setViewError(messageOf(error));
			}).finally(() => {
				if (seq === seqRef.current) setLoading(false);
			});
		}, [call]);

		// 每次打开：重置状态并加载左栏数据（最近使用 / 快速访问 / 盘符 / 搜索可用性）。
		useEffect(() => {
			if (!open) return;
			setQuery("");
			setResults(null);
			setSearchError(null);
			setSelected(-1);
			setCreating(false);
			setCreateError(null);
			setViewError(null);
			// 视图也要重置：重新打开时必须从「快速访问 / 此电脑」开始，
			// 否则会残留上次浏览的目录（点左栏盘符时看起来"没反应"，实际是旧列表还在）。
			setView(null);
			setLoading(false);
			setRecents(readRecents());
			setRecentsOpen(readRecentsOpen());
			setShowBlocked(false);
			setRenaming(null);
			setRenameError(null);
			let alive = true;
			Promise.all([
				call("places").catch(() => ({ home: null, quick: [] })),
				call("drives").catch(() => []),
				call("status").catch(() => null),
				// 宿主下发的噪声规则（含 config.json 的扩展）；拿不到就用内置规则。
				call("noise").catch(() => null),
			]).then(([placesValue, drivesValue, statusValue, noiseValue]) => {
				if (!alive) return;
				setPlaces(placesValue ?? { home: null, quick: [] });
				setDriveRows(Array.isArray(drivesValue) ? drivesValue : []);
				setStatus(statusValue ?? null);
				// `noise` 与 `rename` 是同一批新增的宿主端点：它拿不到就说明宿主还是旧版，
				// 此时按 F2 给「需要重启」的提示，而不是抛一个 HTTP 404。
				setHostReady(noiseValue !== null && noiseValue !== undefined);
				if (noiseValue !== null && noiseValue !== undefined) {
					const names = compileNoise(noiseValue.names);
					const paths = compileNoise(noiseValue.paths);
					if (names.length > 0 || paths.length > 0) setNoiseMatcher({ names, paths });
				}
			});
			const timer = setTimeout(() => { focusSearch(); }, 30);
			return () => { alive = false; clearTimeout(timer); };
		}, [open, call, focusSearch]);

		// 输入即搜（去抖）；空查询回到浏览模式。
		useEffect(() => {
			if (!open) return;
			const trimmed = query.trim();
			if (trimmed.length < SEARCH_MIN_CHARS) {
				setResults(null);
				setSearchError(null);
				setSearching(false);
				return;
			}
			setSearching(true);
			const timer = setTimeout(() => {
				const seq = ++seqRef.current;
				call("search", { query: trimmed, limit: 80 }).then((found) => {
					if (seq !== seqRef.current) return;
					const rows = Array.isArray(found?.results) ? found.results : [];
					setResults(rows);
					setSelected(rows.length > 0 ? 0 : -1);
					setSearchError(null);
				}).catch((error) => {
					if (seq !== seqRef.current) return;
					setResults([]);
					setSelected(-1);
					setSearchError(messageOf(error));
				}).finally(() => {
					if (seq === seqRef.current) setSearching(false);
				});
			}, SEARCH_DEBOUNCE_MS);
			return () => clearTimeout(timer);
		}, [query, open, call, searchTick]);

		// 搜索结果与目录列表先按噪声规则分组：默认只显示「干净」的那些，
		// 被屏蔽的条目可以点「已屏蔽 N 项」临时显示出来（带标记、置灰）。
		const allRows = searchMode
			? (Array.isArray(results) ? results : [])
				.map(row => ({ name: row.name, path: row.full, meta: row.path, icon: "folder" }))
			: (view?.entries ?? [])
				.map(row => ({ name: row.name, path: row.path, meta: null, icon: "folder", hidden: row.hidden === true }));
		const cleanRows = [];
		const blockedRows = [];
		for (const row of allRows) {
			if (isNoisePath(row.path, noiseMatcher)) blockedRows.push({ ...row, blocked: true });
			else cleanRows.push(row);
		}
		const rows = showBlocked ? [...cleanRows, ...blockedRows] : cleanRows;
		const blockedCount = blockedRows.length;

		// 选中某一行时，右下角按钮选中的就是它（搜索态与浏览态一致）；
		// 浏览态没有选中项时，才回落到「当前目录」。
		const selectedRow = selected >= 0 ? rows[selected] : undefined;
		const target = selectedRow !== undefined
			? selectedRow.path
			: (searchMode ? null : (view?.path ?? null));

		const remember = useCallback((path) => {
			setRecents((previous) => {
				const next = [path, ...previous.filter(item => item !== path)].slice(0, RECENTS_MAX);
				writeRecents(next);
				return next;
			});
		}, []);

		const confirm = useCallback((path) => {
			const value = typeof path === "string" ? path : target;
			if (busy || value === null || value === undefined || value === "") return;
			remember(value);
			onPicked(value);
		}, [busy, target, remember, onPicked]);

		/** 进入改名态（F2 语义）。 */
		const startRename = useCallback((row) => {
			if (row === null || row === undefined || busy) return;
			setRenaming(null);
			if (hostReady !== true) {
				// 宿主端还没有 rename 端点：给出可执行的提示，不进入编辑态
				setRenameError(t("renameNeedsRestart"));
				return;
			}
			setRenameError(null);
			setRenaming({ path: row.path, name: row.name, original: row.name });
		}, [busy, hostReady, t]);

		const cancelRename = useCallback(() => {
			setRenaming(null);
			setRenameError(null);
		}, []);

		/**
		 * 提交改名：成功后刷新（浏览态回到当前目录并选中新名字；搜索态重跑查询）。
		 * @param value - 显式传入的名字（来自输入框的 DOM 值）。不传则用状态里的草稿；
		 *   显式传入是为了不受 React 批处理影响——同一 tick 内改值再回车时，
		 *   闭包里的 renaming 仍是旧值。
		 */
		const commitRename = useCallback((value) => {
			if (renaming === null) return;
			const name = (typeof value === "string" ? value : renaming.name).trim();
			const current = renaming;
			if (name === "" || name === current.original) { cancelRename(); return; }
			setRenameError(null);
			call("rename", { path: current.path, name }).then((result) => {
				setRenaming(null);
				const renamedPath = result?.path ?? current.path;
				// 搜索态下重跑旧关键词会搜不到改名后的项，所以直接跳到它所在的目录并选中它；
				// 浏览态则刷新当前目录。
				const parent = parentOf(renamedPath);
				if (searchMode && parent !== null) void navigate(parent, renamedPath);
				else if (view !== null) void navigate(view.path, renamedPath);
			}).catch((error) => {
				setRenameError(messageOf(error));
			});
		}, [renaming, call, searchMode, view, navigate, cancelRename]);

		/** 卡片作用域按键：F2 改名；改名/新建文件夹态下 Esc 先归它们（不让 Modal 关窗）。 */
		const onCardKeyDown = (event) => {
			if (event.key === "Escape") {
				if (renaming !== null) { event.stopPropagation(); cancelRename(); return; }
				if (creating) { event.stopPropagation(); setCreating(false); return; }
				return;
			}
			if (event.key !== "F2" || renaming !== null) return;
			const node = event.target;
			const inField = node !== null && node !== undefined
				&& (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable === true);
			if (inField) return;
			const row = selected >= 0 ? rows[selected] : undefined;
			if (row === undefined) return;
			event.preventDefault();
			startRename(row);
		};

		const move = useCallback((delta) => {
			setSelected((previous) => {
				if (rows.length === 0) return -1;
				const base = previous < 0 ? (delta > 0 ? -1 : 0) : previous;
				const next = Math.min(rows.length - 1, Math.max(0, base + delta));
				try { listRef.current?.querySelector('[data-row="' + next + '"]')?.scrollIntoView({ block: "nearest" }); } catch { /* 忽略 */ }
				return next;
			});
		}, [rows.length]);

		const submitCreate = useCallback(() => {
			const name = newName.trim();
			if (name === "" || view === null) return;
			call("mkdir", { parent: view.path, name }).then((created) => {
				setCreating(false);
				setNewName("");
				setCreateError(null);
				navigate(created.path);
			}).catch((error) => setCreateError(messageOf(error)));
		}, [newName, view, call, navigate]);

		const onSearchKeyDown = (event) => {
			if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
			if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
			if (event.key === "Enter") {
				event.preventDefault();
				// 搜索态与浏览态一致：回车=进入选中的文件夹（选定工作区一律走右下角按钮）。
				if (selected >= 0 && rows[selected] !== undefined) navigate(rows[selected].path);
				else if (!searchMode) confirm();
			}
		};

		const onListKeyDown = (event) => {
			if (searchMode) return;
			if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
			else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
			else if (event.key === "Enter") {
				event.preventDefault();
				if (selected >= 0 && rows[selected] !== undefined) navigate(rows[selected].path);
				else confirm();
			}
		};

		const railItem = (key, label, path, meta, icon, active) => h("button", {
			key: key,
			type: "button",
			className: "edsRailItem",
			"data-active": active === true ? "true" : "false",
			title: path,
			onClick: () => navigate(path),
		}, [
			h("span", { className: "edsRowIcon", key: "i" }, icon),
			h("span", { className: "edsRailLabel", key: "l" }, label),
			meta === null || meta === undefined ? null : h("span", { className: "edsRailMeta", key: "m" }, meta),
		]);

		const rail = [];
		// 最近使用：可折叠，最多 5 条，且过滤掉噪声目录（DSH 会话目录等）。
		const visibleRecents = recents.filter(path => !isNoisePath(path, noiseMatcher));
		if (visibleRecents.length > 0) {
			rail.push(h("button", {
				key: "g-recents",
				type: "button",
				className: "edsRailGroup edsRailGroupButton",
				"aria-expanded": recentsOpen ? "true" : "false",
				title: t("recents"),
				onClick: () => {
					const next = !recentsOpen;
					setRecentsOpen(next);
					writeRecentsOpen(next);
				},
			}, [
				h("span", { className: "edsRailCaret", key: "caret" },
					h(recentsOpen ? IconChevronDownOutlineRegular : IconChevronRightOutlineRegular, { size: 12 })),
				h("span", { className: "edsRailGroupLabel", key: "label" }, t("recents")),
				h("span", { className: "edsRailMeta", key: "count" }, String(visibleRecents.length)),
			]));
			if (recentsOpen) {
				for (const path of visibleRecents) {
					rail.push(railItem("r:" + path, path.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? path, path, null,
						h(IconClockOutlineRegular, { size: 14 }), view?.path === path));
				}
			}
		}
		rail.push(h("div", { className: "edsRailGroup", key: "g-quick" }, t("quick")));
		if (places.home !== null && places.home !== undefined) {
			rail.push(railItem("home", t("home"), places.home, null, h(IconFolderOpenRegular, { size: 14 }), view?.path === places.home));
		}
		for (const item of places.quick ?? []) {
			rail.push(railItem("q:" + item.path, t(item.kind), item.path, null, h(IconFolderCloseRegular, { size: 14 }), view?.path === item.path));
		}
		rail.push(h("div", { className: "edsRailGroup", key: "g-drives" }, t("drives")));
		for (const drive of driveRows) {
			const free = formatBytes(drive.free);
			rail.push(railItem("d:" + drive.path, drive.letter + ":", drive.path, free === null ? null : free + " " + t("free"),
				h(IconDatabaseOutlineRegular, { size: 14 }), view?.path === drive.path));
		}

		const crumbs = view === null ? [] : segmentsOf(view.path);
		/** 搜索态显示搜索范围，浏览态显示当前路径面包屑。 */
		const headTrail = searchMode
			? h("span", { className: "edsCrumbLast" },
				t("searchScope") + "：" + query.trim()
				+ (rows.length > 0 ? " · " + rows.length + " " + t("results") : ""))
			: (crumbs.length === 0
				? h("span", { className: "edsCrumbLast" }, "")
				: crumbs.flatMap((crumb, index) => {
					const last = index === crumbs.length - 1;
					const nodes = [];
					if (index > 0) nodes.push(h("span", { className: "edsCrumbSep", key: "s" + index }, h(IconChevronRightOutlineRegular, { size: 12 })));
					nodes.push(h("button", {
						key: "c" + index,
						type: "button",
						className: last ? "edsCrumb edsCrumbLast" : "edsCrumb",
						title: crumb.path,
						onClick: () => navigate(crumb.path),
					}, crumb.label));
					return nodes;
				}));
		const head = h("div", { className: "edsHead", key: "head" }, [
			!searchMode && view !== null && view.parent !== null && view.parent !== undefined
				? h(Button, {
					key: "up",
					variant: "outline",
					size: "sm",
					icon: h(IconChevronUpOutlineRegular, { size: 14 }),
					title: t("up"),
					onClick: () => navigate(view.parent),
				}, t("up"))
				: null,
			h("div", { className: "edsCrumbs", key: "crumbs" }, headTrail),
			// 可发现性：选中某一行时提示 F2 可改名（与 Windows 资源管理器一致）。
			selected >= 0 && renaming === null && hostReady === true
				? h("span", { className: "edsRowBadge", key: "renameHint" }, t("renameHint"))
				: null,
			// 被屏蔽条目数 + 显示开关：屏蔽永远是可逆、可核对的。
			blockedCount > 0
				? h(Button, {
					key: "blocked",
					variant: "ghost",
					size: "sm",
					title: showBlocked ? t("blockedHide") : t("blockedShow"),
					onClick: () => setShowBlocked(value => !value),
				}, (showBlocked ? t("blockedHide") : t("blockedShow")) + " " + blockedCount)
				: null,
			!searchMode && view !== null
				? h(Button, {
					key: "new",
					variant: "outline",
					size: "sm",
					icon: h(IconProjectAddOutlineRegular, { size: 14 }),
					disabled: busy,
					onClick: () => { setCreating(true); setCreateError(null); setNewName(""); },
				}, t("newFolder"))
				: null,
		]);

		const list = h("div", {
			className: "edsList",
			key: "list",
			ref: listRef,
			tabIndex: 0,
			onKeyDown: onListKeyDown,
			// 点空白处取消选中：这样「选择此文件夹」又回到当前目录（浏览态）。
			onClick: (event) => {
				if (event.target === event.currentTarget && renaming === null) setSelected(-1);
			},
		}, (() => {
			if (searchMode) {
				if (searchError !== null) return h("div", { className: "edsAlert" }, t("searchUnavailable") + searchError);
				if (searching && rows.length === 0) return h("div", { className: "edsHint" }, t("searching"));
				if (rows.length === 0) return h("div", { className: "edsHint" }, t("searchEmpty"));
			} else if (loading && view === null) {
				return h("div", { className: "edsHint" }, t("loading"));
			} else if (viewError !== null) {
				return h("div", { className: "edsAlert" }, viewError);
			} else if (view === null) {
				return h("div", { className: "edsHint" }, t("startHint"));
			} else if (rows.length === 0) {
				return h("div", { className: "edsHint" }, t("empty"));
			}
			return rows.map((row, index) => {
				const editing = renaming !== null && renaming.path === row.path;
				return h("div", {
					key: row.path + ":" + index,
					className: "edsRow",
					"data-row": index,
					"data-selected": index === selected ? "true" : "false",
					"data-blocked": row.blocked === true ? "true" : "false",
					"data-renaming": editing ? "true" : "false",
					title: row.path,
					onClick: () => { if (!editing) setSelected(index); },
					// 双击一律进入下一级；选定工作区请单击选中后点右下角「选择此文件夹」。
					onDoubleClick: () => { if (!editing) navigate(row.path); },
				}, [
					h("span", { className: "edsRowIcon", key: "i" }, h(IconFolderCloseRegular, { size: 14 })),
					editing
						? h("span", { className: "edsRenameField", key: "rename", ref: renameWrapRef },
							h(Input, {
								key: "input",
								"aria-label": t("renameAria"),
								value: renaming.name,
								onChange: (event) => setRenaming({ ...renaming, name: event.target.value }),
								onKeyDown: (event) => {
									if (event.key === "Enter") { event.preventDefault(); commitRename(event.currentTarget.value); }
									if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename(); }
								},
								onBlur: (event) => { commitRename(event.target.value); },
							}))
						: h("span", { className: "edsRowName", key: "n" }, searchMode ? highlight(row.name, query) : row.name),
					row.meta === null || row.meta === undefined ? null : h("span", { className: "edsRowMeta", key: "m" }, row.meta),
					row.blocked === true ? h("span", { className: "edsRowBadge", key: "b" }, t("blockedBadge")) : null,
					row.hidden === true ? h("span", { className: "edsRowBadge", key: "h" }, "hidden") : null,
				]);
			});
		})());

		const searchRow = h("div", { className: "edsSearchRow", key: "search" }, [
			h("span", { key: "wrap", className: "edsSearchField", ref: searchWrapRef },
				h(Input, {
					key: "input",
					icon: h(IconSearchOutlineRegular, { size: 14 }),
					placeholder: t("searchPlaceholder"),
					value: query,
					onChange: (event) => setQuery(event.target.value),
					onKeyDown: onSearchKeyDown,
					"aria-label": t("searchPlaceholder"),
				})),
			// 搜索中的状态由列表里的「正在搜索…」文字表达；这里不再放转圈元素
			// （曾经它被宽选择器横向拉长，旋转到竖直那一帧就是那条长条特效）。
			query !== ""
				? h(Button, {
					key: "clear",
					variant: "ghost",
					size: "sm",
					icon: h(IconCloseOutlineRegular, { size: 14 }),
					title: t("searchClear"),
					"aria-label": t("searchClear"),
					onClick: () => { setQuery(""); focusSearch(); },
				})
				: null,
		]);

		// 卡片作用域按键处理（F2 改名、改名/新建态下的 Esc 拦截），见 onCardKeyDown。
		const body = h("div", { className: "edsBody", onKeyDown: onCardKeyDown }, [
			searchRow,
			h("div", { className: "edsColumns", key: "cols" }, [
				h("div", { className: "edsRail", key: "rail" }, rail),
				h("div", { className: "edsMain", key: "main" }, [
					head,
					creating
						? h("div", { className: "edsCreateRow", key: "create" }, [
							h("span", { className: "edsCreateField", key: "field" },
								h(Input, {
									key: "name",
									autoFocus: true,
									placeholder: t("newFolderPlaceholder"),
									value: newName,
									onChange: (event) => setNewName(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") { event.preventDefault(); submitCreate(); }
										if (event.key === "Escape") { event.preventDefault(); setCreating(false); }
									},
								})),
							h(Button, { key: "ok", variant: "primary", size: "sm", icon: h(IconCheckOutlineRegular, { size: 14 }), disabled: newName.trim() === "", onClick: submitCreate }, t("create")),
							h(Button, { key: "no", variant: "ghost", size: "sm", onClick: () => setCreating(false) }, t("cancel")),
						])
						: null,
					createError !== null ? h("div", { className: "edsAlert", key: "createError" }, createError) : null,
					renameError !== null ? h("div", { className: "edsAlert", key: "renameError" }, t("renameFailed") + renameError) : null,
					list,
				]),
			]),
		]);

		const footer = h("div", { className: "edsFooter" }, [
			h("span", { className: "edsFooterPath", key: "path", title: target ?? "" },
				target === null || target === undefined
					? (searchMode ? t("searchHint") : t("current"))
					: (selectedRow !== undefined ? t("selected") : t("current")) + "：" + target),
			status !== null && status.available !== true
				? h("span", { className: "edsRowBadge", key: "warn", title: status.reason ?? "" }, "Everything ✕")
				: null,
			h(Button, { key: "cancel", variant: "ghost", onClick: onCancel }, t("cancel")),
			h(Button, {
				key: "ok",
				variant: "primary",
				disabled: busy || target === null || target === undefined,
				onClick: () => confirm(),
			}, busy ? t("loading") : t("choose")),
		]);

		return h(Modal, {
			open: open,
			onClose: onCancel,
			title: t("title"),
			closeLabel: t("close"),
			className: "edsDialog",
			footer: footer,
		}, body);
	}

	/**
	 * 错误边界：DSH 版本变动导致渲染期抛错时，不让整个槽位变成空白或死按钮，
	 * 而是给出一段可读提示 + 取消按钮（至少还能关掉）。
	 */
	class DialogBoundary extends Component {
		constructor(props) {
			super(props);
			this.state = { failed: null };
		}

		static getDerivedStateFromError(error) {
			return { failed: error instanceof Error ? error.message : String(error) };
		}

		componentDidCatch(error) {
			console.error("[dsh-everything-search] 对话框渲染失败：", error);
		}

		render() {
			if (this.state.failed === null) return h(EverythingDirectoryFlow, this.props);
			const onCancel = typeof this.props.onCancel === "function" ? this.props.onCancel : () => {};
			return h("div", { className: "edsCrash", role: "alert" }, [
				h("div", { className: "edsCrashTitle", key: "t" }, "目录对话框渲染失败"),
				h("div", { className: "edsCrashBody", key: "m" }, this.state.failed),
				h("div", { className: "edsCrashHint", key: "h" },
					"本插件可能与当前 DSH 版本不兼容；可先取消，再用 README 里的回滚命令恢复官方选择器。"),
				h(FallbackButton, { key: "b", onClick: onCancel }, "取消"),
			]);
		}
	}

	/* ------------------------------------------------------------------ *
	 * 插件入口
	 * ------------------------------------------------------------------ */

	/** 本插件需要的客户端服务。 */
	const inject = ["slots", "locale"];

	function makeTranslate(ctx) {
		try {
			const bound = ctx.locale.bind(NS);
			return (key) => {
				const value = bound(key);
				return value === undefined || value === null || value === "" ? (zh[key] ?? en[key] ?? key) : value;
			};
		} catch {
			return (key) => zh[key] ?? en[key] ?? key;
		}
	}

	function apply(ctx) {
		try {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": locale dictionaries");
		} catch (error) {
			console.warn("[" + NS + "] locale 注册失败，界面退回内置词典：", error);
		}
		try {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", NS);
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, NS + ": dialog styles");
		} catch (error) {
			console.warn("[" + NS + "] 样式注入失败：", error);
		}

		// 临时诊断探针：把平台原语渲染到屏幕外，量它们的计算样式，
		// 判断「原语自带的 CSS 在当前窗口里到底有没有生效」（结果随 client-loaded 上报）。
		const probePrimitives = () => {
			try {
				const host = document.createElement("div");
				host.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:320px;height:80px;";
				document.body.appendChild(host);
				const ReactDomClient = require("react-dom/client");
				const root = ReactDomClient.createRoot(host);
				root.render(h("div", null, [
					h(Button, { variant: "primary", key: "b" }, "probe"),
					h(Input, { key: "i", placeholder: "probe" }),
				]));
				setTimeout(() => {
					try {
						const button = host.querySelector("button");
						const input = host.querySelector("input");
						const b = button === null ? null : getComputedStyle(button);
						const i = input === null ? null : getComputedStyle(input);
						const wrap = input === null ? null : getComputedStyle(input.parentElement);
						const report = [
							"btnR=" + (b?.borderTopLeftRadius ?? "?"),
							"btnPad=" + (b?.paddingLeft ?? "?"),
							"btnBg=" + (b?.backgroundColor ?? "?"),
							"inR=" + (i?.borderTopLeftRadius ?? "?"),
							"wrapBw=" + (wrap?.borderTopWidth ?? "?"),
							"wrapR=" + (wrap?.borderTopLeftRadius ?? "?"),
						].join(" ");
						probeReport = report;
						console.info("[" + NS + "] primitives style probe:", report);
						// 单独再报一次：宿主端旧版本只记录 slots，所以挂在 slots 后面。
						Promise.resolve(call("hello", {
							href: typeof location === "object" && location !== null ? location.href : null,
							slots: "probe | primitives=" + primitivesKind + " | " + report,
							primitives: primitivesKind,
						})).catch(() => {});
					} catch (error) {
						probeReport = "measure-failed:" + (error?.message ?? error);
					} finally {
						try { root.unmount(); host.remove(); } catch { /* 忽略 */ }
					}
				}, 120);
			} catch (error) {
				probeReport = "probe-failed:" + (error?.message ?? error);
			}
		};
		probePrimitives();

		let rpc;
		try {
			const connection = ctx.get("connection");
			rpc = connection !== null && typeof connection === "object" ? connection.rpc : undefined;
		} catch (error) {
			console.warn("[" + NS + "] connection 服务不可用，退回普通同源 fetch：", error);
		}
		const call = makeCall(rpc);
		const t = makeTranslate(ctx);
		const injected = () => ({ call, t });

		try {
			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () =>
				ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
					yield ctx.slots.register({
						name: "conversation.hero.workspace.directoryFlow",
						id: NS,
						locale: NS,
						inject: injected,
					}, DialogBoundary);
					yield ctx.slots.register({
						name: "sidebar.workspaces.directoryFlow",
						id: NS,
						locale: NS,
						inject: injected,
					}, DialogBoundary);
				}));
		} catch (error) {
			console.error("[" + NS + "] directoryFlow 槽位注册失败——原生目录选择器（directory-picker-auto）"
				+ "仍占用 single 槽位时会出现此情况，需要在 profile 的 cordis.patch.yml 里把它 disabled：", error);
		}

		// 自报：让宿主端在插件数据目录记一条 client-loaded（排障/验收用，失败不影响功能）。
		// 注：宿主端旧版本只记录 userAgent/href/slots 三个字段，所以把「用了平台原语还是降级」
		// 临时挂在 slots 后面（宿主更新后会写入独立的 primitives / primitivesError 字段）。
		try {
			const slotsReport = "sidebar.workspaces.directoryFlow,conversation.hero.workspace.directoryFlow"
				+ " | primitives=" + primitivesKind
				+ (primitivesError === null ? "" : " | err=" + primitivesError.slice(0, 160));
			Promise.resolve(call("hello", {
				userAgent: typeof navigator === "object" && navigator !== null ? navigator.userAgent : null,
				href: typeof location === "object" && location !== null ? location.href : null,
				slots: slotsReport,
				primitives: primitivesKind,
				primitivesError: primitivesError,
			})).catch(() => {});
		} catch { /* 忽略 */ }
	}

	exports.apply = apply;
	exports.inject = inject;
	/** 单元测试与排障用的内部面（不参与 DSH 契约）。 */
	exports.__internals = {
		NS, PREFIX, RECENTS_KEY, zh, en, CSS,
		EverythingDirectoryFlow, DialogBoundary, FallbackModal, FallbackButton, FallbackInput,
		makeCall, makeTranslate,
		parentOf, segmentsOf, formatBytes, highlight, readRecents, writeRecents, isNoisePath,
	};
	return module.exports;
} });
