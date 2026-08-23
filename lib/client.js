// dsh-quota-dashboard — browser half.
//
// A draggable floating card combining OpenRouter + DeepSeek quota/spend.
// Registered into the frame-wide `shell.overlay` slot. The card can be
// dragged anywhere (pointer events + localStorage persistence) and clicked to
// expand a per-provider detail panel. Polls the host route
// `/api/quota-dashboard` every minute. UI text is localized (zh/en): the
// language follows the browser locale by default and can be toggled from the
// detail panel (persisted in localStorage).
window.__ModuleLoader__.load({
	id: "@wangyong1972/dsh-quota-dashboard",
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
		const LANG_KEY = "dsh-quota-dashboard-lang";
		const DRAG_THRESHOLD = 5; // px: below = click (expand), above = drag

		// Viewport clamping: while dragging, the card (the grab surface) must
		// never be pushed fully outside the window, or it becomes impossible to
		// grab again (the panel gets stuck off-screen). GRAB_MARGIN is the safe
		// inset keeping a grabbable strip visible; when the detail panel is
		// expanded the card is also kept high enough that the panel's bottom
		// edge stays on screen during a drag.
		const GRAB_MARGIN = 24; // px
		const CARD_W = 220; // px: max card width used for clamping
		const CARD_H = 32; // px
		const EXPAND_GAP = 40; // px: detail panel offset below the card
		const PANEL_MAX_H = 460; // px: max estimated detail panel height
		// Default corner when the card has never been dragged (matches the
		// default cardStyle top/left below).
		const CARD_DEFAULT_X = 16;
		const CARD_DEFAULT_Y = 16;

		// Card selector used by the coverage probe: the card can be grabbed only
		// while it is the topmost hit at its own location.
		const CARD_SEL = '[title="拖拽移动 · 点击展开"], [title="Drag to move · Click to expand"]';
		// How often to check whether the card is still reachable (something with
		// a higher z-index — e.g. the AgentTeams activity panel at 2147483000 —
		// may have been painted over it and swallowed all pointer events).
		const PROBE_MS = 2000;
		const SOURCE_URL = "https://github.com/wangyong1972/dsh-quota-dashboard";

		// ---- i18n ------------------------------------------------------
		const I18N = {
			zh: {
				refresh: "刷新",
				unavailable: "额度面板不可用",
				loading: "💰 加载中…",
				dragTitle: "拖拽移动 · 点击展开",
				dragMove: "拖拽移动",
				openrouter: "OpenRouter",
				deepseek: "DeepSeek",
				balance: "余额",
				currentConversation: "当前对话",
				today: "今日",
				week: "本周",
				month: "本月",
				lastHour: "过去1h",
				granted: "赠送",
				official: "官方",
				notConfigured: "未配置",
				footnote: "余额/赠送来自官方 API；当前对话/今日/1h 回放日志计价（今日有平台 token 时用官方）",
				updatedAt: "更新于",
				source: "源码",
				label: "额度面板",
				switchToEn: "EN",
			},
			en: {
				refresh: "Refresh",
				unavailable: "Quota panel unavailable",
				loading: "💰 Loading…",
				dragTitle: "Drag to move · Click to expand",
				dragMove: "Drag to move",
				openrouter: "OpenRouter",
				deepseek: "DeepSeek",
				balance: "Balance",
				currentConversation: "This chat",
				today: "Today",
				week: "Week",
				month: "Month",
				lastHour: "Last 1h",
				granted: "Granted",
				official: "official",
				notConfigured: "Not configured",
				footnote: "Balances/granted from official API; chat/today/1h from session-log replay (today uses official when platform token is set)",
				updatedAt: "Updated",
				source: "Source Code",
				label: "Quota Panel",
				switchToEn: "中",
			},
		};

		function detectLang() {
			try {
				const saved = localStorage.getItem(LANG_KEY);
				if (saved === "zh" || saved === "en") return saved;
			} catch {}
			const nav = typeof navigator !== "undefined" ? navigator.language : "";
			return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
		}

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
						const c = clampPos(p.x, p.y, false);
						p.x = c.x;
						p.y = c.y;
						return p;
					}
				}
			} catch {}
			return null;
		}

		function savePos(x, y) {
			try {
				// Persist the clamped position so a refresh never restores an
				// off-screen card.
				const c = clampPos(x, y, false);
				localStorage.setItem(POS_KEY, JSON.stringify({ x: c.x, y: c.y }));
			} catch {}
		}

		// Clamp a candidate card position so the card stays inside the viewport
		// with a safe margin. When the detail panel is expanded, keep the panel
		// bottom (y + EXPAND_GAP + PANEL_MAX_H) on screen as well.
		function clampPos(x, y, expanded) {
			const vw = typeof window !== "undefined" ? window.innerWidth : 0;
			const vh = typeof window !== "undefined" ? window.innerHeight : 0;
			if (!(vw > 0 && vh > 0)) return { x, y };
			const min = GRAB_MARGIN;
			const maxX = Math.max(min, vw - CARD_W - GRAB_MARGIN);
			const maxY = expanded
				? Math.max(min, vh - EXPAND_GAP - PANEL_MAX_H)
				: Math.max(min, vh - CARD_H - GRAB_MARGIN);
			return {
				x: Math.min(maxX, Math.max(min, x)),
				y: Math.min(maxY, Math.max(min, y)),
			};
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
			const [lang, setLang] = useState(() => detectLang());
			const [state, setState] = useState({ status: "loading", data: null, error: null, expanded: false });
			const [pos, setPos] = useState(() => loadPos() ?? { x: null, y: null });
			const [spinning, setSpinning] = useState(false);
			const mounted = useRef(true);
			const drag = useRef(null); // { startX, startY, origX, origY, moved }
			const t = (key) => I18N[lang][key] ?? key;

			const toggleLang = () => {
				const next = lang === "zh" ? "en" : "zh";
				setLang(next);
				try {
					localStorage.setItem(LANG_KEY, next);
				} catch {}
			};

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

			// Coverage probe: if something painted above the card (a body-level
			// portal with a higher z-index, e.g. the AgentTeams activity panel
			// at 2147483000) covers the card's grab surface, the card can no
			// longer receive pointer events and would be stuck forever. Detect
			// it via elementFromPoint at the card's own center and relocate to
			// the safe default spot. Never runs mid-drag (the pointer handlers
			// own the position then).
			useEffect(() => {
				const timer = setInterval(() => {
					if (drag.current !== null) return;
					const cardEl = document.querySelector(CARD_SEL);
					if (!cardEl) return;
					const r = cardEl.getBoundingClientRect();
					if (!(r.width > 0 && r.height > 0)) return;
					const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
					if (hit && hit.closest && hit.closest(CARD_SEL)) return; // still reachable
					// Covered: move back to the default top-left corner (clamped
					// into view) and persist it so a refresh keeps it safe.
					const safe = clampPos(16, 16, false);
					setPos((p) => {
						if (p.x === safe.x && p.y === safe.y) return p;
						savePos(safe.x, safe.y);
						return safe;
					});
				}, PROBE_MS);
				return () => clearInterval(timer);
			}, []);

			const onPointerDown = (e) => {
				// Left button only.
				if (e.button !== 0) return;
				// Never start a drag from interactive children (refresh button,
				// language toggle): they keep their own click behavior, and a
				// no-move press on them must not collapse/expand the panel.
				if (e.target && e.target.closest && e.target.closest("button, a")) return;
				const startX = e.clientX;
				const startY = e.clientY;
				// Anchor ONCE at pointer-down: if the card has a dragged
				// position use it, else anchor at the default corner (16,16)
				// — never at the grabbed element's own offset, because the
				// expanded panel sits EXPAND_GAP below the card and would
				// otherwise introduce a vertical jump on first drag. Never
				// re-read offsets during move — React re-renders change them
				// and the position would drift cumulatively until the card
				// flies off-screen.
				const origX = pos.x !== null ? pos.x : CARD_DEFAULT_X;
				const origY = pos.y !== null ? pos.y : CARD_DEFAULT_Y;
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
					// Clamp while dragging so the grab surface stays reachable.
					setPos(clampPos(d.origX + dx, d.origY + dy, state.expanded));
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
						const next = clampPos(p.x, p.y, state.expanded);
						savePos(next.x, next.y);
						return next;
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
			// when dragged, else corner default top-left).
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
							// Colorblind-safe: distinguish OR/DS by label text
							// (not color alone); blue is distinguishable for
							// red-green color vision deficiencies.
							jsx("span", { style: { fontWeight: 700, color: "var(--dsw-alias-text-accent, #4a9eff)" }, children: dsText }),
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
								title: t("refresh"),
								children: "↻",
							}),
						],
					})
				: status === "error"
					? jsx("span", { style: { color: "var(--dsw-alias-text-danger, #e5484d)" }, children: t("unavailable") })
					: jsx("span", { children: t("loading") });

			return jsxs(Fragment, {
				children: [
					jsx("div", {
						style: cardStyle,
						onPointerDown,
						onPointerMove,
						onPointerUp,
						title: t("dragTitle"),
						children: chipContent,
					}),
					expanded && ok && jsx("div", {
						style: {
							position: "fixed",
							zIndex: 9999,
							width: 310,
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
							cursor: "grab",
							userSelect: "none",
							touchAction: "none",
							// Cap the panel height so its bottom stays on screen
							// on short viewports / with wrapping zh text; the
							// content scrolls if it grows taller.
							maxHeight: "calc(100vh - 120px)",
							overflowY: "auto",
							...(pos.x !== null && pos.y !== null
								? { left: pos.x, top: pos.y + 40 }
								: { top: 52, left: 16 }),
						},
						// Drag from anywhere on the expanded panel: the whole
						// panel is a grab surface (buttons stay clickable via the
						// onPointerDown guard).
						onPointerDown,
						onPointerMove,
						onPointerUp,
						// Neutral hint: the card's "click to expand" no longer
						// applies once the panel is open (a no-move press there
						// collapses it).
						title: t("dragMove"),
						children: [
							// Header row: title + language toggle.
							jsx("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 },
								children: [
									jsx("span", { style: { fontWeight: 600, fontSize: 13 }, children: "💰 " + t("label") }),
									jsx("button", {
										style: {
											background: "none",
											border: "1px solid var(--dsw-alias-border-default)",
											borderRadius: 6,
											color: "inherit",
											cursor: "pointer",
											fontSize: 11,
											padding: "1px 8px",
										},
										onClick: toggleLang,
										title: t("switchToEn") === "EN" ? "Switch to English" : "切换到中文",
										children: t("switchToEn"),
									}),
								],
							}),
							// OpenRouter section
							jsx("div", { style: { fontWeight: 600, fontSize: 13 }, children: t("openrouter") }),
							or && !or.error
								? jsxs(Fragment, {
										children: [
											row(t("balance"), formatBalance(or.balance)),
											row(t("currentConversation"), or.sessionCost !== null && or.sessionCost !== void 0
												? formatCost(or.sessionCost)
												: "—"),
											row(t("today"), formatCost(or.usageDaily)),
											row(t("week"), formatCost(or.usageWeekly)),
											row(t("month"), formatCost(or.usageMonthly)),
											row(t("lastHour"), formatCost(or.hourSpend), true),
										],
									})
								: jsx("div", { style: { color: "var(--dsw-alias-text-danger, #e5484d)" }, children: String(or?.message ?? t("notConfigured")) }),
							jsx("div", { style: { height: 1, background: "var(--dsw-alias-border-default)", margin: "4px 0" } }),
							// DeepSeek section
							jsx("div", { style: { fontWeight: 600, fontSize: 13 }, children: t("deepseek") }),
							ds && !ds.error
								? jsxs(Fragment, {
										children: [
											row(t("balance"), formatBalance(ds.balance)),
											ds.granted !== null && ds.granted !== void 0
												? row(t("granted"), formatBalance(ds.granted))
												: null,
											row(t("currentConversation"), ds.sessionCost !== null && ds.sessionCost !== void 0
												? formatCost(ds.sessionCost)
												: "—"),
											row(t("today"), formatCost(ds.todaySpend) + (ds.todaySource === "official" ? ` (${t("official")})` : "")),
											row(t("lastHour"), formatCost(ds.hourSpend), true),
										],
									})
								: jsx("div", { style: { color: "var(--dsw-alias-text-danger, #e5484d)" }, children: String(ds?.message ?? t("notConfigured")) }),
							jsx("div", { style: { opacity: 0.5, fontSize: 11, marginTop: 4 }, children: t("footnote") }),
							data && data.updatedAt
								? jsx("div", {
										style: {
											marginTop: 4,
											paddingTop: 6,
											borderTop: "1px solid var(--dsw-alias-border-default)",
											display: "flex",
											alignItems: "center",
											gap: 4,
											fontSize: 12,
											fontWeight: 600,
										},
										children: [
											jsx("span", { style: { opacity: 0.9 }, children: "⏱" }),
											jsx("span", { style: { opacity: 0.9 }, children: `${t("updatedAt")} ${formatTime(data.updatedAt)}` }),
											jsx("span", { style: { opacity: 0.5 }, children: "·" }),
											jsx("a", {
												href: SOURCE_URL,
												target: "_blank",
												rel: "noreferrer",
												style: { color: "var(--dsw-alias-text-accent, #4a9eff)", textDecoration: "none", fontWeight: 600 },
												children: t("source"),
											}),
										],
									})
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
								? { color: "var(--dsw-alias-text-accent, #4a9eff)", fontWeight: 700 }
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
			const label = detectLang() === "zh" ? "额度面板" : "Quota Panel";
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "quota-dashboard",
				order: 120,
				label
			}, QuotaDashboard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
