import { EASY_SPEAK_MATCHES } from "../lib/easy-speak-hosts";
import {
	followResume,
	freshIdentity,
	discardExpiredSession,
	identityAtLoad,
	idbStore,
	type Identity,
	type Progress,
	type ResumeState,
	readSession,
	releaseLease,
	resumeState,
	runExport,
} from "../lib/easy-speak-walk";
import {
	CLUB_CHANGED_MESSAGE,
	clubChanged,
	finishExport,
	idbKv,
	monthLabel,
	monthName,
	type PickedMonth,
	prefill,
	readLastExport,
	saveLastExport,
	startMonth,
} from "../lib/last-export";
import { type PageGlobal, pageFetch } from "../lib/page-fetch";

/**
 * Easy-Speak export mode (#1047), the second mode beside the Base Camp sync.
 * Internal only, like the Pathways mode (ADR-0025): unlisted, run by the
 * maintainer or an officer of the maintainer's clubs. A member account is enough.
 *
 * Injects a small "Export this club for GavelUp" widget on a signed-in
 * easy-speak.org page. One click walks the club (sequentially, 1s between
 * requests, same-origin with the page's cookies; `pageFetch`) and downloads two JSON files (the bundle and its raw-pages archive).
 * It posts nothing anywhere: upload is a later step, by a superadmin.
 */
