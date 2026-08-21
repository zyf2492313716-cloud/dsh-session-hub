window.__ModuleLoader__.load({
	id: "@dsh-local/dsh-session-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.js
		/**
		* dsh-session-hub — client half.
		*
		* 在 DSH Web 注册客户端组件：Settings → General 信息行（官方 settings.general.item
		* 扩展点），展示插件运行状态与跨工具会话概览。数据全部来自 node half 的
		* /session-hub/api 只读接口。
		*/
		const API = "/session-hub/api";
		const SOURCES = [
			{
				id: "all",
				label: "全部"
			},
			{
				id: "opencode",
				label: "opencode"
			},
			{
				id: "claude",
				label: "Claude"
			},
			{
				id: "dsh",
				label: "DSH"
			},
			{
				id: "qodercn",
				label: "QoderCN"
			}
		];
		function esc(s) {
			return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		}
		function fmtTime(ts) {
			if (!ts) return "";
			const d = new Date(ts);
			return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		}
		function SessRow({ s, onOpen, selected }) {
			return (0, react.createElement)("div", {
				className: `sh-sess${selected ? " sel" : ""}`,
				onClick: () => onOpen(s)
			}, (0, react.createElement)("span", { className: "b" }, s.source.slice(0, 1).toUpperCase()), (0, react.createElement)("span", { className: "t" }, s.title || s.id), (0, react.createElement)("span", { className: "b" }, fmtTime(s.timeUpdated)));
		}
		function SessionDetail({ session }) {
			if (!session) return (0, react.createElement)("div", { className: "sh-empty" }, "从左侧选择一个会话查看内容");
			(session.messages ?? []).flatMap((m) => m.parts.map((p) => ({
				...p,
				role: m.role,
				time: m.time
			})));
			return (0, react.createElement)("div", {}, (0, react.createElement)("div", { className: "sh-dhead" }, (0, react.createElement)("div", { className: "t" }, session.title || session.id), (0, react.createElement)("div", { className: "m" }, `${session.source} · ${session.messages?.length ?? 0} 条消息 · ${session.cwd || ""}${session.model ? " · " + (session.model.modelID || session.model) : ""}${session.cost ? " · $" + Number(session.cost).toFixed(3) : ""}`)), (0, react.createElement)("div", {}, (session.messages ?? []).map((m, i) => (0, react.createElement)("div", {
				className: "sh-msg",
				key: i
			}, (0, react.createElement)("div", { className: "sh-who" }, `${m.role || "?"} · ${fmtTime(m.time)}`), (m.parts ?? []).map((p, j) => {
				if (p.type === "text") return (0, react.createElement)("div", {
					className: "sh-text",
					key: j,
					dangerouslySetInnerHTML: { __html: esc(p.text).replace(/\n/g, "<br>") }
				});
				if (p.type === "reasoning") return (0, react.createElement)("div", {
					className: "sh-reason",
					key: j
				}, `💭 ${esc((p.text || "").slice(0, 800))}`);
				if (p.type === "tool") return (0, react.createElement)("details", {
					className: "sh-tool",
					key: j
				}, (0, react.createElement)("summary", {}, `🔧 ${esc(p.tool || "tool")}${p.title ? " · " + esc(p.title) : ""}`), p.input ? (0, react.createElement)("div", { className: "d" }, `入参: ${esc(p.input)}`) : null, p.output ? (0, react.createElement)("div", { className: "d" }, `输出: ${esc(p.output)}`) : null);
				if (p.type === "patch") return (0, react.createElement)("div", {
					className: "sh-patch",
					key: j
				}, `📝 ${esc((p.files || []).join(", "))}${p.hash ? " (" + p.hash.slice(0, 8) + ")" : ""}`);
				if (p.type === "file") return (0, react.createElement)("div", {
					className: "sh-patch",
					key: j
				}, `🖼️ ${esc(p.file || "")}`);
				return null;
			})))));
		}
		function SessionHub() {
			const [overview, setOverview] = (0, react.useState)(null);
			const [workspaces, setWorkspaces] = (0, react.useState)([]);
			const [expanded, setExpanded] = (0, react.useState)({});
			const [source, setSource] = (0, react.useState)("all");
			const [query, setQuery] = (0, react.useState)("");
			const [results, setResults] = (0, react.useState)(null);
			const [selected, setSelected] = (0, react.useState)(null);
			const [session, setSession] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				fetch(`${API}/overview`).then((r) => r.json()).then((d) => setOverview(d.sources ?? [])).catch(() => {});
				refresh();
			}, []);
			const refresh = (0, react.useCallback)((src = source) => {
				setLoading(true);
				fetch(`${API}/workspaces?source=${src}`).then((r) => r.json()).then((d) => {
					setWorkspaces(d.workspaces ?? []);
					setLoading(false);
				}).catch(() => setLoading(false));
			}, [source]);
			(0, react.useEffect)(() => {
				refresh(source);
			}, [source]);
			const runSearch = (0, react.useCallback)((q) => {
				if (!q || !q.trim()) {
					setResults(null);
					return;
				}
				setLoading(true);
				fetch(`${API}/search?q=${encodeURIComponent(q)}&source=${source}`).then((r) => r.json()).then((d) => {
					setResults(d.results ?? []);
					setLoading(false);
				}).catch(() => setLoading(false));
			}, [source]);
			let timer = null;
			const onQuery = (v) => {
				setQuery(v);
				clearTimeout(timer);
				timer = setTimeout(() => runSearch(v), 400);
			};
			const openSession = (s) => {
				setSelected(s);
				setLoading(true);
				fetch(`${API}/session?source=${s.source}&id=${encodeURIComponent(s.id)}`).then((r) => r.json()).then((d) => {
					setSession(d.session ?? null);
					setLoading(false);
				}).catch(() => setLoading(false));
			};
			const toggleWs = (name) => setExpanded((p) => ({
				...p,
				[name]: !p[name]
			}));
			const [syncing, setSyncing] = (0, react.useState)(false);
			const [syncMsg, setSyncMsg] = (0, react.useState)("");
			const doSync = () => {
				setSyncing(true);
				setSyncMsg("");
				fetch(`${API}/workspaces/sync`, { method: "POST" }).then((r) => r.json()).then((d) => {
					setSyncMsg(`已同步 ${d.synced?.length ?? 0} 个工作区到 DSH 侧边栏${d.failed?.length ? `，${d.failed.length} 个失败` : ""}`);
					setSyncing(false);
					refresh(source);
				}).catch(() => {
					setSyncMsg("同步失败");
					setSyncing(false);
				});
			};
			return (0, react.createElement)("div", { className: "session-hub" }, (0, react.createElement)("div", { className: "sh-head" }, (0, react.createElement)("span", { className: "sh-title" }, "会话库"), (overview ?? []).map((s) => (0, react.createElement)("span", {
				className: "sh-chip",
				key: s.source
			}, `${s.source} ${s.sessions}`)), (0, react.createElement)("input", {
				className: "sh-search",
				placeholder: "搜索标题 / 内容（如 \"brawl\" 或中文）…",
				value: query,
				onChange: (e) => onQuery(e.target.value)
			}), (0, react.createElement)("div", { className: "sh-src" }, SOURCES.map((s) => (0, react.createElement)("button", {
				key: s.id,
				className: source === s.id ? "on" : "",
				onClick: () => setSource(s.id)
			}, s.label)))), (0, react.createElement)("div", { className: "sh-sync" }, (0, react.createElement)("button", {
				className: "sh-syncbtn",
				disabled: syncing,
				onClick: doSync
			}, syncing ? "同步中…" : "⇄ 同步工作区到 DSH 侧边栏"), syncMsg && (0, react.createElement)("span", { className: "sh-syncmsg" }, syncMsg)), (0, react.createElement)("div", { className: "sh-body" }, (0, react.createElement)("div", { className: "sh-list" }, results !== null ? (0, react.createElement)("div", {}, (0, react.createElement)("div", { className: "sh-ws" }, (0, react.createElement)("div", { className: "n" }, `🔍 搜索结果 (${results.length})`, (0, react.createElement)("span", { className: "c" }, "点击查看"))), results.map((r) => (0, react.createElement)(SessRow, {
				key: r.source + r.id,
				s: r,
				onOpen: openSession,
				selected: selected && selected.id === r.id && selected.source === r.source
			}))) : workspaces.map((w) => (0, react.createElement)("div", {
				className: "sh-ws",
				key: w.name
			}, (0, react.createElement)("div", {
				className: "n",
				onClick: () => toggleWs(w.name)
			}, `${w.inDsh ? "📌" : "📁"} ${w.name}`, (0, react.createElement)("span", { className: "c" }, `${w.inDsh ? "已同步 · " : ""}${w.sessionCount} 会话`)), expanded[w.name] && w.sessions.slice(0, 200).map((s) => (0, react.createElement)(SessRow, {
				key: s.source + s.id,
				s,
				onOpen: openSession,
				selected: selected && selected.id === s.id && selected.source === s.source
			})))), loading && (0, react.createElement)("div", { className: "sh-empty" }, "加载中…")), (0, react.createElement)("div", { className: "sh-detail" }, (0, react.createElement)(SessionDetail, { session }))));
		}
		/**
		* Settings → General 信息行：展示插件运行状态与各源会话概览。
		* 注册到官方公开扩展点 settings.general.item（list 槽，ui-permission 同款范式）。
		*/
		function SessionHubSettingsRow() {
			const [overview, setOverview] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				fetch(`${API}/overview`).then((r) => r.json()).then((d) => {
					if (alive) setOverview(d.sources ?? []);
				}).catch(() => {
					if (alive) setOverview([]);
				});
				return () => {
					alive = false;
				};
			}, []);
			const total = (overview ?? []).reduce((n, s) => n + (s.sessions ?? 0), 0);
			return (0, react.createElement)("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "12px 16px",
				minWidth: 0
			} }, (0, react.createElement)("div", { style: {
				flex: 1,
				minWidth: 0
			} }, (0, react.createElement)("div", { style: {
				fontWeight: 600,
				fontSize: 14
			} }, "会话库 · dsh-session-hub"), (0, react.createElement)("div", { style: {
				fontSize: 12,
				opacity: .6,
				marginTop: 2
			} }, overview === null ? "状态检查中…" : `已连接 · 共 ${total} 个外部会话（${(overview ?? []).map((s) => `${s.source} ${s.sessions}`).join(" / ")}）`)));
		}
		const inject = ["slots"];
		/**
		* 客户端入口：注册 Settings → General 信息行。
		* 会话库 tab 已弃用（2026-08-07）：左侧工作区的 ExternalSessions 覆盖了
		* 外部会话的浏览与导入（node half 提供 /session-hub/api）。SessionHub 组件
		* 保留在源码中备恢复——恢复 tab 时在此处追加注册即可。
		*/
		function apply(ctx) {
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "dsh-session-hub",
				order: 100
			}, SessionHubSettingsRow));
		}
		//#endregion
		exports.SessionHub = SessionHub;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
