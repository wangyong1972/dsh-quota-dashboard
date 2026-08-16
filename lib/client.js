// dsh-quota-dashboard — browser half.
//
// A draggable floating card combining OpenRouter + DeepSeek quota/spend.
// Registered into the frame-wide `shell.overlay` slot. The card can be
// dragged anywhere (pointer events + localStorage persistence) and clicked to
// expand a per-provider detail panel. Polls the host route
// `/api/quota-dashboard` every minute.
window.__ModuleLoader__.load({
	id: "dsh-quota-dashboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		// ---- constants -------------------------------------------------
		const POLL_MS = 60 * 1000;
		const QUOTA_PATH = "/api/quota-dashboard";
		const POS_KEY = "dsh-quota-dashboard-pos";
		const DRAG_THRESHOLD = 5; // px: below = click (expand), above = drag

		// ---- helpers ---------------------------------------------------
		function formatCost(value) {
			if (!Number.isFinite(value) || value <= 0) return "$0";
			if (value >= 100) return `$${value.toFixed(0)}`;
			if (value >= 1) return `$${value.toFixed(2)}`;
			if (value >= 0.01) return `$${value.toFixed(3)}`;
			return `$${value.toPrecision(2)}`;
		}

		function formatBalance(value) {
			if (!Number.isFinite(value) || value <= 0) return "$0";
			return `$${value.toFixed(2)}`;
		}

		function loadPos() {
			try {
				const raw = localStorage.getItem(POS_KEY);
				if (raw) {
					const p = JSON.parse(raw);
					// Clamp stale/off-screen positions back into the viewport
					// so a previously misplaced card never "disappears".
					if (typeof p.x === "number" && typeof p.y === "number") {
						const vw = typeof window !== "undefined" ? window.innerWidth : 0;
						const vh = typeof window !== "undefined" ? window.innerHeight : 0;
						if (vw > 0 && vh > 0) {
							p.x = Math.max(8, Math.min(p.x, vw - 220));
							p.y = Math.max(8, Math.min(p.y, vh - 60));
						}
						return p;
					}
				}
			} catch {}
			return null;
		}

		function savePos(x, y) {
			try {
				localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
			} catch {}
		}

		async function fetchQuota(sessionId) {
			const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
			const res = await fetch(QUOTA_PATH + qs, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return body;
		}

		function formatTime(ts) {
			if (!ts) return "";
			const d = new Date(ts);
			const hh = String(d.getHours()).padStart(2, "0");
			const mm = String(d.getMinutes()).padStart(2, "0");
			const ss = String(d.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
		}

		// ---- the widget -------------------------------------------------
		function QuotaDashboard(props) {
			const useSessions = props.useSessions;
			const currentSessionId = typeof useSessions === "function" ? useSessions((s) => s.current) : void 0;
			const [state, setState] = useState({ status: "loading", data: null, error: null, expanded: false });
			const [pos, setPos] = useState(() => loadPos() ?? { x: null, y: null });
			const [spinning, setSpinning] = useState(false);
			const mounted = useRef(true);
			const drag = useRef(null); // { startX, startY, origX, origY, moved }

			const load = useCallback(async (quiet) => {
				if (!quiet) setSpinning(true);
				try {
					const data = await fetchQuota(currentSessionId);
					if (!mounted.current) return;
					setState((s) => ({ ...s, status: "ok", data, error: null }));
				} catch (error) {
					if (!mounted.current) return;
					setState((s) => ({ ...s, status: "error", data: null, error: error.message }));
				} finally {
					if (mounted.current) setSpinning(false);
				}
			}, [currentSessionId]);

			useEffect(() => {
				mounted.current = true;
				load(true);
				const timer = setInterval(() => load(true), POLL_MS);
				return () => {
					mounted.current = false;
					clearInterval(timer);
				};
			}, [load]);

			const onPointerDown = (e) => {
				// Left button only.
				if (e.button !== 0) return;
				const startX = e.clientX;
				const startY = e.clientY;
				// Anchor ONCE at pointer-down: if the card has a dragged
				// position use it, else read the current fixed offset
				// (default corner). Never re-read offsetLeft during move —
				// React re-renders change it and the position would drift
				// cumulatively until the card flies off-screen.
				const origX = pos.x !== null ? pos.x : e.currentTarget.offsetLeft;
				const origY = pos.y !== null ? pos.y : e.currentTarget.offsetTop;
				drag.current = { startX, startY, origX, origY, moved: false };
				e.currentTarget.setPointerCapture(e.pointerId);
			};

			const onPointerMove = (e) => {
				const d = drag.current;
				if (d === null) return;
				const dx = e.clientX - d.startX;
				const dy = e.clientY - d.startY;
				if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) d.moved = true;
				if (d.moved) {
					setPos({ x: d.origX + dx, y: d.origY + dy });
				}
			};

			const onPointerUp = (e) => {
				const d = drag.current;
				if (d === null) return;
				const wasMoved = d.moved;
				drag.current = null;
				try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
				if (wasMoved) {
					setPos((p) => {
						savePos(p.x, p.y);
						return p;
					});
				} else {
					setState((s) => ({ ...s, expanded: !s.expanded }));
				}
			};

			const { status, data, error, expanded } = state;
			const ok = status === "ok" && data && data.ok;
			const or = ok && data.providers ? data.providers.openrouter : null;
			const ds = ok && data.providers ? data.providers.deepseek : null;

			// Card base style; position from drag state (fixed via left/top
			// when dragged, else corner default bottom-right).
			const cardStyle = {
				position: "fixed",
				zIndex: 9999,
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 12px",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-overlay)",
				color: "var(--dsw-alias-text-primary)",
				fontSize: 12,
				fontFamily: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
				border: "1px solid var(--dsw-alias-border-default)",
				boxShadow: "var(--dsw-shadow-card, 0 4px 12px rgba(0,0,0,0.15))",
				cursor: "grab",
				userSelect: "none",
				touchAction: "none",
			};
			if (pos.x !== null && pos.y !== null) {
				cardStyle.left = pos.x;
				cardStyle.top = pos.y;
			} else {
				// Top-left default: the other quota cards own bottom-right
				// (dsh-deepseek-quota) and top-right (dsh-openrouter-quota).
				cardStyle.top = 16;
				cardStyle.left = 16;
			}

			const orText = or && !or.error ? `OR ${formatBalance(or.balance)}` : "OR —";
			const dsText = ds && !ds.error ? `DS ${formatBalance(ds.balance)}` : "DS —";

			const chipContent = ok
				? jsxs(Fragment, {
						children: [
							jsx("span", { style: { opacity: 0.7 }, children: "💰" }),
							jsx("span", { style: { fontWeight: 600 }, children: orText }),
							jsx("span", { style: { fontWeight: 600, color: "var(--dsw-alias-text-accent, #30a46c)" }, children: dsText }),
							jsx("button", {
								style: {
									background: "none",
									border: "none",
									color: "inherit",
									cursor: "pointer",
									fontSize: 12,
									opacity: spinning ? 0.5 : 0.8,
									marginLeft: 4,
								},
								onClick: (e) => {
									e.stopPropagation();
									load(false);
								},
								title: "刷新",
								children: "↻",
							}),
						],
					})
				: status === "error"
					? jsx("span", { style: { color: "var(--dsw-alias-text-danger, #e5484d)" }, children: "额度面板不可用" })
					: jsx("span", { children: "💰 加载中…" });

			return jsxs(Fragment, {
				children: [
					jsx("div", {
						style: cardStyle,
						onPointerDown,
						onPointerMove,
						onPointerUp,
						title: "拖拽移动 · 点击展开",
						children: chipContent,
					}),
					expanded && ok && jsx("div", {
						style: {
							position: "fixed",
							zIndex: 9999,
							width: 300,
							padding: "12px 14px",
							borderRadius: 12,
							background: "var(--dsw-alias-bg-overlay)",
							color: "var(--dsw-alias-text-primary)",
							fontSize: 12,
							border: "1px solid var(--dsw-alias-border-default)",
							boxShadow: "var(--dsw-shadow-card, 0 8px 24px rgba(0,0,0,0.18))",
							display: "flex",
							flexDirection: "column",
							gap: 8,
							...(pos.x !== null && pos.y !== null
								? { left: pos.x, top: pos.y + 40 }
								: { top: 52, left: 16 }),
						},
						children: [
							// OpenRouter section
							jsx("div", { style: { fontWeight: 600, fontSize: 13 }, children: "OpenRouter" }),
							or && !or.error
								? jsxs(Fragment, {
										children: [
											row("余额", formatBalance(or.balance)),
											row("当前对话", or.sessionCost !== null && or.sessionCost !== void 0
												? formatCost(or.sessionCost)
												: "—"),
											row("今日", formatCost(or.usageDaily)),
											row("本周", formatCost(or.usageWeekly)),
											row("本月", formatCost(or.usageMonthly)),
											row("过去1h", formatCost(or.hourSpend), true),
										],
									})
								: jsx("div", { style: { color: "var(--dsw-alias-text-danger, #e5484d)" }, children: String(or?.message ?? "未配置") }),
							jsx("div", { style: { height: 1, background: "var(--dsw-alias-border-default)", margin: "4px 0" } }),
							// DeepSeek section
							jsx("div", { style: { fontWeight: 600, fontSize: 13 }, children: "DeepSeek" }),
							ds && !ds.error
								? jsxs(Fragment, {
										children: [
											row("余额", formatBalance(ds.balance)),
											ds.granted !== null && ds.granted !== void 0
												? row("赠送", formatBalance(ds.granted))
												: null,
											row("当前对话", ds.sessionCost !== null && ds.sessionCost !== void 0
												? formatCost(ds.sessionCost)
												: "—"),
											row("今日", formatCost(ds.todaySpend)),
											row("过去1h", formatCost(ds.hourSpend), true),
										],
									})
								: jsx("div", { style: { color: "var(--dsw-alias-text-danger, #e5484d)" }, children: String(ds?.message ?? "未配置") }),
							jsx("div", { style: { opacity: 0.5, fontSize: 11, marginTop: 4 }, children: "余额/赠送来自官方 API；当前对话回放日志计价；小时/今日来自本地记账" }),
							data && data.updatedAt
								? jsx("div", { style: { opacity: 0.5, fontSize: 11, marginTop: 2 }, children: `更新于 ${formatTime(data.updatedAt)}` })
								: null,
						],
					}),
				],
			});

			function row(label, value, accent) {
				return jsx("div", {
					style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
					children: [
						jsx("span", { style: { opacity: 0.7 }, children: label }),
						jsx("span", {
							style: accent
								? { color: "var(--dsw-alias-text-accent, #30a46c)", fontWeight: 600 }
								: { fontWeight: 600 },
							children: value,
						}),
					],
				});
			}
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "quota-dashboard",
				order: 120,
				label: "额度面板"
			}, QuotaDashboard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