export default defineContentScript({
	matches: [...EASY_SPEAK_MATCHES],
	runAt: "document_idle",
	cssInjectionMode: "ui",
	async main(ctx) {
		// Only the club pages have the left panel. A popup (a request form, a profile) does not.
		if (!document.querySelector("#portal-left-panel span.name a")) return;

		const store = idbStore();
		// One id per page load: the lease that keeps a second tab from walking too.
		const owner = crypto.randomUUID();
		// As the page, in Firefox too: its plain content-script fetch is answered 403.
		const fetchImpl = pageFetch(globalThis as unknown as PageGlobal);
		const parseHtml = (html: string) =>
			new DOMParser().parseFromString(html, "text/html");
		const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
		// Which club and account this is, so an export left by another club or account is not
		// resumed here. Browsing makes no request for it: with nothing stored, and a page that
		// does not already show it, the button press asks.
		let identity: Identity | null = null;
		let resume: ResumeState = { kind: "none" };
		// The month the last successful export of this club left off at (#1491); blank when none.
		let picked: PickedMonth = prefill(null, null);
		try {
			// An abandoned export past its twelve hours is deleted, unless a walker still holds the lease.
			await discardExpiredSession(store, owner, Date.now());
		} catch {
			// Best effort: a failed cleanup must not stop the page's button.
		}
		try {
			identity = await identityAtLoad(document, store, Date.now(), fetchImpl, parseHtml, sleep);
			if (identity) resume = await resumeState(store, owner, Date.now(), identity);
		} catch {
			// Unreadable identity: no resume; pressing the button reports why.
		}
		// Awaited here, before the widget exists, so the selects are filled before anyone can touch them.
		const loadIdentity = identity;
		if (loadIdentity) {
			picked = prefill(loadIdentity, await readLastExport(loadIdentity.esClubId));
		}
		// A reload's old lease is not ours: give it up as the page goes (best effort; the
		// re-check below covers the case where this never completes).
		window.addEventListener("pagehide", () => {
			void releaseLease(store, owner).catch(() => {});
		});

		const ui = await createShadowRootUi(ctx, {
			name: "gavelup-easy-speak-export",
			position: "inline",
			anchor: "body",
			onMount: (container) => {
				container.appendChild(buildWidget(resume.kind === "auto" || resume.kind === "manual"));
			},
		});
		ui.mount();

		function buildWidget(hasSession: boolean): HTMLElement {
			const root = document.createElement("div");
			root.setAttribute(
				"style",
				"position:fixed;bottom:16px;right:16px;z-index:2147483647;font:13px system-ui,sans-serif;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.15);padding:10px 12px;max-width:300px;",
			);
			// "Meetings from": a month and a year select (Firefox renders <input type=month> as free text).
			// Year blank = the whole history; the month select is then disabled.
			const fromRow = document.createElement("div");
			fromRow.setAttribute("style", "display:flex;align-items:center;gap:6px;margin-bottom:8px;");
			const fromLabel = document.createElement("span");
			fromLabel.textContent = "Meetings from";
			const monthSel = document.createElement("select");
			for (let m = 1; m <= 12; m++) {
				const mm = String(m).padStart(2, "0");
				monthSel.append(new Option(monthName(mm).slice(0, 3), mm));
			}
			const yearSel = document.createElement("select");
			yearSel.append(new Option("all history", ""));
			const nextYear = new Date().getFullYear() + 1;
			for (let y = nextYear; y >= 2004; y--) yearSel.append(new Option(String(y), String(y)));
			monthSel.value = picked.month;
			yearSel.value = picked.year;
			// A stored session shows (and is locked to) its own start month; "Resume" passes it back.
			let sessionFrom: string | null = null;
			let locked = false;
			const lockTo = (session: { fromMonth?: string | null }) => {
				sessionFrom = session.fromMonth ?? null;
				locked = true;
				monthSel.value = sessionFrom ? sessionFrom.slice(5, 7) : "01";
				yearSel.value = sessionFrom ? sessionFrom.slice(0, 4) : "";
				syncSelects();
			};
			const syncSelects = () => {
				monthSel.disabled = yearSel.value === "" || locked;
				yearSel.disabled = locked;
			};
			yearSel.addEventListener("change", syncSelects);
			syncSelects();
			if (resume.kind === "auto" || resume.kind === "manual") lockTo(resume.session);
			fromRow.append(fromLabel, monthSel, yearSel);
			const row = document.createElement("div");
			row.setAttribute("style", "display:flex;align-items:center;gap:8px;");
			const btn = document.createElement("button");
			btn.textContent = hasSession
				? "Resume export"
				: "Export this club for GavelUp";
			btn.setAttribute(
				"style",
				"cursor:pointer;padding:6px 10px;border-radius:6px;border:1px solid #6d28d9;background:#6d28d9;color:#fff;font-weight:600;",
			);
			row.append(btn);
			const status = document.createElement("div");
			status.setAttribute(
				"style",
				"margin-top:8px;white-space:pre-wrap;line-height:1.35;",
			);
			root.append(fromRow, row, status);

			function setStatus(msg: string, color = "#374151") {
				status.textContent = msg;
				status.style.color = color;
			}
			const onProgress = (p: Progress) =>
				setStatus(`${p.done} / ${p.total} pages\n${p.label}`);

			async function start() {
				btn.disabled = true;
				setStatus("Starting...");
				follower?.cancel();
				try {
					const fromMonth = startMonth(locked ? { fromMonth: sessionFrom } : null, {
						year: yearSel.value,
						month: monthSel.value,
					});
					const result = await runExport({
						fetchImpl,
						parseHtml,
						store,
						owner,
						// Asked of the server now, not read off this page, which may be hours old: the
						// user may have switched club or account in another tab since it loaded.
						// The pre-filled month belongs to the club the page was loaded for: refuse before any walk.
						identity: await freshIdentity(fetchImpl, parseHtml, sleep).then((id) => {
							if (clubChanged(loadIdentity, id)) throw new Error(CLUB_CHANGED_MESSAGE);
							return id;
						}),
						sleep,
						now: Date.now,
						extensionVersion: browser.runtime.getManifest().version,
						fromMonth,
						onProgress,
					});
					const { bundle, fileName, archiveFileName } = result;
					// Both downloads, then the remembered month: nothing is saved unless both returned.
					const after = await finishExport(result, {
						download,
						save: (esClubId, month) => saveLastExport(esClubId, month, { kv: idbKv() }),
					});
					const range = bundle.range ? ` from ${monthLabel(bundle.range.fromMonth)} on` : "";
					setStatus(
						[
							`Saved ${fileName} (upload this one) and ${archiveFileName} (raw pages, keep it; if it is missing, your browser may have blocked the second download, so check its download prompt).`,
							`${bundle.meetings.length} meetings${range}, ${bundle.speechRequests.length} speeches, ${bundle.people.length} people.`,
							...after,
						].join("\n"),
						"#065f46",
					);
					btn.textContent = "Export this club for GavelUp";
					locked = false;
					syncSelects();
				} catch (err) {
					if ((err as Error).message === CLUB_CHANGED_MESSAGE) {
						// Nothing was walked and nothing is stored: no Resume.
						setStatus(CLUB_CHANGED_MESSAGE, "#b91c1c");
						return;
					}
					setStatus(
						`${(err as Error).message}\nPress Resume to continue where it stopped.`,
						"#b91c1c",
					);
					btn.textContent = "Resume export";
					// A walk that stopped left a session: Resume continues it, with its own start month.
					try {
						const left = await readSession(store, Date.now());
						if (left) lockTo(left);
					} catch {
						// Best effort: the selects stay open.
					}
				} finally {
					btn.disabled = false;
				}
			}
			btn.addEventListener("click", start);

			// A reload mid-walk: pick up at once. A stale session waits for the button.
			// A lease another load holds is re-checked when it runs out: it is this tab's own
			// previous load unless a tab really is walking and renewing it.
			let follower: { cancel: () => void } | undefined;
			function react(state: ResumeState) {
				if (state.kind === "auto") {
					void start();
				} else if (state.kind === "manual") {
					btn.textContent = "Resume export";
					setStatus(`An unfinished export is stored (${state.session.pages} pages).`);
				} else if (state.kind === "elsewhere") {
					setStatus(
						"Another Easy-Speak tab is exporting this club right now.\nThis tab will check again when it stops.",
					);
				}
			}
			react(resume);
			if (resume.kind === "elsewhere" && identity) {
				follower = followResume(resume, {
					store,
					owner,
					identity,
					now: Date.now,
					setTimer: (fn, ms) => setTimeout(fn, ms),
					clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
					onState: react,
				});
			}
			return root;
		}

		function download(fileName: string, json: string) {
			const url = URL.createObjectURL(
				new Blob([json], { type: "application/json" }),
			);
			const a = document.createElement("a");
			a.href = url;
			a.download = fileName;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		}
	},
});
