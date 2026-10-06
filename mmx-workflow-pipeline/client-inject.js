// Client bundle of mmx-workflow-pipeline — ZCode-style live workflow progress inside the
// MiniMax Code native renderer (DEVELOPMENT.md §4 D3), injected over CDP by sidecar.mjs.
//
// Ported from the DSH client.js 0.2.4 bundle with the standing deltas:
//   1) self-executing IIFE (MiniMax Code has no DSH client-module loader) + version gate 4
//   2) API base http://127.0.0.1:4231 (sidecar host API); every request goes through
//      apiFetch(path, opts), which adds X-Workflow-Capability from the closure-local
//      capability placeholder (single literal, substituted by sidecar.mjs at inject
//      time). The capability never appears in a URL, storage, logs or a readable global.
//   3) DOM selectors from D1 (docs/dom-probe.md); the CURRENT SESSION is read from the host's
//      own per-tab session state (sessionStorage 'mavis:activeSessionId', first) and only then
//      from [data-shortcut-session-active="true"][data-shortcut-session-target] when the host
//      exposes it. Both are the host telling us which session is active — we never guess from
//      titles or cwd basenames, and every cur-dependent surface has a no-session fallback.
//   4) every dwf- prefix -> mmxdwf- (style id, card id, modal id, data-* attrs, localStorage key)
// Identity (runKey||runId + startedAt lifecycle), phase semantics, single-flight polling,
// modal generations, teardown, artifact handling and explicit run→session binding match
// the DSH 0.2.4 contract (REPAIR-024). Reference layout: horizontal phase columns,
// compact single-line agent capsules in columns, script as the first cell, board at the
// card bottom.
(function () {
	var CLIENT_VERSION = 11;
	if (window.__mmxDwfInstalled && window.__mmxDwfVersion >= CLIENT_VERSION) return;
	if (window.__mmxDwfInstalled && typeof window.__mmxDwfTeardown === 'function') window.__mmxDwfTeardown();
	['mmxdwf-modal', 'mmxdwf-pipeline-style', 'mmxdwf-global-entry'].forEach(function (id) { var old = document.getElementById(id); if (old) old.remove(); });
	window.__mmxDwfInstalled = true;
	window.__mmxDwfVersion = CLIENT_VERSION;

	var POLL_MS = 2000;
	var NS = 'mmxdwf';
	var CARD_ID = 'mmxdwf-run-card';
	var DISMISS_KEY = 'mmxdwf-dismissed';
	var VISIBLE_KEY = 'mmxdwf-visible-runs';
	var BINDINGS_KEY = 'mmxdwf-session-bindings';
	var MODAL_ID = 'mmxdwf-modal';
	var ENTRY_ID = 'mmxdwf-global-entry';
	var STYLE_ID = 'mmxdwf-pipeline-style';
	var API = 'http://127.0.0.1:4231';

	// D1-measured selectors (docs/dom-probe.md, MMX-310-SESSION-MARKERS.md) ----
	// Conversation scroll host. The home route (new conversation) is positively identified by
	// mavis-home-content with no message-list; it never carries conversation cards (024-R4).
	var CONVERSATION_SEL = '[data-testid="message-list"]';
	var HOME_SEL = '[data-testid="mavis-home-content"]';

	// REPAIR-024: the sidecar generates a random per-start capability and replaces the single
	// placeholder below at injection time, so the real value lives only inside this closure —
	// never in a URL, localStorage, a log, or a readable global property.
	var CAPABILITY = '__MMXDWF_CAPABILITY__';
	function apiFetch(path, opts) {
		opts = opts || {};
		var headers = {};
		for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
		headers['X-Workflow-Capability'] = CAPABILITY;
		opts.headers = headers;
		return fetch(API + path, opts);
	}
	// F05: a plugin-level bounded deadline on the two wedged control-plane requests — the /runs
	// poll and the three mutations. The sidecar is a loopback host, so a request that has
	// neither failed nor answered is a wedge, not a slow network; and a wedge must not be
	// allowed to hold pollInFlight (every later /runs poll is skipped) or a pending control.
	// The deadline is armed on the request and stays armed until the BODY settles, so a socket
	// that delivers headers and then stalls is bounded too. The existing offline banner and
	// visibility wake-up already cover the recovery path; this adds no polling framework.
	// Scope note: only these two surfaces go through apiBounded. The modal reads (script,
	// result, artifact blob, the history list) keep plain apiFetch — an artifact blob has its
	// own size bound and is not a control-plane request, and widening the deadline there is
	// beyond the minimal change the plan asks for.
	var REQUEST_DEADLINE_MS = 20000;
	function apiBounded(path, opts, budget) {
		opts = opts || {};
		if (!budget || typeof AbortController === 'undefined') {
			// No deadline (a caller that opts out, or no native AbortController): identical body
			// read and identical three-way receipt, just unbounded. Never skip the read.
			return apiFetch(path, opts).then(function (r) {
				return r.json().then(
					function (b) { return { r: r, b: b }; },
					function (e) { return { r: r, b: null, bodyError: e }; });
			});
		}
		var ac = new AbortController();
		var timer = setTimeout(function () { ac.abort(); }, budget);
		var disarmed = false;
		var disarm = function () { if (disarmed) return; disarmed = true; clearTimeout(timer); };
		opts.signal = ac.signal;
		return apiFetch(path, opts).then(function (r) {
			return r.json().then(
				function (b) { disarm(); return { r: r, b: b }; },
				// A body that cannot be read at all (truncated, not JSON, or aborted by the
				// deadline) is reported as a read failure with the response still attached, so
				// the caller can still tell a definite HTTP refusal from an unreadable receipt.
				function (e) { disarm(); return { r: r, b: null, bodyError: e }; });
		}, function (e) { disarm(); throw e; });
	}
	function verdictOf(r, b) {
		return !!r.ok && !(b && b.ok === false);
	}
	// F18 + F19: a mutation has THREE outcomes, not two.
	//   'accepted'  — a parseable object carrying the explicit success field. Only this is a
	//                 definite success; 'HTTP 200' alone never was, because a body that failed
	//                 to parse used to collapse into {} and pass every "!== false" test.
	//   'rejected'  — a DEFINITE refusal: a non-2xx status, or an explicit ok:false. The host
	//                 answered, so the mutation did not happen and a retry is safe.
	//   'unconfirmed' — the request may already have been applied and we cannot tell: a
	//                 truncated/non-JSON body, a 200 without the field, the host's own
	//                 504 RESUME_UNCONFIRMED, a dead socket, or our own deadline. The draft
	//                 and the visible state are kept and NOTHING is resent automatically; the
	//                 existing /runs poll reconciles the epoch/qId.
	var UNCONFIRMED = 'unconfirmed';
	var UNCONFIRMED_TEXT = '结果未确认：请求可能已在工作流端生效，请以运行状态为准，勿重复提交';
	function receiptState(r, b, need) {
		// The host's own 504 is a definite RESPONSE saying the spawn may have happened.
		if (b && b.code === 'RESUME_UNCONFIRMED') return UNCONFIRMED;
		// An explicit ok:false is a refusal whatever the status, including a 200.
		if (b && b.ok === false) return 'rejected';
		if (!r.ok) return 'rejected';
		if (!b || typeof b !== 'object' || Array.isArray(b) || b.ok !== true) return UNCONFIRMED;
		if (need && b[need] !== true) return UNCONFIRMED;   // resume additionally must be accepted
		return 'accepted';
	}
	// Same three outcomes for a receipt that also carries a read failure. A non-2xx status is a
	// DEFINITE refusal whatever the body says — the host answered, so the mutation did not
	// happen. Only a 2xx we could not read back is the unknown case.
	function mutationVerdict(x, need) {
		if (x.b && x.b.code === 'RESUME_UNCONFIRMED') return UNCONFIRMED;
		if (!x.r.ok) return 'rejected';
		if (x.bodyError) return UNCONFIRMED;
		return receiptState(x.r, x.b, need);
	}
	function receiptError(state, b, r, label) {
		if (state !== 'rejected') return UNCONFIRMED_TEXT;
		return String((b && b.error) || (label + '失败（HTTP ' + r.status + '）'));
	}
	function apiJson(r) {
		return r.json().then(function (body) {
			if (!verdictOf(r, body)) throw new Error((body && body.error) || ('HTTP ' + r.status));
			return body;
		});
	}

	var runs = [];
	var stopped = false;
	var pollInFlight = false;
	var pollGen = 0;
	var offline = false;
	var lastSyncAt = 0;
	var lastHttpError = '';
	var persistWarning = '';
	var cardAnchor = null;
	var activeBlobUrls = [];

	// ---------- persistence (failures are visible, never silent) ----------
	var loadDismissed = function () {
		try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); }
		catch (e) { persistWarning = '关闭记录读取失败（localStorage 异常），已忽略旧关闭状态'; return new Set(); }
	};
	var saveDismissed = function (set) {
		try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...set])); return true; }
		catch (e) { persistWarning = '关闭状态保存失败（localStorage 不可用），刷新后已关闭的卡片可能重新出现'; return false; }
	};
	var dismissed = loadDismissed();
	// F08: a corrupt visible-runs record used to be dropped in silence — the set was emptied
	// and no warning was set, so a terminal run left the card pool with nothing on screen
	// explaining why. Three outcomes have to be told apart, and only the first is absence:
	//   missing key          -> an empty set and NO warning (there was never a record)
	//   a non-array payload  -> corruption. `new Set("ab")` enumerates the string's
	//                            characters and `new Set(null)` yields an empty set, both
	//                            WITHOUT throwing, so the array check is the only thing
	//                            standing between a corrupt record and a silent loss.
	//   invalid JSON / a storage that throws -> corruption, same warning.
	// The failed read still yields an empty set (never a fabricated old record) and the write
	// path below is untouched.
	var visibleRuns;
	try {
		var visibleParsed = JSON.parse(localStorage.getItem(VISIBLE_KEY) || '[]');
		if (!Array.isArray(visibleParsed)) throw new Error(VISIBLE_KEY + ' is not an array');
		visibleRuns = new Set(visibleParsed);
	} catch (e) {
		visibleRuns = new Set();
		persistWarning = '卡片显示记录读取失败（localStorage 数据损坏或不可读），已忽略旧的显示记录';
	}
	function saveVisible() {
		try { localStorage.setItem(VISIBLE_KEY, JSON.stringify([...visibleRuns])); return true; }
		catch (e) { persistWarning = '卡片显示状态保存失败（localStorage 不可用），刷新后可能丢失'; return false; }
	}
	// Manual bindings are only for legacy runs without native origin metadata.
	var bindings;
	try {
		bindings = JSON.parse(localStorage.getItem(BINDINGS_KEY) || '{}');
		if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) bindings = {};
	} catch (e) { bindings = {}; persistWarning = '会话绑定数据读取失败（localStorage 异常），已忽略旧绑定'; }
	function saveBindings() {
		try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings)); return true; }
		catch (e) { persistWarning = '会话绑定保存失败（localStorage 不可用），刷新后可能丢失'; return false; }
	}

	// ---------- session adapter ----------
	// The host writes the active session id into its own per-tab session state
	// (sessionStorage['mavis:activeSessionId'], measured on 3.1.0) and additionally marks the
	// active session in the DOM. sessionStorage is the FIRST source because it is the
	// current-session state itself: the DOM marker only exists while the active element is
	// actually rendered, so it can be missing (collapsed) or stale (virtualized list) and
	// would make the one-click surfaces flicker on and off. When the two disagree the host's
	// state wins. A missing key, an unreadable storage, or a value that is not a session id
	// counts as "not available" — we fall back to the DOM marker and, failing that, return ''
	// ("no verifiable current session"), never a guess.
	//
	// F01 (re-verified against the CURRENT Desktop build, read-only, in
	// out/_next/static/chunks/90321-b899277594fb8c24.js): that key is NOT a local/cloud-shared
	// current id. The session store is a per-SOURCE factory and persistence is gated on the
	// source predicate `Vw = (e) => !isWeb || e === 'local'` (module 81775), so with the desktop
	// build the key is written, hydrated and cleared for the LOCAL source ONLY
	// (`activeSessionId: Vw(i) ? d.load() : null`, `setActiveSession: Vw(i) && d.save(a)`).
	// Switching the source writes `mavis.conversationSource` and clears nothing; the key is
	// removed in exactly one place, logout. So under the cloud source the key still holds a
	// leftover LOCAL id, and returning it wrote the manual attribution to the wrong session even
	// while the host's marker named the cloud one.
	//
	// The source is read from the host's own persisted key (`mavis.conversationSource`,
	// localStorage, 'local' | 'cloud'). The desktop build's own default when that key is absent
	// is "local", so an unreadable/absent source keeps the previous behaviour untouched; only a
	// VERIFIED cloud source changes which source is applicable, and then the persisted key is
	// dropped rather than trusted: the DOM marker (still the host telling us which session is
	// active) answers, and with no marker we return '' and fail closed — no bind surface at all,
	// nothing derived from a title or a cwd.
	var ACTIVE_SESSION_KEY = 'mavis:activeSessionId';
	var SOURCE_KEY = 'mavis.conversationSource';
	var SESSION_ID_RE = /^mvs_[0-9a-f]{32}$/;
	function hostSource() {
		try {
			if (typeof localStorage === 'undefined' || !localStorage) return '';
			var v = localStorage.getItem(SOURCE_KEY);
			return v === 'local' || v === 'cloud' ? v : '';
		} catch (e) { return ''; }
	}
	function storedSessionId() {
		if (hostSource() === 'cloud') return '';
		try {
			if (typeof sessionStorage === 'undefined' || !sessionStorage) return '';
			var v = sessionStorage.getItem(ACTIVE_SESSION_KEY);
			return v && SESSION_ID_RE.test(v) ? v : '';
		} catch (e) { return ''; }
	}
	function currentSessionId() {
		var stored = storedSessionId();
		if (stored) return stored;
		var el = document.querySelector('[data-shortcut-session-active="true"][data-shortcut-session-target]');
		return el ? (el.getAttribute('data-shortcut-session-target') || '') : '';
	}
	function identity(run) { return (run && (run.runKey || run.runId)) || ''; }
	function bindingOf(run) {
			if (run && run.hostSession != null) {
				var native = run.hostSession;
				var valid = native && typeof native === 'object' && !Array.isArray(native)
					&& typeof native.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(native.sessionId)
					&& ((native.host === 'dsh' && native.source === 'native-shell') || (native.host === 'mmx' && native.source === 'native-hook'));
				return valid ? { host: native.host, sessionId: native.sessionId, source: native.source, native: true } : { host: '', sessionId: '', source: '', native: true, invalid: true };
			}
			var manual = bindings[identity(run)];
			if (!manual || typeof manual.sessionId !== 'string') return null;
			// v9: read the origin the record carries instead of synthesizing host:'mmx' on every
			// read. A record without host/source predates the field; the storage key belongs to
			// this client alone and its only writer was this client's own explicit bind control,
			// so those stay valid. A record that names a DIFFERENT origin is not ours and is
			// ignored outright — it must not be relabelled as one of our own bindings (foreign
			// attribution stays isolated).
			if (manual.host == null && manual.source == null) return { host: 'mmx', sessionId: manual.sessionId, source: 'mmx-picker' };
			if (manual.host !== 'mmx' || (manual.source !== 'mmx-picker' && manual.source !== 'mmx-oneclick')) return null;
			return { host: manual.host, sessionId: manual.sessionId, source: manual.source };
		}
	function bindRunToSession(run, sid, source) {
		if (!run || !sid || run.hostSession != null) return;
		// v8: persist the attribution shape the contract names ({host, source}) — the
		// record used to carry only {sessionId, runId, name}, so 'mmx' was synthesized
		// on read and the origin of a binding was indistinguishable on disk.
		// v10: the record names WHICH deliberate action produced it, so a one-click bind
		// is never stamped with the older 'mmx-picker' provenance (still accepted on read).
		bindings[identity(run)] = { host: 'mmx', source: source === 'mmx-oneclick' ? 'mmx-oneclick' : 'mmx-picker', sessionId: String(sid), runId: run.runId || '', name: run.name || '', savedAt: new Date().toISOString() };
		saveBindings();
		try { sweepCard(); } catch (e) {}
	}
	function unbindRun(run) {
		if (!run || run.hostSession != null) return;
		delete bindings[identity(run)];
		saveBindings();
		try { sweepCard(); } catch (e) {}
	}

	var controls = new Map();
	function controlsFor(run) {
		var id = identity(run);
		var state = controls.get(id);
		if (!state || state.startedAt !== run.startedAt) {
			state = { startedAt: run.startedAt, answers: new Map(), drafts: new Map(), resume: '', stop: '', error: '' };
			controls.set(id, state);
		}
		return state;
	}
	var resultCache = new Map();
	var resultPending = new Set();
	var scriptCache = {};

	var CSS = ''
		+ '[data-mmxdwf-card]{font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--wf-text);background:var(--wf-surface);border:1px solid var(--wf-border);border-radius:14px;padding:16px 18px 14px;margin:2px 2px 14px;box-shadow:0 1px 8px var(--wf-inset);}'
		+ '[data-mmxdwf-card].mmxdwf-full{position:fixed;inset:20px;z-index:99990;overflow:auto;background:var(--wf-surface);}'
		+ '[data-mmxdwf-card] .mmxdwf-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-title{font-weight:650;font-size:14px;letter-spacing:.2px;color:var(--wf-strong);display:inline-flex;align-items:center;gap:7px;}'
		+ '[data-mmxdwf-card] .mmxdwf-title .mmxdwf-gear{opacity:.9;font-size:14px;}'
		+ '[data-mmxdwf-card] .mmxdwf-runname{color:var(--wf-muted);font-size:12.5px;padding-left:10px;border-left:1px solid var(--wf-border);}'
		+ '[data-mmxdwf-card] .mmxdwf-stats{margin-left:auto;color:var(--wf-muted);font-size:11.5px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;}'
		+ '[data-mmxdwf-card] .mmxdwf-stats .mmxdwf-live-dot{width:6px;height:6px;border-radius:50%;background:var(--wf-accent);animation:mmxdwf-pulse 1.6s infinite;}'
		+ '[data-mmxdwf-card] .mmxdwf-icos{display:inline-flex;gap:6px;margin-left:4px;}'
		+ '[data-mmxdwf-card] .mmxdwf-ico{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-subtle);color:var(--wf-text);cursor:pointer;font-size:11px;padding:0;transition:all .15s ease;}'
		+ '[data-mmxdwf-card] .mmxdwf-ico:hover{color:var(--wf-strong);border-color:rgba(255,255,255,.22);background:var(--wf-border);}'
		+ '[data-mmxdwf-card] .mmxdwf-ico.mmxdwf-close:hover{color:#ff6b60;}'
		+ '[data-mmxdwf-card] .mmxdwf-pill{display:inline-flex;align-items:center;gap:7px;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:999px;padding:5px 14px;font-size:11.5px;color:var(--wf-text);cursor:pointer;transition:all .15s ease;}'
		+ '[data-mmxdwf-card] .mmxdwf-pill:hover{border-color:rgba(255,255,255,.24);color:var(--wf-strong);background:rgba(255,255,255,.065);}'
		+ '[data-mmxdwf-card] .mmxdwf-phasecols{display:flex;align-items:flex-start;margin:14px 2px 2px;}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol{flex:1;min-width:0;position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:0 10px 0 0;}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol + .mmxdwf-pcol{padding-left:18px;}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol + .mmxdwf-pcol::before{content:"";position:absolute;top:4px;left:0;width:13px;height:2px;background:var(--wf-border);border-radius:1px;}'
		+ '[data-mmxdwf-card] .mmxdwf-pdot{width:9px;height:9px;border-radius:50%;background:#3a3d44;border:1px solid #3c4048;box-sizing:border-box;flex:none;}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol.done .mmxdwf-pdot{background:var(--wf-success);border-color:rgba(52,199,89,.4);}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol.now .mmxdwf-pdot{background:var(--wf-accent);border-color:rgba(255,159,10,.45);animation:mmxdwf-pulse 1.6s infinite;}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol.failed .mmxdwf-pdot{background:var(--wf-failure);border-color:rgba(255,113,105,.45);}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol.rejected .mmxdwf-pdot,[data-mmxdwf-card] .mmxdwf-pcol.partial .mmxdwf-pdot{background:var(--wf-accent);opacity:.75;}'
		+ '[data-mmxdwf-card] .mmxdwf-pname{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550;color:var(--wf-text);}'
		+ '[data-mmxdwf-card] .mmxdwf-pc{font-size:10.5px;color:var(--wf-muted);font-variant-numeric:tabular-nums;}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol.failed .mmxdwf-pc{color:var(--wf-failure);font-weight:600;}'
		+ '[data-mmxdwf-card] .mmxdwf-pcol.partial .mmxdwf-pc,[data-mmxdwf-card] .mmxdwf-pcol.rejected .mmxdwf-pc{color:var(--wf-accent);}'
		+ '[data-mmxdwf-card] .mmxdwf-workrow{display:flex;gap:16px;align-items:flex-start;margin-top:12px;flex-wrap:wrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-scriptcell{display:inline-flex;align-items:center;gap:10px;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:9px;padding:8px 13px;font-size:12px;font-weight:550;color:var(--wf-text);cursor:pointer;flex:none;min-width:120px;justify-content:space-between;}'
		+ '[data-mmxdwf-card] .mmxdwf-scriptcell:hover{color:var(--wf-strong);border-color:rgba(255,255,255,.2);}'
		+ '[data-mmxdwf-card] .mmxdwf-sct{font-family:"Cascadia Code",Consolas,monospace;font-size:11px;color:var(--wf-muted);}'
		+ '[data-mmxdwf-card] .mmxdwf-scok{color:var(--wf-success);font-size:11px;}'
		+ '[data-mmxdwf-card] .mmxdwf-agcol{display:flex;flex-direction:column;gap:8px;flex:1;min-width:170px;max-width:240px;}'
		+ '[data-mmxdwf-card] .mmxdwf-ag{display:flex;align-items:center;gap:8px;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:9px;padding:5px 10px;min-width:0;}'
		+ '[data-mmxdwf-card] .mmxdwf-av2{width:18px;height:18px;border-radius:6px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700;}'
		+ '[data-mmxdwf-card] .mmxdwf-lb{flex:1;min-width:0;font-weight:550;font-size:12px;color:var(--wf-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-agst{font-size:10.5px;color:var(--wf-muted);flex:none;}'
		+ '[data-mmxdwf-card] .mmxdwf-agst.failed{color:var(--wf-failure);}[data-mmxdwf-card] .mmxdwf-agst.rejected{color:#c78a7a;}[data-mmxdwf-card] .mmxdwf-agst.done{color:var(--wf-success);}[data-mmxdwf-card] .mmxdwf-agst.replayed{color:#5ac8fa;}'
		+ '[data-mmxdwf-card] .mmxdwf-spin{width:11px;height:11px;border:2px solid rgba(255,159,10,.25);border-top-color:var(--wf-accent);border-radius:50%;animation:mmxdwf-rot .8s linear infinite;flex:none;}'
		+ '[data-mmxdwf-card] .mmxdwf-result{margin-top:12px;background:var(--wf-inset);border:1px solid var(--wf-border);border-radius:10px;padding:10px 13px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--wf-text);font-size:11.5px;}'
		+ '#' + MODAL_ID + '{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(3px);}'
		+ '#' + MODAL_ID + ' .mmxdwf-mbox{width:min(880px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--wf-surface);border:1px solid var(--wf-border);border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.5);font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--wf-text);}'
		+ '#' + MODAL_ID + ' .mmxdwf-mhead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--wf-border);font-weight:650;font-size:13.5px;color:var(--wf-strong);}'
		+ '#' + MODAL_ID + ' .mmxdwf-mclose{margin-left:auto;cursor:pointer;color:var(--wf-muted);border:none;background:none;font-size:18px;width:28px;height:28px;border-radius:8px;transition:all .15s ease;}'
		+ '#' + MODAL_ID + ' .mmxdwf-mclose:hover{color:var(--wf-strong);background:var(--wf-border);}'
		+ '#' + MODAL_ID + ' .mmxdwf-mbody{padding:14px 18px;overflow:auto;overscroll-behavior:contain;}'
		+ '#' + MODAL_ID + ' pre.mmxdwf-code{margin:0;white-space:pre-wrap;word-break:break-word;font:11.5px/1.6 "Cascadia Code",Consolas,monospace;color:var(--wf-text);background:var(--wf-inset);border-radius:10px;padding:12px 14px;}'
		+ '#' + MODAL_ID + ' .mmxdwf-sev{margin:14px 0 6px;font-weight:700;font-size:12px;display:flex;align-items:center;gap:8px;}'
		+ '#' + MODAL_ID + ' .mmxdwf-sev::after{content:"";flex:1;height:1px;background:var(--wf-border);}'
		+ '#' + MODAL_ID + ' .mmxdwf-sev.P0{color:var(--wf-failure);}#' + MODAL_ID + ' .mmxdwf-sev.P1{color:var(--wf-accent);}#' + MODAL_ID + ' .mmxdwf-sev.P2{color:#ffd60a;}#' + MODAL_ID + ' .mmxdwf-sev.P3{color:#9a9ea8;}'
		+ '#' + MODAL_ID + ' .mmxdwf-fitem{background:var(--wf-subtle);border:1px solid var(--wf-border);border-left:3px solid rgba(255,255,255,.14);border-radius:10px;padding:10px 13px;margin:8px 0;}'
		+ '#' + MODAL_ID + ' .mmxdwf-ftitle{font-weight:600;color:var(--wf-strong);}'
		+ '#' + MODAL_ID + ' .mmxdwf-fdetail{color:var(--wf-muted);margin-top:3px;font-size:12px;}'
		+ '@keyframes mmxdwf-rot{to{transform:rotate(360deg);}}'
		+ '@keyframes mmxdwf-fadein{from{opacity:0;transform:translateY(-3px);}to{opacity:1;transform:none;}}'
		+ '@keyframes mmxdwf-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-4px);}75%{transform:translateX(4px);}}'
		+ '@keyframes mmxdwf-pulse{0%{box-shadow:0 0 0 0 rgba(255,159,10,.4);}70%{box-shadow:0 0 0 8px rgba(255,159,10,0);}100%{box-shadow:0 0 0 0 rgba(255,159,10,0);}}'
		+ '[data-mmxdwf-card] .mmxdwf-qzone{margin:12px 0 0;}'
		+ '[data-mmxdwf-card] .mmxdwf-q.waiting{display:flex;gap:10px;align-items:center;background:rgba(255,159,10,.06);border:1px solid rgba(255,159,10,.28);border-left:3px solid var(--wf-accent);border-radius:10px;padding:9px 12px;flex-wrap:wrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-q.waiting .mmxdwf-qtext{font-size:12.5px;color:var(--wf-ask);flex:1 1 200px;min-width:0;}'
		+ '[data-mmxdwf-card] .mmxdwf-qin{flex:1 1 220px;min-width:0;background:var(--wf-inset);border:1px solid var(--wf-border);border-radius:8px;color:var(--wf-strong);font:12px/1.4 inherit;padding:6px 10px;outline:none;}'
		+ '[data-mmxdwf-card] .mmxdwf-qin:focus{border-color:rgba(255,159,10,.5);}'
		+ '[data-mmxdwf-card] .mmxdwf-qsend{border:none;border-radius:8px;background:var(--wf-accent);color:#241703;font-weight:650;font-size:12px;padding:7px 14px;cursor:pointer;}'
		+ '[data-mmxdwf-card] .mmxdwf-qsend:hover{background:#ffb03a;}'
		+ '[data-mmxdwf-card] .mmxdwf-q.answered{font-size:11.5px;color:var(--wf-muted);margin:6px 0 0;padding-left:12px;}'
		+ '[data-mmxdwf-card] .mmxdwf-arts{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0;}'
		+ '[data-mmxdwf-card] .mmxdwf-art{display:inline-flex;gap:7px;align-items:center;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:9px;padding:6px 11px;font-size:11.5px;color:var(--wf-text);max-width:260px;}'
		+ '[data-mmxdwf-card] .mmxdwf-art.primary{border-color:rgba(255,159,10,.45);background:rgba(255,159,10,.05);}'
		+ '[data-mmxdwf-card] .mmxdwf-art .mmxdwf-atitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-art .mmxdwf-star{color:var(--wf-accent);flex:none;}'
		+ '[data-mmxdwf-card] .mmxdwf-art a{color:#7ab8ff;text-decoration:none;}'
		+ '[data-mmxdwf-card] .mmxdwf-artopen{display:inline-flex;gap:7px;align-items:center;background:none;border:none;color:inherit;font:inherit;cursor:pointer;padding:0;max-width:220px;}'
		+ '[data-mmxdwf-card] .mmxdwf-artopen:hover .mmxdwf-atitle{color:var(--wf-strong);text-decoration:underline;}'
		+ '[data-mmxdwf-card] .mmxdwf-artwarn{color:var(--wf-failure);font-size:10.5px;}'
		+ '[data-mmxdwf-card] .mmxdwf-logs{margin:12px 0 0;background:var(--wf-inset);border:1px solid var(--wf-border);border-radius:9px;padding:8px 12px;font:11px/1.6 "Cascadia Code",Consolas,monospace;color:var(--wf-muted);}'
		+ '[data-mmxdwf-card] .mmxdwf-logs .mmxdwf-logline{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-logs .mmxdwf-logline.fresh{animation:mmxdwf-fadein .6s ease;}'
		+ '[data-mmxdwf-card] .mmxdwf-more{display:block;background:none;border:none;color:var(--wf-muted);font-size:11px;cursor:pointer;padding:2px 0;margin-top:4px;text-align:left;font-family:inherit;}'
		+ '[data-mmxdwf-card] .mmxdwf-more:hover{color:var(--wf-strong);text-decoration:underline;}'
		+ '[data-mmxdwf-banner] .mmxdwf-more{display:inline;background:none;border:none;color:var(--wf-accent);font-size:12px;cursor:pointer;padding:0;font-family:inherit;}'
		+ '[data-mmxdwf-banner] .mmxdwf-more:hover{color:var(--wf-strong);text-decoration:underline;}'
		+ '[data-mmxdwf-card] .mmxdwf-result{cursor:pointer;}'
		+ '[data-mmxdwf-card] .mmxdwf-result:hover{border-color:rgba(255,255,255,.16);}'
		+ '[data-mmxdwf-card] .mmxdwf-ico.mmxdwf-resume:hover{color:#7ab8ff;}'
		+ '[data-mmxdwf-card] .mmxdwf-shake{animation:mmxdwf-shake .3s ease;}'
		+ '#' + MODAL_ID + ' .mmxdwf-hrow{display:flex;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--wf-border);border-radius:10px;margin:6px 0;cursor:pointer;flex-wrap:wrap;}'
		+ '#' + MODAL_ID + ' .mmxdwf-hrow:hover{border-color:rgba(255,255,255,.16);background:var(--wf-subtle);}'
		+ '#' + MODAL_ID + ' .mmxdwf-hname{font-weight:600;color:var(--wf-strong);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px;}'
		+ '#' + MODAL_ID + ' .mmxdwf-hid{color:var(--wf-muted);font-size:11px;}'
		+ '#' + MODAL_ID + ' .mmxdwf-hmeta{margin-left:auto;color:var(--wf-muted);font-size:11px;white-space:nowrap;}'
		+ '#' + MODAL_ID + ' .mmxdwf-hcalls{padding:4px 12px 10px;font-size:11.5px;color:var(--wf-muted);}'
		+ '#' + MODAL_ID + ' .mmxdwf-hbtn{font-size:11px;border:1px solid var(--wf-border);background:var(--wf-subtle);color:var(--wf-text);border-radius:8px;padding:3px 9px;cursor:pointer;flex:none;}'
		+ '#' + MODAL_ID + ' .mmxdwf-hbtn:hover{color:var(--wf-strong);border-color:rgba(255,255,255,.22);}'
		+ '#' + MODAL_ID + ' .mmxdwf-hbtn:disabled{opacity:.5;cursor:default;}'
		+ '[data-mmxdwf-card] .mmxdwf-offline{display:flex;gap:8px;align-items:center;background:rgba(255,113,105,.08);border:1px solid rgba(255,113,105,.35);border-radius:10px;padding:8px 12px;margin:2px 2px 12px;font-size:12px;color:var(--wf-failure);flex-wrap:wrap;}'
		+ '[data-mmxdwf-banner] .mmxdwf-offline{display:flex;gap:8px;align-items:center;background:rgba(255,113,105,.08);border:1px solid rgba(255,113,105,.35);border-radius:10px;padding:8px 12px;margin:2px 2px 12px;font-size:12px;color:var(--wf-failure);flex-wrap:wrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-unbound{display:inline-flex;align-items:center;margin-left:8px;font-size:10.5px;color:var(--wf-muted);border:1px dashed var(--wf-border);border-radius:999px;padding:1px 8px;white-space:nowrap;}'
		+ '[data-mmxdwf-card] .mmxdwf-notice{color:var(--wf-accent);font-size:12px;margin-top:8px;}'
		+ '[data-mmxdwf-banner] .mmxdwf-notice{color:var(--wf-accent);font-size:12px;margin-top:2px;}'
		+ '[data-mmxdwf-card] .mmxdwf-foot{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;}';

	// The banner container is a direct child of the card HOST, which carries no
	// [data-mmxdwf-card] attribute of its own — it wraps N cards and must not inherit the card
	// box. Without its own scope the theme variables and the notice/button rules below never
	// match, and the P0-3 global-history entry renders as unstyled default browser controls.
	CSS += '[data-mmxdwf-card],[data-mmxdwf-banner],#' + MODAL_ID + ',[data-' + NS + '-global-entry]{--wf-text:#d7d9de;--wf-strong:#eceef2;--wf-muted:#a0a4af;--wf-surface:#1a1b20;--wf-subtle:rgba(255,255,255,.035);--wf-border:rgba(255,255,255,.10);--wf-inset:rgba(0,0,0,.22);--wf-ask:#ffce8a;--wf-success:#3fca68;--wf-failure:#ff7169;--wf-accent:#ffb13d;}'
		+ '[data-mmxdwf-theme="light"] [data-mmxdwf-card],[data-mmxdwf-theme="light"] [data-mmxdwf-banner],[data-mmxdwf-theme="light"] #' + MODAL_ID + ',[data-mmxdwf-theme="light"] [data-' + NS + '-global-entry]{--wf-text:#343944;--wf-strong:#20242d;--wf-muted:#596273;--wf-surface:#ffffff;--wf-subtle:#f6f7f9;--wf-border:#dce1e8;--wf-inset:#f0f2f5;--wf-ask:#855100;--wf-success:#21783e;--wf-failure:#ba3029;--wf-accent:#956000;}'
		+ '[data-mmxdwf-theme="light"] [data-mmxdwf-card]{box-shadow:0 2px 8px rgba(25,35,50,.07);}'
		// F03: the home/unknown global-history entry is fixed to its own corner and scoped to
		// its own attribute — it never borrows the card box and never widens into a host
		// selector, so it cannot restyle anything the host owns.
		+ '[data-' + NS + '-global-entry]{position:fixed;right:18px;bottom:18px;z-index:99980;font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;}'
		+ '[data-' + NS + '-global-entry] .' + NS + '-gbtn{display:inline-flex;align-items:center;gap:6px;background:var(--wf-surface);color:var(--wf-text);border:1px solid var(--wf-border);border-radius:999px;padding:7px 14px;font:inherit;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.28);}'
		+ '[data-' + NS + '-global-entry] .' + NS + '-gbtn:hover{color:var(--wf-strong);border-color:rgba(255,255,255,.22);}'
		+ '[data-' + NS + '-global-entry] .' + NS + '-gbtn:focus-visible{outline:2px solid var(--wf-accent);outline-offset:2px;}'
		+ '[data-mmxdwf-card] .mmxdwf-qsend{background:#ffb13d;color:#241703;}'
		+ '[data-mmxdwf-card] .mmxdwf-qsend:disabled,[data-mmxdwf-card] .mmxdwf-ico:disabled{opacity:.65;cursor:default;}'
		+ '[data-mmxdwf-card] .mmxdwf-error{color:var(--wf-failure);font-size:12px;overflow-wrap:anywhere;margin-top:8px;}'
		+ '[data-mmxdwf-banner] .mmxdwf-error{color:var(--wf-failure);font-size:12px;overflow-wrap:anywhere;margin-top:8px;}'
		+ '[data-mmxdwf-card] .mmxdwf-stats{white-space:normal;}'
		+ '[data-mmxdwf-card] .mmxdwf-ico:focus-visible,[data-mmxdwf-card] .mmxdwf-pill:focus-visible{outline:2px solid var(--wf-accent);outline-offset:2px;}';
	function syncTheme() {
		var color = getComputedStyle(document.body).backgroundColor;
		var nums = color && color.match(/[\d.]+/g);
		if (!nums || nums.length > 3 && Number(nums[3]) === 0) nums = (getComputedStyle(document.documentElement).backgroundColor || '').match(/[\d.]+/g);
		var light = nums && nums.length >= 3 && !(nums.length > 3 && Number(nums[3]) === 0)
			? Number(nums[0]) * .2126 + Number(nums[1]) * .7152 + Number(nums[2]) * .0722 > 145
			: !window.matchMedia('(prefers-color-scheme: dark)').matches;
		document.documentElement.setAttribute('data-mmxdwf-theme', light ? 'light' : 'dark');
	}

	function ensureStyle() {
		if (document.body) syncTheme();
		if (!document.head) return false; // document-start: no <head> yet, retry after DOMContentLoaded
		if (document.getElementById(STYLE_ID)) return true;
		var style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = CSS;
		document.head.appendChild(style);
		return true;
	}

	// addScriptToEvaluateOnNewDocument runs this bundle at document-start, before <head>/<body>
	// exist. Gate the UI startup on DOM readiness (and re-check on load) so a reload re-injects
	// cleanly instead of throwing on a null document.head.
	function whenDomReady(fn) {
		var ready = false;
		var cancel = function () {
			document.removeEventListener('DOMContentLoaded', run);
			window.removeEventListener('load', run);
		};
		var run = function () {
			if (ready || stopped) return;
			ready = true;
			cancel();
			fn();
		};
		if (document.head && document.body) run();
		else {
			if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
			if (document.readyState !== 'complete') window.addEventListener('load', run, { once: true });
		}
		return cancel;
	}

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function cssEscape(s) {
		return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, function (c) { return '\\' + c; });
	}
	function hue(s) {
		var h = 0; s = String(s || '');
		for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
		return h;
	}
	function isLive(run) {
		return run.status === 'running' || run.status === 'cancelling';
	}
	function runById(id) {
		for (var i = 0; i < runs.length; i++) if (identity(runs[i]) === id) return runs[i];
		return null;
	}
	// A run is resolvable from the polled list, or — while the global-history modal holds its
	// snapshot — from that snapshot. The history rows must survive the poll that drops a
	// finished run out of /runs: resolving them against the live list only made that path dead
	// (the row click resolved to nothing and silently did nothing).
	function historyRunById(id) {
		for (var i = 0; i < historyRuns.length; i++) if (identity(historyRuns[i]) === id) return historyRuns[i];
		return null;
	}
	function resolveRun(id) {
		if (!id) return null;
		return runById(String(id)) || historyRunById(String(id));
	}
	function uniqueRunId(runId) {
		var n = 0;
		for (var i = 0; i < runs.length; i++) if (runs[i].runId === runId) n++;
		return n === 1;
	}
	// Legacy close sets were keyed by bare runId; migrate them only when that runId is
	// unique across roots — an ambiguous id must not dismiss anything.
	function isDismissed(run) {
		var id = identity(run);
		if (dismissed.has(id)) return true;
		if (run.runKey && dismissed.has(run.runId) && uniqueRunId(run.runId)) return true;
		return false;
	}
	function hasVisible(run) {
		var id = identity(run);
		if (visibleRuns.has(id)) return true;
		if (run.runKey && visibleRuns.has(run.runId) && uniqueRunId(run.runId)) return true;
		return false;
	}
	function runQuery(run, extra) {
		return 'run=' + encodeURIComponent(identity(run))
			+ '&startedAt=' + encodeURIComponent(run.startedAt == null ? '' : run.startedAt)
			+ (extra ? '&' + extra : '');
	}
	function fmtClock(ms) {
		try { return new Date(ms).toTimeString().slice(0, 8); } catch (e) { return ''; }
	}
	// URL allow-list: only http/https may become an anchor. This is a protocol check,
	// not an HTML-escape substitute.
	function isSafeUrl(u) {
		var s = String(u || '').trim();
		return /^https?:\/\//i.test(s) && !/[\s"'<>\\]/.test(s);
	}

	// ---------- phase semantics (REPAIR-024 §phase) ----------
	// settled counts finished agents; failed is a subset of settled; rejected is separate.
	// A phase is SUCCESS only when every dispatched agent ended clean; "all settled" is
	// not "success". Zero-agent phases derive completion from later phases or the run's
	// terminal state — except the current phase of a terminated run, which must not
	// masquerade as success.
	function phaseMeta(run, phases, i) {
		var p = phases[i];
		var d = p.dispatched || 0;
		var finished = (p.settled || 0) + (p.rejected || 0);
		var failed = p.failed || 0;
		var rejected = p.rejected || 0;
		var laterActive = false;
		for (var j = i + 1; j < phases.length; j++) if ((phases[j].dispatched || 0) > 0) { laterActive = true; break; }
		var state = '';
		if (d > 0 && finished >= d) {
			if (failed + rejected >= d) state = failed >= rejected ? 'failed' : 'rejected';
			else if (failed + rejected > 0) state = 'partial';
			else state = 'done';
		} else if (d === 0) {
			if (laterActive || run.status === 'completed') state = 'done';
		} else if (p.name === run.currentPhase && (isLive(run) || run.status === 'stale')) {
			state = 'now';
		}
		return { state: state, finished: finished, total: d, failed: failed, rejected: rejected };
	}
	function phaseCountText(m) {
		var base = m.finished + '/' + m.total;
		var extra = [];
		if (m.failed > 0) extra.push('失败' + m.failed);
		if (m.rejected > 0) extra.push('拒绝' + m.rejected);
		return base + (extra.length ? ' · ' + extra.join(' · ') : '');
	}

	// ---------- conversation run cards ----------
	var STATUS_CN = { running: '工作流运行中', cancelling: '工作流取消中', completed: '工作流已完成', failed: '工作流失败', cancelled: '工作流已取消', stale: '工作流已中断' };
	// Horizontal phase columns (reference layout): small dot on top, then phase name and
	// finished/total count, columns joined by a short connector line.
	function phaseColsHtml(run) {
		var phases = run.phases || [];
		if (!phases.length) return '';
		var html = '<div class="mmxdwf-phasecols">';
		for (var i = 0; i < phases.length; i++) {
			var p = phases[i];
			var m = phaseMeta(run, phases, i);
			html += '<div class="mmxdwf-pcol ' + m.state + '"><span class="mmxdwf-pdot"></span><span class="mmxdwf-pname" title="' + esc(p.name) + '">' + esc(p.name) + '</span><span class="mmxdwf-pc">' + esc(phaseCountText(m)) + '</span></div>';
		}
		return html + '</div>';
	}
	var CALL_STATE = { running: '运行中', done: '已完成', failed: '失败', replayed: '重放命中', rejected: '已拒绝', stale: '已中断' };
	function fmtTokens(n) {
		if (!n) return '';
		if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
		return String(n);
	}
	function fmtMs(ms) {
		if (ms == null) return '';
		if (ms < 1000) return ms + 'ms';
		if (ms < 60000) return (ms / 1000).toFixed(1) + '秒';
		var seconds = Math.round(ms / 1000);
		var m = Math.floor(seconds / 60);
		var s = seconds % 60;
		return m + '分' + String(s).padStart(2, '0') + '秒';
	}
	// Compact single-line agent capsules stacked in narrow columns next to the script
	// cell (reference layout) — not a full-width card grid.
	function agentCapsule(c) {
		var live = c.state === 'running';
		var st = live ? '<span class="mmxdwf-spin"></span>' : '<span class="mmxdwf-agst ' + esc(c.state) + '">' + esc(CALL_STATE[c.state] || c.state) + '</span>';
		var av = '<span class="mmxdwf-av2" style="background:hsl(' + hue(c.callId) + ',55%,48%)">' + esc((String(c.label || c.callId || '?').trim().charAt(0)) || '?') + '</span>';
		var tip = (c.label || c.callId) + (c.reason ? ' · ' + c.reason : '') + (c.preview ? ' · ' + c.preview : '');
		return '<div class="mmxdwf-ag" title="' + esc(tip) + '">' + av + '<span class="mmxdwf-lb">' + esc(c.label || c.callId) + '</span>' + st + '</div>';
	}
	function workRowHtml(run) {
		var calls = run.calls || [];
		var show = calls.slice(-24);
		var cols = show.length ? Math.min(3, Math.max(1, Math.ceil(show.length / 8))) : 0;
		var html = '<div class="mmxdwf-workrow">';
		html += '<button class="mmxdwf-scriptcell" data-act="script" title="查看脚本"><span>&gt;_ 脚本</span>' + (isLive(run) ? '<span class="mmxdwf-spin"></span>' : '<span class="mmxdwf-scok">✓</span>') + '</button>';
		for (var c = 0; c < cols; c++) {
			html += '<div class="mmxdwf-agcol">';
			for (var i = c; i < show.length; i += cols) html += agentCapsule(show[i]);
			html += '</div>';
		}
		html += '</div>';
		if (calls.length > show.length) html += '<button class="mmxdwf-more" data-act="agentsfull">…共 ' + calls.length + ' 个子代理，显示最近 ' + show.length + ' 个 · 查看全部</button>';
		return html;
	}
	// ---- card sections: questions / artifacts / logs ----
	// F02: a draft that has NOT been submitted is delegated into the generation-scoped control
	// (controlsFor(run).drafts) and re-applied when the card is re-mounted. The draft is
	// deliberately NOT rendered into the markup: a value attribute would change _workflowMarkup
	// on every keystroke, and sweepCard would then replace the input node on the next poll,
	// dropping focus and the IME composition. Keeping the value in the control preserves the
	// existing "普通刷新保留原节点" behaviour exactly, and only a genuine re-mount (the A->B->A
	// conversation switch) needs the imperative restore below.
	function restoreDrafts(card, run) {
		if (!card) return;
		var state = controlsFor(run);
		if (!state.drafts.size) return;
		card.querySelectorAll('[data-act="qinput"]').forEach(function (input) {
			var qId = input.getAttribute('data-q') || '';
			// An answer record is the more authoritative state for that question (pending,
			// submitted, unconfirmed or rejected) and already carries its own text.
			if (state.answers.has(qId)) return;
			var draft = state.drafts.get(qId);
			if (typeof draft === 'string' && input.value !== draft) input.value = draft;
		});
	}
	function onCardInput(ev) {
		var t = ev.target;
		if (!t || !t.getAttribute || t.getAttribute('data-act') !== 'qinput') return;
		var card = t.closest ? t.closest('[data-mmxdwf-card]') : null;
		if (!card) return;
		var run = runById(card.getAttribute('data-run'));
		if (!run) return;
		// A locked control (pending / submitted / unconfirmed) owns its own text through the
		// answer record; overwriting it here would fight the visible state.
		if (controlsFor(run).answers.has(t.getAttribute('data-q') || '')) return;
		controlsFor(run).drafts.set(t.getAttribute('data-q') || '', t.value == null ? '' : String(t.value));
	}
	function questionsHtml(run) {
		var qs = run.questions || [];
		var waiting = qs.filter(function (q) { return q && q.state === 'waiting' && isLive(run); });
		var answered = qs.filter(function (q) { return q && q.state === 'answered'; }).slice(-2);
		var failed = qs.filter(function (q) { return q && (q.state === 'failed' || q.state === 'waiting' && !isLive(run)); });
		if (!waiting.length && !answered.length && !failed.length) return '';
		var html = '<div class="mmxdwf-qzone">';
		for (var i = 0; i < waiting.length; i++) {
			var q = waiting[i];
			var answer = controlsFor(run).answers.get(q.qId);
			var unconfirmed = answer && answer.status === UNCONFIRMED;
			var busy = answer && (answer.status === 'pending' || answer.status === 'submitted');
			var locked = busy || unconfirmed;   // the input keeps the draft; the button stays locked
			var submitted = answer && answer.status === 'submitted';
			html += '<div class="mmxdwf-q waiting" data-question="' + esc(q.qId) + '"><span class="mmxdwf-qtext">❓ ' + esc(q.question) + '</span>'
				+ '<input class="mmxdwf-qin" data-act="qinput" data-q="' + esc(q.qId) + '" aria-label="' + esc(q.question) + '" value="' + esc(answer && !submitted ? answer.value : '') + '" placeholder="' + (submitted ? '已提交，等待工作流接收…' : unconfirmed ? '结果未确认，草稿已保留…' : '输入回答…') + '"' + (busy ? ' disabled=""' : '') + ' />'
				+ '<button class="mmxdwf-qsend" data-act="answer" data-q="' + esc(q.qId) + '"' + (locked ? ' disabled=""' : '') + '>' + (submitted ? '已提交' : unconfirmed ? '未确认' : busy ? '提交中…' : '回答') + '</button>'
				+ (answer && answer.error ? '<span class="mmxdwf-error" role="alert">' + esc(answer.error) + '</span>' : '') + '</div>';
		}
		failed.forEach(function (q) {
			html += '<div class="mmxdwf-q mmxdwf-error" data-question="' + esc(q.qId) + '">! ' + esc(q.question) + ' · ' + esc(q.error || q.reason || '回答未完成；详细原因见运行结果') + '</div>';
		});
		for (var j = 0; j < answered.length; j++) {
			var a = answered[j];
			html += '<div class="mmxdwf-q answered" data-question="' + esc(a.qId) + '">✔ ' + esc(a.question) + ' → ' + esc(a.answerPreview || '') + '</div>';
		}
		return html + '</div>';
	}
	var KIND_ICON = { file: '📎', document: '📄', dashboard: '📊', text: '📝' };
	// F06: `publish({title, kind:'text', text})` with no path/url is a legal engine call — the
	// body is stored in the journal, mirrored into progress.json's `artifacts[].text` (capped at
	// 4000 UTF-16 chars) and handed to us whole by /runs. Such an artifact used to render as a
	// bare title span (metadata, no way into the body), and the only open path went through
	// /artifact, which the sidecar answers `404 'artifact is not a published file'` for an entry
	// with no path. The body was never lost; there was simply no control that could show it.
	function isInlineTextArtifact(a) {
		return !!a && !a.url && !a.path && typeof a.text === 'string' && a.text.length > 0;
	}
	function artifactsHtml(run) {
		var arts = run.artifacts || [];
		if (!arts.length) return '';
		var html = '<div class="mmxdwf-arts">';
		for (var i = 0; i < arts.length; i++) {
			var a = arts[i];
			var inner = '<span class="mmxdwf-atitle" title="' + esc(a.path || a.url || a.title) + '">' + esc(a.title) + '</span>';
			if (a.url) {
				if (isSafeUrl(a.url)) inner = '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
				else inner += '<span class="mmxdwf-artwarn">（已阻止不安全链接协议）</span>';
			} else if (a.path) {
				// File artifacts are fetched through the authenticated API and served as a
				// Blob URL; the raw path never becomes a link.
				inner = '<button class="mmxdwf-artopen" data-act="artifact" data-index="' + i + '" title="通过 API 安全下载或预览">' + inner + '<span class="mmxdwf-star">⤓</span></button>';
			} else if (isInlineTextArtifact(a)) {
				// Same modal, same `pre` — but the body is already in memory, so this branch
				// never touches the file endpoint. An artifact with neither path/url nor a body
				// keeps its title-only metadata rather than gaining a button that opens nothing.
				inner = '<button class="mmxdwf-artopen" data-act="artifact" data-index="' + i + '" title="查看内联文本正文">' + inner + '<span class="mmxdwf-star">⤓</span></button>';
			}
			html += '<span class="mmxdwf-art' + (a.primary ? ' primary' : '') + '" title="' + esc(a.kind + (a.path ? ' · ' + a.path : '')) + '">'
				+ (a.primary ? '<span class="mmxdwf-star">★</span>' : '') + (KIND_ICON[a.kind] || '📝') + inner + '</span>';
		}
		return html + '</div>';
	}
	var lastLogCount = new Map();
	function logsHtml(run) {
		var logs = run.logs || [];
		if (!logs.length) return '';
		var show = logs.slice(-4);
		var html = '<div class="mmxdwf-logs">';
		for (var i = 0; i < show.length; i++) {
			var fresh = run.status === 'running' && logs.length !== lastLogCount.get(identity(run)) && i === show.length - 1;
			html += '<div class="mmxdwf-logline' + (fresh ? ' fresh' : '') + '">' + esc(show[i].text) + '</div>';
		}
		html += '</div>';
		if (logs.length > show.length) html += '<button class="mmxdwf-more" data-act="logsfull">…共 ' + logs.length + ' 条，显示最近 ' + show.length + ' 条 · 查看全部</button>';
		lastLogCount.set(identity(run), logs.length);
		return html;
	}
	function cardHtml(run) {
		var control = controlsFor(run);
		var running = isLive(run);
		var cur = currentSessionId();
		var bound = bindingOf(run);
		var liveAgents = (run.calls || []).filter(function (c) { return c.state === 'running'; }).length;
		var endedAgents = Number.isFinite(run.settled) ? run.settled : (run.calls || []).filter(function (c) { return c.state === 'done' || c.state === 'failed' || c.state === 'replayed'; }).length;
		var stats = (run.phases || []).length + ' 个阶段 · ' + (running ? liveAgents : endedAgents) + ' 个子代理' + (running ? '工作中' : '已结束');
		var started = Date.parse(run.startedAt);
		var elapsed = running && Number.isFinite(started) ? Math.max(run.elapsedMs || 0, Date.now() - started) : run.elapsedMs;
		if (elapsed != null) stats += ' · ' + fmtMs(elapsed);
		if (run.tokens && ((run.tokens.input || 0) + (run.tokens.output || 0)) > 0) stats += ' · ' + fmtTokens((run.tokens.input || 0) + (run.tokens.output || 0)) + ' tokens';
		var result = '';
		if (!running && run.resultPreview) {
			result = '<div class="mmxdwf-result" data-act="resultopen" title="点击查看完整结果">' + esc(run.resultPreview) + '</div>';
		}
		var resumable = run.status === 'failed' || run.status === 'cancelled' || run.status === 'stale';
		return '<div data-mmxdwf-card="1" data-run="' + esc(identity(run)) + '">'
			+ '<div class="mmxdwf-head"><span class="mmxdwf-title"><span class="mmxdwf-gear">' + (running ? '⚙' : run.status === 'completed' ? '✓' : '!') + '</span>' + esc(STATUS_CN[run.status] || run.status) + '</span>'
			+ '<span class="mmxdwf-runname">' + esc(run.name || run.runId) + '</span>'
			+ (bound ? '' : '<span class="mmxdwf-unbound" title="未绑定到任何会话；绑定当前会话后归入会话视图">未绑定</span>')
			+ '<span class="mmxdwf-stats">' + (running ? '<span class="mmxdwf-live-dot"></span>' : '') + esc(stats) + '</span>'
			+ '<span class="mmxdwf-icos">'
			+ (running ? '<button class="mmxdwf-ico" data-act="stop" title="' + (control.stop === UNCONFIRMED ? '停止结果未确认，不会自动重发' : control.stop ? '停止请求已发送' : '停止工作流') + '"' + (control.stop ? ' disabled=""' : '') + '>' + (control.stop ? '…' : '⏹') + '</button>' : '<button class="mmxdwf-ico mmxdwf-close" data-act="close" title="关闭卡片（保留运行数据）">×</button>')
			+ (resumable ? '<button class="mmxdwf-ico mmxdwf-resume" data-act="resume" title="恢复运行"' + (control.resume ? ' disabled=""' : '') + '>' + (control.resume ? '…' : '↻') + '</button>' : '')
			+ '<button class="mmxdwf-ico" data-act="expand" title="展开/收起">⤢</button>'
			+ '</span></div>'
			+ (control.error ? '<div class="mmxdwf-error" role="alert">' + esc(control.error) + '</div>' : '')
			+ (control.stop === 'requested' ? '<div class="mmxdwf-notice" role="status">已发送停止请求，等待工作流确认…</div>' : '')
			+ (control.stop === UNCONFIRMED ? '<div class="mmxdwf-notice" role="status">停止结果未确认：不会自动重发，工作流若已停止会自行更新状态。</div>' : '')
			+ (control.resume === UNCONFIRMED ? '<div class="mmxdwf-notice" role="status">恢复结果未确认：恢复进程可能已启动，不会自动重发。</div>' : '')
			+ questionsHtml(run) + phaseColsHtml(run) + workRowHtml(run) + artifactsHtml(run) + logsHtml(run) + result
			+ '<div class="mmxdwf-foot">'
			+ '<button class="mmxdwf-pill" data-act="board">📋 发现看板（按严重度）</button>'
			+ '<button class="mmxdwf-pill" data-act="result">📄 结果</button>'
			+ '<button class="mmxdwf-pill" data-act="history">🗂 历史</button>'
			+ (cur && !bound ? '<button class="mmxdwf-pill" data-act="bind" title="把该运行绑定到当前会话">🔗 绑定当前会话</button>' : '')
			+ (!cur && !bound ? '<span class="mmxdwf-unbound" title="宿主未报告当前会话，无法归属到任何会话；不会猜测会话身份">🔗 无法归属</span>' : '')
			+ '</div>'
			+ '</div>';
	}
	// Session view: cards bound to the current session plus unbound live/already-watched
	// runs (so they can be bound and stay until closed); unbound finished runs that were
	// never watched live in the global history only. Without a verifiable current session
	// the fallback is attribution-safe: only unbound runs the user is already watching —
	// never other sessions' runs and never an auto-introduced "newest finished" card
	// (024-R4: the old global fallback put finished cards on the new-conversation page).
	// v8: binding no longer deletes the card. When the host reports no current session at all
	// (neither sessionStorage nor the marker) the strict "cur must match" rule made every bound
	// run vanish from the conversation view the moment it was bound — the user lost the card
	// they had just acted on. A manual binding is a deliberate action on a run the user can
	// see, so a mmx-host binding keeps the card in view; the cur-match rule still narrows the
	// pool whenever the host does report a current session.
	function sessionPool() {
		var cur = currentSessionId();
		return runs.filter(function (r) {
			var b = bindingOf(r);
			if (b) return cur ? (b.host === 'mmx' && b.sessionId === cur) : b.host === 'mmx' && !b.native;
			return isLive(r) || hasVisible(r);
		});
	}
	function sortPicked(list) {
		return list.slice().sort(function (a, b) {
			var la = isLive(a) ? 0 : 1, lb = isLive(b) ? 0 : 1;
			if (la !== lb) return la - lb;
			return String(b.startedAt || b.updatedAt || '').localeCompare(String(a.startedAt || a.updatedAt || ''));
		});
	}
	function pickCardRuns() {
		var pool = sessionPool();
		var before = visibleRuns.size;
		var picked = [];
		for (var i = 0; i < pool.length; i++) {
			var r = pool[i];
			if (isDismissed(r)) { visibleRuns.delete(identity(r)); continue; }
			visibleRuns.add(identity(r));
			picked.push(r);
		}
		if (visibleRuns.size !== before) saveVisible();
		return sortPicked(picked);
	}
	function syncSections(parent, fresh) {
		var keep = [];
		Array.from(fresh.children).forEach(function (next) {
			var key = next.getAttribute('data-question') || next.className;
			var old = Array.from(parent.children).find(function (el) { return (el.getAttribute('data-question') || el.className) === key; });
			if (old && old.innerHTML === next.innerHTML) { keep.push(old); return; }
			if (old && old.classList.contains('mmxdwf-qzone')) {
				syncSections(old, next); keep.push(old); return;
			}
			if (old) { parent.insertBefore(next, old); old.remove(); }
			else parent.appendChild(next);
			keep.push(next);
		});
		Array.from(parent.children).forEach(function (el) { if (keep.indexOf(el) < 0) el.remove(); });
		keep.forEach(function (el, i) { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
	}
	// 024-R4 three-state route machine (live-measured, MMX-310-SESSION-MARKERS.md): the
	// conversation route and the home route are mutually exclusive; anything else is an
	// unknown route. Conversation cards exist on the conversation route only.
	function viewState() {
		var list = document.querySelector(CONVERSATION_SEL);
		if (list) return 'conversation';
		if (document.querySelector(HOME_SEL)) return 'home';
		return 'unknown';
	}
	function findAnchor() {
		var anchor = null;
		var areas = document.querySelectorAll(CONVERSATION_SEL);
		for (var j = 0; j < areas.length; j++) {
			if (!anchor || areas[j].clientHeight > anchor.clientHeight) anchor = areas[j];
		}
		return anchor;
	}
	function claimAnchor(anchor) {
		if (cardAnchor === anchor) return;
		if (getComputedStyle(anchor).position === 'static') {
			if (anchor._mmxDwfPosSaved === undefined) anchor._mmxDwfPosSaved = anchor.style.position || '';
			anchor.style.position = 'relative';
		}
		cardAnchor = anchor;
	}
	function restoreAnchor() {
		if (cardAnchor && cardAnchor._mmxDwfPosSaved !== undefined) {
			cardAnchor.style.position = cardAnchor._mmxDwfPosSaved;
			delete cardAnchor._mmxDwfPosSaved;
		}
		cardAnchor = null;
	}
	function bannersHtml(pickCount) {
		var html = '';
		if (offline) {
			html += '<div class="mmxdwf-offline" role="alert">⚠ 连接中断'
				+ (lastHttpError ? ' · ' + esc(lastHttpError) : '')
				+ (lastSyncAt ? ' · 最后同步 ' + esc(fmtClock(lastSyncAt)) : '')
				+ ' · 以下信息可能已过期，恢复连接后自动刷新</div>';
		}
		if (persistWarning) html += '<div class="mmxdwf-error" role="alert">' + esc(persistWarning) + '</div>';
		var cur = currentSessionId();
			// v8: the notice must not require a current session. It is the only global-history
			// entry besides the card pill, and gating it on cur made it unreachable whenever no
			// card was on screen — finished runs that were never watched live then had no
			// surface at all.
			if (runs.length && pickCount === 0) html += '<div class="mmxdwf-notice" role="status">' + (cur ? '当前会话暂无绑定的运行 · ' : '暂无正在展示的运行 · ') + '<button class="mmxdwf-more" data-act="history">打开全局历史绑定…</button></div>';
			return html;
	}
	// F03: the home/unknown routes legitimately carry no conversation card — but removing
	// CARD_ID also removed the ONLY thing that carried a global-history entry, so a first-time
	// user on the home page (or an unknown route) had no way into the global list at all
	// (`historyEntries=0, modalVisible=false`), and it never depended on a current session.
	// This is a fixed-position, one-button surface of its own: it does NOT reuse or depend on
	// CARD_ID, it does not need a current session, and it opens the SAME history modal through
	// the SAME openHistory() path. It never renders a run card, so the home guard (no finished
	// run is auto-mounted) is untouched; and because it lives outside the modal, closing the
	// modal leaves the entry on screen and the list is one click away again.
	function globalEntryHtml() {
		return '<div class="' + NS + '-gentry"><button class="' + NS + '-gbtn" data-act="history" title="打开全局工作流历史（全部运行）">🗂 工作流历史</button></div>';
	}
	function mountGlobalEntry() {
		var el = document.getElementById(ENTRY_ID);
		// Idempotent on purpose. sweepCard calls this on every 2s poll, and an unconditional
		// innerHTML rebuild replaces the button node each time — which silently breaks the F07
		// focus restore: closeModal focuses whatever had focus before the dialog, and by then
		// that opener is a detached node, so the restore is a no-op and focus lands on <body>.
		// An entry that is already present AND still carries its control is left untouched; a
		// stripped or half-built one is still repaired.
		if (el && el.querySelector('[data-act="history"]')) return el;
		if (el) { el.innerHTML = globalEntryHtml(); return el; }
		el = document.createElement('div');
		el.id = ENTRY_ID;
		el.setAttribute('data-' + NS + '-global-entry', '1');
		el.innerHTML = globalEntryHtml();
		// The card host's own delegated listener owns every [data-act] inside it; this entry
		// lives outside that host, so it needs its own one (a second handler on the card host
		// would be an unreachable duplicate).
		el.addEventListener('click', function (ev) {
			var t = ev.target && ev.target.closest ? ev.target.closest('[data-act="history"]') : null;
			if (t) openHistory();
		});
		(document.body || document.documentElement).appendChild(el);
		return el;
	}
	function unmountGlobalEntry() {
		var el = document.getElementById(ENTRY_ID);
		if (el) el.remove();
	}
	function sweepCard() {
		var host = document.getElementById(CARD_ID);
		if (viewState() !== 'conversation') {
			// Home (new conversation) and unknown routes never carry conversation cards; the
			// global history entry and its modal remain the surfaces there.
			if (host) host.remove();
			restoreAnchor();
			// F03: the card host is gone here, so the global-history entry needs a home of its
			// own. It is one button, carries no run record, and never resurrects a card.
			mountGlobalEntry();
			return;
		}
		unmountGlobalEntry();
		if (cardAnchor && !cardAnchor.isConnected) restoreAnchor();
		var pick = pickCardRuns();
		if (!pick.length && !offline && !persistWarning && !runs.length) {
			if (host) host.remove();
			restoreAnchor();
			return;
		}
		var anchor = findAnchor();
		if (!anchor) return;
		claimAnchor(anchor);
		if (!host) {
			host = document.createElement('div');
			host.id = CARD_ID;
			host.addEventListener('click', onCardClick);
			// F02: the draft delegation rides the same host as the click delegation, so a
			// re-mounted card starts recovering immediately.
			host.addEventListener('input', onCardInput);
		}
		if (host.parentNode !== anchor) anchor.insertBefore(host, anchor.firstChild);
		var oldBanner = host.querySelector('[data-mmxdwf-banner]');
		if (oldBanner) oldBanner.remove();
		var banners = bannersHtml(pick.length);
		if (banners) host.insertAdjacentHTML('beforeend', '<div data-mmxdwf-banner="1">' + banners + '</div>');
		var current = new Map();
		Array.from(host.children).forEach(function (card) { if (card.getAttribute && card.getAttribute('data-run')) current.set(card.getAttribute('data-run'), card); });
		pick.forEach(function (run) {
			var id = identity(run);
			var html = cardHtml(run);
			var card = current.get(id);
			if (!card || card._workflowMarkup !== html) {
				var temp = document.createElement('div'); temp.innerHTML = html;
				var fresh = temp.firstChild;
				if (!card) { card = fresh; host.appendChild(card); }
				else syncSections(card, fresh);
				card._workflowMarkup = html;
			}
			// F02: runs after the markup decision on purpose — a re-mount (this card was just
			// created, or its question row was replaced by syncSections) is exactly the case the
			// delegated draft cannot survive on its own. A card that was merely left alone is
			// untouched, so the existing input identity / focus / selection behaviour stands.
			restoreDrafts(card, run);
			current.delete(id);
		});
		current.forEach(function (card) { card.remove(); });
		// Deterministic order: banner first, then pick order (live first, newest started).
		var ref = null;
		var banner = host.querySelector('[data-mmxdwf-banner]');
		if (banner && host.firstChild !== banner) host.insertBefore(banner, host.firstChild);
		ref = banner;
		pick.forEach(function (run) {
			var el = host.querySelector('[data-run="' + cssEscape(identity(run)) + '"]');
			if (!el) return;
			if (ref ? ref.nextSibling !== el : host.firstChild !== el) host.insertBefore(el, ref ? ref.nextSibling : host.firstChild);
			ref = el;
		});
	}
	function onCardClick(ev) {
		var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
		if (!t) return;
		var card = t.closest('[data-mmxdwf-card]');
		var run = card ? runById(card.getAttribute('data-run')) : null;
		var act = t.getAttribute('data-act');
		if (act === 'expand') { card.classList.toggle('mmxdwf-full'); return; }
		if (act === 'close') {
			var id = card.getAttribute('data-run');
			dismissed.add(id);
			saveDismissed(dismissed);
			visibleRuns.delete(id); saveVisible();
			card.remove();
			return;
		}
		if (act === 'bind') {
			// Fail-closed, in the F01 spirit: the host reports no verifiable current session, so
			// there is no identity to attribute to and nothing is written. The card renders a
			// non-interactive hint instead of a control that could only do nothing.
			if (!run) return;
			var cur = currentSessionId();
			if (!cur) return;
			bindRunToSession(run, cur, 'mmx-oneclick');
			return;
		}
		if (act === 'answer') {
			if (!run) return;
			var state = controlsFor(run), qId = t.getAttribute('data-q');
			var previous = state.answers.get(qId);
			// An unconfirmed answer is locked too: it may already be on the far end, so a second
			// click is not a retry but a possible duplicate. reconcileUnconfirmed() releases it
			// once /runs can confirm what actually happened to that qId.
			if (previous && (previous.status === 'pending' || previous.status === 'submitted' || previous.status === UNCONFIRMED)) return;
			var input = card.querySelector('.mmxdwf-qin[data-q="' + cssEscape(qId) + '"]');
			var val = input ? input.value.trim() : '';
			if (!val) { if (input) input.focus(); return; }
			var answer = { status: 'pending', value: input.value, error: '' };
			state.answers.set(qId, answer);
			sweepCard();
			var aid = identity(run);
			apiBounded('/answer?' + runQuery(run, 'q=' + encodeURIComponent(qId)), {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: val }),
			}, REQUEST_DEADLINE_MS)
				.then(function (x) {
					if (stopped) return;
					var latest = runById(aid);
					if (!latest || controlsFor(latest) !== state) return; // lifecycle changed meanwhile
					// An unreadable body is the unknown case, not a refusal: the answer may have
					// landed. Keep the draft in the control and never resend it ourselves.
					var verdict = mutationVerdict(x);
					answer.status = verdict === 'accepted' ? 'submitted' : verdict;
					answer.error = verdict === 'accepted' ? '' : receiptError(verdict, x.b, x.r, '提交');
					sweepCard();
				})
				.catch(function (e) {
					if (stopped) return;
					var latest = runById(aid);
					if (!latest || controlsFor(latest) !== state) return;
					// A dead socket is not evidence that nothing was applied: it is only evidence
					// that we did not learn the outcome.
					answer.status = UNCONFIRMED;
					answer.error = UNCONFIRMED_TEXT + '（' + String(e && e.message || e) + '）';
					sweepCard();
				});
			return;
		}
		if (act === 'resume') {
			if (!run) return;
			var control = controlsFor(run);
			if (control.resume) return;
			control.resume = 'pending'; control.error = ''; sweepCard();
			var rid = identity(run);
			apiBounded('/resume?' + runQuery(run), { method: 'POST' }, REQUEST_DEADLINE_MS)
				.then(function (x) {
					if (stopped) return;
					var latest = runById(rid);
					if (!latest || controlsFor(latest) !== control) return;
					var verdict = mutationVerdict(x, 'accepted');
					control.resume = verdict === 'accepted' ? 'cooldown' : verdict;
					control.error = verdict === 'rejected' ? receiptError(verdict, x.b, x.r, '恢复') : (verdict === 'accepted' ? '' : UNCONFIRMED_TEXT);
					sweepCard();
					// The cooldown expires only a CONFIRMED resume. An unconfirmed one is not on a
					// timer at all: expiring it would re-arm a second POST for a spawn that may
					// already be running.
					if (verdict === 'accepted') setTimeout(function () { control.resume = ''; if (!stopped) sweepCard(); }, 3000);
				})
				.catch(function (e) {
					if (stopped) return;
					var latest = runById(rid);
					if (!latest || controlsFor(latest) !== control) return;
					control.resume = UNCONFIRMED; control.error = UNCONFIRMED_TEXT + '（' + String(e && e.message || e) + '）'; sweepCard();
				});
			return;
		}
		if (act === 'history') { openHistory(); return; }
		if (!run) return;
		if (act === 'stop') {
			if (!isLive(run)) return;
			var st = controlsFor(run);
			if (st.stop) return; // single submit
			st.stop = 'pending'; st.error = ''; sweepCard();
			var sid = identity(run);
			apiBounded('/stop?' + runQuery(run), { method: 'POST' }, REQUEST_DEADLINE_MS)
				.then(function (x) {
					if (stopped) return;
					var latest = runById(sid);
					if (!latest || controlsFor(latest) !== st) return;
					var verdict = mutationVerdict(x);
					if (verdict === 'accepted') { st.stop = 'requested'; st.error = ''; }
					else { st.stop = verdict === 'rejected' ? '' : UNCONFIRMED; st.error = receiptError(verdict, x.b, x.r, '停止'); }
					sweepCard();
				})
				.catch(function (e) {
					if (stopped) return;
					var latest = runById(sid);
					if (!latest || controlsFor(latest) !== st) return;
					st.stop = UNCONFIRMED; st.error = UNCONFIRMED_TEXT + '（' + String(e && e.message || e) + '）'; sweepCard();
				});
			return;
		}
		if (act === 'script') { openScript(run); return; }
		if (act === 'board') { openBoard(run); return; }
		if (act === 'result' || act === 'resultopen') { openResult(run); return; }
				if (act === 'agentsfull') { openAgentsFull(run); return; }
		if (act === 'logsfull') { openLogsFull(run); return; }
		if (act === 'artifact') { openArtifact(run, t.getAttribute('data-index')); return; }
	}

	// ---------- modals: script + findings board + result + history + full lists ----------
	var mEl = null, mTitle = null, mBody = null;
	var modalGen = 0;
	var modalView = null;
	// F07: the keyboard closure. The overlay is a real isolation (position:fixed; inset:0 over
	// the whole viewport, its own stacking layer, plus the Tab trap below), so aria-modal is a
	// claim this element can actually keep — it is set when focus is INSIDE the dialog and
	// dropped the moment the dialog closes, never asserted on a merely-open element.
	// Focus is returned to whatever had it before, because a dialog that hides itself and drops
	// focus on <body> restarts the user's Tab traversal from the top of the page.
	var modalReturnFocus = null;
	function withinModal(node) {
		for (var e = node; e; e = e.parentNode) if (e === mEl) return true;
		return false;
	}
	function modalFocusables() {
		if (!mEl) return [];
		return Array.prototype.slice.call(mEl.querySelectorAll('a,button,input,select,textarea,[tabindex]'))
			.filter(function (el) { return !el.disabled && el.getAttribute('tabindex') !== '-1'; });
	}
	function focusModal() {
		if (!mEl) return;
		var items = modalFocusables();
		var target = mEl.querySelector('.mmxdwf-mclose') || items[0] || mEl;
		if (target === mEl) mEl.setAttribute('tabindex', '-1');
		try { target.focus(); } catch (e) {}
		if (mEl.style.display === 'flex' && withinModal(document.activeElement)) mEl.setAttribute('aria-modal', 'true');
		else mEl.removeAttribute('aria-modal');
	}
	function onModalKey(ev) {
		if (!mEl || mEl.style.display !== 'flex') return;
		var k = ev && ev.key;
		if (k === 'Escape' || k === 'Esc') {
			if (ev.preventDefault) ev.preventDefault();
			closeModal();
			return;
		}
		if (k !== 'Tab') return;   // typing and arrows stay the host's business
		var items = modalFocusables();
		if (!items.length) { if (ev.preventDefault) ev.preventDefault(); return; }
		var active = document.activeElement;
		var at = items.indexOf(active);
		// The trap owns the two edges only: a Tab in the middle is the browser's own.
		if (ev.shiftKey) {
			if (at <= 0) { if (ev.preventDefault) ev.preventDefault(); try { items[items.length - 1].focus(); } catch (e) {} }
		} else if (at < 0 || at === items.length - 1) {
			if (ev.preventDefault) ev.preventDefault();
			try { items[0].focus(); } catch (e) {}
		}
	}
	function ensureModal() {
		if (mEl && document.getElementById(MODAL_ID) === mEl) { mEl.style.display = 'flex'; focusModal(); return; }
		if (!modalReturnFocus && document.activeElement) modalReturnFocus = document.activeElement;
		mEl = document.createElement('div');
		mEl.id = MODAL_ID;
		mEl.style.display = 'flex';
		mEl.setAttribute('role', 'dialog');
		mEl.setAttribute('aria-label', '工作流详情');
		mEl.innerHTML = '<div class="mmxdwf-mbox"><div class="mmxdwf-mhead"><span id="mmxdwf-mtitle"></span><button class="mmxdwf-mclose" data-act="mclose">×</button></div><div class="mmxdwf-mbody"></div></div>';
		document.body.appendChild(mEl);
		mTitle = mEl.querySelector('#mmxdwf-mtitle');
		mBody = mEl.querySelector('.mmxdwf-mbody');
		mEl.addEventListener('keydown', onModalKey);
		mEl.addEventListener('click', function (ev) {
			var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
			var act = t ? t.getAttribute('data-act') : '';
			if (act === 'bindcurrent' || act === 'unbindcurrent') {
				var id = t.getAttribute('data-hrun');
				var r = resolveRun(id);
				if (act === 'bindcurrent') {
					var cur = currentSessionId();
					if (cur && r) bindRunToSession(r, cur, 'mmx-oneclick');
				} else if (r) unbindRun(r);
				if (mEl && mEl.style.display === 'flex') renderHistory();
				return;
			}
			if (ev.target === mEl || act === 'mclose') closeModal();
		});
		focusModal();
	}
	// Closing the modal also drops the global-history snapshot: the history rows resolve runs
	// through it, and a stale copy kept resolving runs that have since left /runs (and stayed
	// resident for the rest of the session).
	function closeModal() {
		if (mEl) mEl.style.display = 'none';
		if (mEl) mEl.removeAttribute('aria-modal');
		revokeModalBlobs();
		// F07: hand focus back to the control that opened the dialog.
		var back = modalReturnFocus;
		modalReturnFocus = null;
		if (back) { try { if (back.focus) back.focus(); } catch (e) {} }
		historyRuns = [];
	}
	// Every modal open records (generation, view type, run identity); a late response is
	// applied only when the modal still shows the same view of the same run.
	function beginView(type, id) {
		ensureModal();
		revokeModalBlobs();
		modalGen++;
		var run = id == null ? null : resolveRun(id);
		modalView = { gen: modalGen, type: type, id: id == null ? null : String(id), startedAt: run ? String(run.startedAt || '') : null };
		return modalView;
	}
	function invalidateModalLifecycle() {
		if (!modalView || modalView.id === null) return;
		var run = resolveRun(modalView.id);
		if (run && String(run.startedAt || '') === modalView.startedAt) return;
		modalView = null;
		revokeModalBlobs();
		if (mBody) mBody.textContent = '运行生命周期已变化或记录已移除，请重新打开详情。';
	}
	function viewCurrent(view, type, id) {
		invalidateModalLifecycle();
		return !stopped && view && modalView === view && view.type === type && view.id === (id == null ? null : String(id))
			&& mEl && mEl.style.display === 'flex' && document.getElementById(MODAL_ID) === mEl;
	}
	function trackBlobUrl(url) { activeBlobUrls.push(url); return url; }
	function revokeModalBlobs() {
		activeBlobUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
		activeBlobUrls.length = 0;
	}
	function showTextPreview(pre, text, limit, name) {
		text = String(text == null ? '(无结果)' : text);
		pre.textContent = text.length > limit ? text.slice(0, limit) + '\n…（已截断：显示前 ' + limit + ' 个 UTF-16 字符，共 ' + text.length + ' 个）' : text;
		if (text.length <= limit) return;
		var link = document.createElement('a');
		link.href = trackBlobUrl(URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })));
		link.download = name;
		link.className = 'mmxdwf-hbtn';
		link.textContent = '下载完整文本';
		mBody.appendChild(link);
	}
	function openScript(run) {
		var rid = identity(run);
		var view = beginView('script', rid);
		mTitle.textContent = '脚本 · ' + (run.name || rid);
		mBody.innerHTML = '';
		var pre = document.createElement('pre');
		pre.className = 'mmxdwf-code';
		pre.textContent = '加载中…';
		mBody.appendChild(pre);
		var cacheKey = rid + ':' + String(run.startedAt || '');
		if (scriptCache[cacheKey]) { pre.textContent = scriptCache[cacheKey]; return; }
		apiFetch('/script?' + runQuery(run))
			.then(apiJson)
			.then(function (b) {
				if (!viewCurrent(view, 'script', rid)) return;
				if (b && b.ok) {
					if (b.scriptPath) {
						var p = document.createElement('div');
						p.className = 'mmxdwf-stats';
						p.style.marginBottom = '6px';
						p.textContent = b.scriptPath;
						mBody.insertBefore(p, pre);
					}
					scriptCache[cacheKey] = b.script || '(空脚本)';
					pre.textContent = scriptCache[cacheKey];
				} else {
					pre.textContent = '读取失败: ' + ((b && b.error) || 'unknown');
				}
			})
			.catch(function (e) { if (!viewCurrent(view, 'script', rid)) return; pre.textContent = '读取失败: ' + e; });
	}
	function extractFindings(out) {
		var r = out && out.result;
		var arr = null;
		if (Array.isArray(r)) arr = r;
		else if (r && Array.isArray(r.findings)) arr = r.findings;
		else if (typeof r === 'string') {
			try {
				var j = JSON.parse(r);
				if (Array.isArray(j)) arr = j;
				else if (j && Array.isArray(j.findings)) arr = j.findings;
			} catch (e) {}
		}
		if (!arr) return null;
		arr = arr.filter(function (x) { return x && typeof x === 'object' && (x.title || x.summary); });
		return arr.length ? arr : null;
	}
	var SEV_ORDER = ['P0', 'P1', 'P2', 'P3', 'HIGH', 'MEDIUM', 'LOW'];
	function openBoard(run) {
		var rid = identity(run);
		var view = beginView('board', rid);
		mTitle.textContent = '发现看板（按严重度） · ' + (run.name || rid);
		mBody.innerHTML = '<div class="mmxdwf-stats">加载中…</div>';
		apiFetch('/result?' + runQuery(run))
			.then(apiJson)
			.then(function (b) {
				if (!viewCurrent(view, 'board', rid)) return;
				mBody.innerHTML = '';
				if (!b || !b.ok) {
					mBody.innerHTML = '<div class="mmxdwf-stats">暂无结果：' + esc((b && b.error) || 'run 未结束') + '</div>';
					return;
				}
				var fs = extractFindings(b.out);
				if (!fs) {
					mBody.innerHTML = '<div class="mmxdwf-stats">结果不是结构化发现（无 findings 数组），原文：</div>';
					var pre = document.createElement('pre');
					pre.className = 'mmxdwf-code';
					showTextPreview(pre, JSON.stringify(b.out && b.out.result, null, 2), 8000, 'workflow-findings.txt');
					mBody.appendChild(pre);
					return;
				}
				var groups = {};
				fs.forEach(function (f) {
					var s = String(f.severity || f.level || '其它').toUpperCase();
					(groups[s] = groups[s] || []).push(f);
				});
				var appendSev = function (s, items) {
					var h = document.createElement('div');
					h.className = 'mmxdwf-sev ' + s;
					h.textContent = s + ' · ' + items.length + ' 项';
					mBody.appendChild(h);
					items.forEach(function (f) {
						var d = document.createElement('div');
						d.className = 'mmxdwf-fitem';
						var t = document.createElement('div');
						t.className = 'mmxdwf-ftitle';
						t.textContent = f.title || f.summary || '';
						var x = document.createElement('div');
						x.className = 'mmxdwf-fdetail';
						x.textContent = f.detail || f.description || f.evidence || '';
						d.appendChild(t);
						d.appendChild(x);
						mBody.appendChild(d);
					});
				};
				SEV_ORDER.forEach(function (s) { if (groups[s]) { appendSev(s, groups[s]); delete groups[s]; } });
				Object.keys(groups).forEach(function (s) { appendSev(s, groups[s]); });
			})
			.catch(function (e) { if (!viewCurrent(view, 'board', rid)) return; mBody.innerHTML = '<div class="mmxdwf-stats">读取失败: ' + esc(String(e)) + '</div>'; });
	}

	// ---- full-result modal ----
	function openResult(run) {
		var rid = identity(run);
		var view = beginView('result', rid);
		mTitle.textContent = '结果 · ' + (run.name || rid);
		mBody.innerHTML = '<div class="mmxdwf-stats">加载中…</div>';
		apiFetch('/result?' + runQuery(run))
			.then(apiJson)
			.then(function (b) {
				if (!viewCurrent(view, 'result', rid)) return;
				mBody.innerHTML = '';
				var pre = document.createElement('pre');
				pre.className = 'mmxdwf-code';
				if (!b || !b.ok) {
					pre.textContent = '暂无结果：' + ((b && b.error) || 'run 未结束');
				} else {
					var out = b.out;
					var text = out && out.error !== undefined ? 'error: ' + String(out.error)
						: out && out.result !== undefined ? JSON.stringify(out.result, null, 2) : '(无 result 字段)';
					showTextPreview(pre, text, 65536, 'workflow-result.txt');
					// F04: a successful manual full read is authoritative for the CURRENT
					// lifecycle key, so it backfills the card instead of leaving a transient
					// backoff (or a stale empty cache) in place. Guarded on the epoch the read was
					// issued for: a rotated lifecycle must not be given the previous run's text.
					var latest = runById(rid);
					if (latest && String(latest.startedAt || '') === String(view.startedAt || '')) {
						resultRetry.delete(identity(latest));
						var preview = previewOfOut(out);
						resultCache.set(identity(latest), { key: resultKeyOf(latest), text: preview });
						latest.resultPreview = preview;
						sweepCard();
					}
				}
				mBody.appendChild(pre);
			})
			.catch(function (e) { if (!viewCurrent(view, 'result', rid)) return; mBody.innerHTML = '<div class="mmxdwf-stats">读取失败: ' + esc(String(e)) + '</div>'; });
	}

	// ---- artifact modal: inline text from memory, or authenticated fetch -> preview/Blob ----
	function openArtifact(run, index) {
		var rid = identity(run);
		var view = beginView('artifact', rid);
		var arts = (run.artifacts || []);
		var art = arts[Number(index)] || {};
		var safeName = String(art.title || art.path || 'artifact').split(/[\\/]/).pop().replace(/[^\w.\-\u9fa5]+/g, '_') || 'artifact';
		mTitle.textContent = '产物 · ' + (run.name || rid);
		mBody.innerHTML = '';
		var pre = document.createElement('pre');
		pre.className = 'mmxdwf-code';
		pre.textContent = '加载产物中…';
		mBody.appendChild(pre);
		// F06: an inline text artifact is already in the /runs payload. The same `pre` and the
		// same modal render it, with textContent (never innerHTML), and the file endpoint is not
		// called at all — it could only answer 404 for an artifact that was never published to
		// disk. The lifecycle guard is still recorded, so a late/rotated response is discarded.
		if (isInlineTextArtifact(art)) {
			showTextPreview(pre, art.text, 65536, safeName + '.txt');
			return;
		}
		apiFetch('/artifact?' + runQuery(run, 'index=' + encodeURIComponent(index)))
			.then(function (res) {
				if (!res.ok) {
					return res.json().catch(function () { return {}; }).then(function (b) {
						throw new Error((b && b.error) || ('读取失败（HTTP ' + res.status + '）'));
					});
				}
				var ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
				if (/^text\//i.test(ct) || /\bjson\b/i.test(ct)) return res.text().then(function (t) { return { text: t }; });
				return res.blob().then(function (blob) { return { blob: blob, ct: ct }; });
			})
			.then(function (out) {
				if (!viewCurrent(view, 'artifact', rid)) return;
				if (out.text !== undefined) { pre.textContent = out.text; return; }
				var url = trackBlobUrl(URL.createObjectURL(out.blob));
				mBody.innerHTML = '';
				var info = document.createElement('div');
				info.className = 'mmxdwf-stats';
				info.textContent = '已通过认证 API 获取文件（Blob 链接不含任何凭据），已触发下载：';
				var a = document.createElement('a');
				a.href = url;
				a.download = safeName;
				a.textContent = '下载 ' + safeName;
				a.className = 'mmxdwf-hbtn';
				mBody.appendChild(info);
				mBody.appendChild(a);
				try { a.click(); } catch (e) {}
			})
			.catch(function (e) {
				if (!viewCurrent(view, 'artifact', rid)) return;
				pre.textContent = '产物读取失败：' + String(e && e.message || e);
			});
	}

	// ---- full agent/log lists (truncation must always have a full view) ----
	function openAgentsFull(run) {
		var rid = identity(run);
		beginView('agents', rid); // recorded for the lifecycle guard; the list renders synchronously
		mTitle.textContent = '子代理 · ' + (run.name || rid);
		mBody.innerHTML = '';
		var latest = runById(rid) || run;
		var calls = latest.calls || [];
		if (!calls.length) { mBody.innerHTML = '<div class="mmxdwf-stats">（无调用记录）</div>'; return; }
		var box = document.createElement('div');
		box.className = 'mmxdwf-hcalls';
		calls.forEach(function (c) {
			var line = document.createElement('div');
			line.textContent = (CALL_STATE[c.state] || c.state) + ' · ' + (c.label || c.callId)
				+ (c.usage ? ' · ' + fmtTokens((c.usage.input || 0) + (c.usage.output || 0)) + ' tokens' : '')
				+ (c.durationMs != null ? ' · ' + fmtMs(c.durationMs) : '');
			box.appendChild(line);
		});
		mBody.appendChild(box);
	}
	function openLogsFull(run) {
		var rid = identity(run);
		beginView('logs', rid); // recorded for the lifecycle guard; the list renders synchronously
		mTitle.textContent = '日志 · ' + (run.name || rid);
		mBody.innerHTML = '';
		var latest = runById(rid) || run;
		var logs = latest.logs || [];
		if (!logs.length) { mBody.innerHTML = '<div class="mmxdwf-stats">（无日志）</div>'; return; }
		var pre = document.createElement('pre');
		pre.className = 'mmxdwf-code';
		pre.textContent = logs.map(function (l) { return l.text; }).join('\n');
		mBody.appendChild(pre);
	}

	// ---- history modal: GLOBAL list, unbound runs are clearly labelled; explicit bind ----
	function relTime(iso) {
		if (!iso) return '';
		var d = Date.now() - new Date(iso).getTime();
		if (d < 60000) return '刚刚';
		if (d < 3600000) return Math.floor(d / 60000) + '分钟前';
		if (d < 86400000) return Math.floor(d / 3600000) + '小时前';
		return Math.floor(d / 86400000) + '天前';
	}
	var historyRuns = [];
	function renderHistory() {
		if (!mBody) return;
		mBody.innerHTML = '';
		var cur = currentSessionId();
		var head = document.createElement('div');
		head.className = 'mmxdwf-stats';
		head.textContent = cur ? '全局历史（含未绑定会话的运行）· 当前会话 ' + cur : '全局历史（含未绑定会话的运行）· 当前未检测到活动会话';
		mBody.appendChild(head);
		var list = historyRuns;
		if (!list.length) { mBody.innerHTML = '<div class="mmxdwf-stats">还没有任何运行</div>'; return; }
		var statusColor = { running: '#ff9f0a', cancelling: '#ff9f0a', completed: '#34c759', failed: '#ff5f56', cancelled: '#8b8f99', stale: '#8b8f99' };
		list.forEach(function (r) {
			var rid = identity(r);
			var row = document.createElement('div');
			row.className = 'mmxdwf-hrow';
			var phases = r.phases || [];
			var settled = phases.reduce(function (a, p) { return a + (p.settled || 0) + (p.rejected || 0); }, 0);
			var total = phases.reduce(function (a, p) { return a + (p.dispatched || 0); }, 0);
			var tok = r.tokens && ((r.tokens.input || 0) + (r.tokens.output || 0)) > 0 ? ' · ' + fmtTokens((r.tokens.input || 0) + (r.tokens.output || 0)) + ' tokens' : '';
			var el = r.elapsedMs != null ? ' · ' + fmtMs(r.elapsedMs) : '';
			row.innerHTML = '<span class="mmxdwf-badge ' + esc(r.status) + '" style="border:1px solid;color:' + (statusColor[r.status] || '#9a9ea8') + ';border-color:currentColor;border-radius:10px;padding:1px 9px;font-size:11px;white-space:nowrap;">' + esc(STATUS_CN[r.status] || r.status) + '</span>'
				+ '<span class="mmxdwf-hname">' + esc(r.name || r.runId) + '</span><span class="mmxdwf-hid">' + esc(r.runId) + '</span>'
				+ '<span class="mmxdwf-hmeta">' + settled + '/' + total + tok + el + ' · ' + esc(relTime(r.updatedAt)) + '</span>';
			var binding = bindingOf(r);
			var tag = document.createElement('span');
			tag.className = 'mmxdwf-hid';
			tag.textContent = binding ? binding.invalid ? '归属数据无效（未认领会话）' : binding.native ? '原生会话 ' + binding.host + ' / ' + binding.sessionId : '已绑定会话 ' + binding.sessionId : '未绑定会话';
			row.appendChild(tag);
			var btns = document.createElement('span');
			btns.style.display = 'inline-flex';
			btns.style.gap = '6px';
			// Fail-closed: with no verifiable current session there is no identity to attribute
			// to, so no bind control is offered at all (neither live nor disabled) — a dead
			// control would only promise an action this client will never take. A native (or
			// quarantined) run is excluded for the same reason: bindRunToSession refuses it.
			if (cur) {
				var bindBtn = document.createElement('button');
				bindBtn.className = 'mmxdwf-hbtn';
				bindBtn.setAttribute('data-act', 'bindcurrent');
				bindBtn.setAttribute('data-hrun', rid);
				bindBtn.textContent = '绑定当前会话';
				if (!binding || !binding.native) btns.appendChild(bindBtn);
			}
			if (binding && !binding.native) {
				var unbindBtn = document.createElement('button');
				unbindBtn.className = 'mmxdwf-hbtn';
				unbindBtn.setAttribute('data-act', 'unbindcurrent');
				unbindBtn.setAttribute('data-hrun', rid);
				unbindBtn.textContent = '解除绑定';
				btns.appendChild(unbindBtn);
			}
			row.appendChild(btns);
			mBody.appendChild(row);
			var calls = document.createElement('div');
			calls.className = 'mmxdwf-hcalls';
			calls.style.display = 'none';
			// F07: the expansion control is a NATIVE <button>, so it is focusable, reachable with
			// Tab, and activated by Enter/Space by the platform — none of which a div with a click
			// handler can offer. It carries aria-expanded, and the call list it owns is the very
			// same one the row click already built, so the content is unchanged.
			var toggle = document.createElement('button');
			toggle.setAttribute('type', 'button');   // never a submit: the modal is not in a form
			toggle.className = 'mmxdwf-hbtn';
			toggle.setAttribute('data-act', 'htoggle');
			toggle.setAttribute('aria-expanded', 'false');
			toggle.setAttribute('aria-controls', 'mmxdwf-hcalls');
			toggle.textContent = (r.calls || []).length ? '子代理 ' + (r.calls || []).length : '子代理';
			toggle.title = '展开/收起这个运行的子代理调用记录';
			calls.id = 'mmxdwf-hcalls';
			btns.appendChild(toggle);
			// ONE handler for the whole row: a click on the button bubbles here exactly once, so
			// the button and the row background stay in step without a second toggle path.
			row.addEventListener('click', function (ev) {
				if (ev.target && ev.target.closest && ev.target.closest('[data-act="bindcurrent"],[data-act="unbindcurrent"]')) return;
				var open = calls.style.display !== 'block';
				calls.style.display = open ? 'block' : 'none';
				toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
				if (open && !calls.childElementCount) {
					var items = (r.calls || []).map(function (c) {
						return '<div>' + esc(CALL_STATE[c.state] || c.state) + ' · ' + esc(c.label || c.callId) + (c.usage ? ' · ' + fmtTokens((c.usage.input || 0) + (c.usage.output || 0)) + ' tokens' : '') + (c.durationMs != null ? ' · ' + fmtMs(c.durationMs) : '') + '</div>';
					}).join('') || '<div>（无调用记录）</div>';
					calls.innerHTML = items;
				}
			});
			mBody.appendChild(calls);
		});
	}
	function openHistory() {
		var view = beginView('history', null);
		mTitle.textContent = '工作流历史（全局）';
		mBody.innerHTML = '<div class="mmxdwf-stats">加载中…</div>';
		apiFetch('/runs', { cache: 'no-store' })
			.then(apiJson)
			.then(function (b) {
				if (!viewCurrent(view, 'history', null)) return;
				historyRuns = (b && b.runs) || [];
				renderHistory();
			})
			.catch(function (e) {
				if (!viewCurrent(view, 'history', null)) return;
				mBody.innerHTML = '<div class="mmxdwf-stats">读取失败: ' + esc(String(e)) + '</div>';
			});
	}

	// Augment each finished run in the current card pool with a result preview for the card
	// (from the engine's out.json via the host API; progress.json itself does not carry it).
	// Off-pool runs are never hydrated: their previews would be fetched but never shown.
	// F04: the empty preview used to be a TERMINAL verdict. A non-2xx, an unreadable body and an
	// explicit ok:false all collapsed onto the same branch and wrote
	// `resultCache.set(id, { key, text: '' })`; because the key is (identity, startedAt,
	// updatedAt, status) and a settled run never changes any of those again, a single transient
	// 5xx froze "no preview" for the whole lifecycle — the /runs poll could never retry it and a
	// successful manual 结果 read could not repair it. Only a 404 is a real answer.
	//
	// The split is exactly 1004.md's: 404 stays negatively cached (measured 5000+ refetches a
	// day without it), everything recoverable is remembered as a BACKOFF and retried. The
	// backoff is counted in /runs poll ticks — the poll the client already runs is the only
	// clock, so no timer, no new framework and nothing to disarm at teardown. A new lifecycle
	// key, or a new client, drops the record and reads again at once.
	var RESULT_RETRY_STEPS = [1, 2, 4, 8, 16];   // polls to wait before attempt n+1
	var RESULT_RETRY_MAX_TRIES = 8;               // then the key waits for a change, not for us
	var resultRetry = new Map();
	var pollTick = 0;
	function resultKeyOf(run) {
		return identity(run) + ':' + String(run.startedAt || '') + ':' + run.updatedAt + ':' + run.status;
	}
	function previewOfOut(out) {
		var raw = out && out.result !== undefined ? (typeof out.result === 'string' ? out.result : JSON.stringify(out.result))
			: out && out.error ? String(out.error) : '';
		return raw.length > 1200 ? raw.slice(0, 1200) + '…（已截断，点击查看全文）' : raw;
	}
	function noteTransientResult(id, key) {
		var r = resultRetry.get(id);
		if (!r || r.key !== key) r = { key: key, tries: 0, dueTick: 0 };
		r.tries++;
		r.dueTick = r.tries >= RESULT_RETRY_MAX_TRIES
			? Infinity
			: pollTick + RESULT_RETRY_STEPS[Math.min(r.tries, RESULT_RETRY_STEPS.length) - 1];
		resultRetry.set(id, r);
	}
	function hydrateResults() {
		sessionPool().forEach(function (run) {
			if (isLive(run)) { resultCache.delete(identity(run)); resultRetry.delete(identity(run)); return; }
			var id = identity(run);
			var key = resultKeyOf(run);
			var cached = resultCache.get(id);
			if (cached && cached.key === key) { run.resultPreview = cached.text; return; }
			// A CHANGED key is never gated: the backoff belongs to the key that failed.
			var retry = resultRetry.get(id);
			if (retry && retry.key === key) {
				if (retry.tries >= RESULT_RETRY_MAX_TRIES) return;
				if (pollTick < retry.dueTick) return;
			}
			if (resultPending.has(key)) return;
			resultPending.add(key);
			apiFetch('/result?' + runQuery(run))
				.then(function (res) {
					if (!res.ok) return { status: res.status, body: null, transient: res.status !== 404 };
					return res.json().then(
						function (b) { return { status: res.status, body: b, transient: !(b && b.ok) }; },
						function () { return { status: res.status, body: null, transient: true }; });
				})
				.then(function (x) {
					if (stopped) return;
					var latest0 = runById(id);
					if (!latest0 || resultKeyOf(latest0) !== key) return;
					if (x.body && x.body.ok) {
						resultRetry.delete(id);
						var text = previewOfOut(x.body.out);
						resultCache.set(id, { key: key, text: text });
						latest0.resultPreview = text;
						sweepCard();
						return;
					}
					if (x.transient) {
						// Remembered as a backoff, never as content: the card simply keeps no
						// preview until a later poll is allowed to read again.
						noteTransientResult(id, key);
						return;
					}
					// Definite "there is no out.json for this lifecycle" — the deliberate
					// negative cache. Without it the client refetched the same 404 every poll.
					resultRetry.delete(id);
					resultCache.set(id, { key: key, text: '' });
					latest0.resultPreview = '';
					sweepCard();
				}).catch(function () {
					// A dead socket says nothing about whether out.json exists, so it is paced
					// like any other transient failure (it was already retryable; now bounded).
					if (stopped) return;
					noteTransientResult(id, key);
				}).finally(function () { resultPending.delete(key); });
		});
	}

	// Fail-visible sweeps: a swallowed sweep error must reach the console (rate-limited to
	// distinct messages) — a silent catch once hid a wedged instance for an entire session.
	var lastSweepError = '';
	function reportSweepError(where, e) {
		var msg = where + ': ' + (e && e.message ? e.message : String(e));
		if (msg === lastSweepError) return;
		lastSweepError = msg;
		try { console.error('[mmxdwf] ' + msg); } catch (e2) {}
	}
	// Per-run UI state is pruned to the surviving run list so long sessions do not
	// accumulate controls, log markers, result caches, script texts and visible ids forever
	// (024-R4). scriptCache is keyed by identity+startedAt, so the surviving keys are rebuilt
	// from the live runs rather than split out of the cache key.
	function prunePerRunState() {
		var liveIds = new Set(runs.map(function (r) { return identity(r); }));
		controls.forEach(function (_, id) { if (!liveIds.has(id)) controls.delete(id); });
		lastLogCount.forEach(function (_, id) { if (!liveIds.has(id)) lastLogCount.delete(id); });
		resultCache.forEach(function (_, id) { if (!liveIds.has(id)) resultCache.delete(id); });
		resultRetry.forEach(function (_, id) { if (!liveIds.has(id)) resultRetry.delete(id); });
		var liveScriptKeys = {};
		runs.forEach(function (r) { liveScriptKeys[identity(r) + ':' + String(r.startedAt || '')] = 1; });
		for (var k in scriptCache) if (!Object.prototype.hasOwnProperty.call(scriptCache, k) || !liveScriptKeys[k]) delete scriptCache[k];
		var before = visibleRuns.size;
		visibleRuns.forEach(function (id) { if (!liveIds.has(id)) visibleRuns.delete(id); });
		if (visibleRuns.size !== before) saveVisible();
	}
	// F19: an unknown mutation result is reconciled with the /runs snapshot we already poll —
	// never by guessing and never by resending. An answer whose qId is no longer `waiting` was
	// consumed (or dropped) by the engine; a stop whose run is no longer live took effect; a
	// resume whose run is no longer resumable — or whose epoch already rotated, in which case
	// controlsFor() has rebuilt the control anyway — took effect. While the snapshot cannot tell
	// us, the control stays locked: the draft and the visible state are the user's evidence.
	function reconcileUnconfirmed() {
		controls.forEach(function (state, id) {
			var run = runById(id);
			if (!run || run.startedAt !== state.startedAt) return; // stale epoch: controlsFor rebuilds it
			state.answers.forEach(function (a, qId) {
				if (a.status !== UNCONFIRMED) return;
				var q = (run.questions || []).filter(function (x) { return x && x.qId === qId; })[0];
				if (!q || q.state !== 'waiting') { a.status = ''; a.error = ''; }
			});
			if (state.resume === UNCONFIRMED && !['failed', 'cancelled', 'stale'].includes(run.status)) state.resume = '';
			if (state.stop === UNCONFIRMED && !isLive(run)) state.stop = '';
		});
	}
	function tick() {
		if (stopped || pollInFlight) return;
		pollInFlight = true;
		var gen = ++pollGen;
		// The deadline covers the body as well as the request: a /runs that delivers headers and
		// then stalls releases pollInFlight through the ordinary catch below and lands in the
		// existing offline feedback, instead of wedging every later poll.
		apiBounded('/runs', { cache: 'no-store' }, REQUEST_DEADLINE_MS)
			.then(function (x) {
				if (stopped || gen !== pollGen) { pollInFlight = false; return; }
				pollInFlight = false;
				if (x.bodyError) throw x.bodyError;
				if (!x.r.ok) throw new Error('HTTP ' + x.r.status);
				var body = x.b;
				if (!body || !body.ok) throw new Error((body && body.error) || '响应缺少 runs 数据');
				offline = false; lastHttpError = ''; lastSyncAt = Date.now();
				runs = body.runs || [];
				prunePerRunState();
				reconcileUnconfirmed();
				invalidateModalLifecycle();
				pollTick++;   // F04: the /runs poll IS the retry clock; no timer is armed.
				hydrateResults();
				ensureStyle();
				try { sweepCard(); } catch (e) { reportSweepError('sweepCard', e); }
			})
			.catch(function (e) {
				if (stopped || gen !== pollGen) { pollInFlight = false; return; }
				pollInFlight = false;
				offline = true;
				lastHttpError = e && e.message ? String(e.message) : '网络错误';
				try { sweepCard(); } catch (err) { reportSweepError('sweepCard(offline)', err); }
			});
	}

	function sweepAll() {
		ensureStyle();
		try { sweepCard(); } catch (e) { reportSweepError('sweepCard', e); }
	}

	function start() {
		var timer = null, initialTick = null, cancelReady = null;
		// Chromium intensively throttles timers while the window is hidden (measured: a
		// 1500ms timeout did not fire for 8s), so a window brought back to front could wait
		// a minute for the next frozen tick. A catch-up poll fires immediately on becoming
		// visible; the trailing one covers a single-flight skip (024-R4).
		var visibilityHandler = function () {
			if (stopped || document.visibilityState !== 'visible') return;
			tick();
			window.setTimeout(function () { if (!stopped) tick(); }, 1600);
		};
		document.addEventListener('visibilitychange', visibilityHandler);
		window.__mmxDwfTeardown = function () {
			stopped = true;
			pollGen++;
			if (cancelReady) cancelReady();
			if (timer !== null) window.clearInterval(timer);
			if (initialTick !== null) window.clearTimeout(initialTick);
			document.removeEventListener('visibilitychange', visibilityHandler);
			var card = document.getElementById(CARD_ID);
			if (card) card.remove();
			restoreAnchor();
			revokeModalBlobs();
			historyRuns = [];
			var modal = document.getElementById(MODAL_ID);
			if (modal) modal.remove();
			unmountGlobalEntry();
			var style = document.getElementById(STYLE_ID);
			if (style) style.remove();
			// The theme attribute is ours alone (no host selector reads it): leaving it behind
			// would keep a stale palette marker on <html> after the injection stopped.
			try { if (document.documentElement && document.documentElement.removeAttribute) document.documentElement.removeAttribute('data-mmxdwf-theme'); } catch (e) {}
			mEl = null; mTitle = null; mBody = null; modalView = null; modalReturnFocus = null;
			window.__mmxDwfInstalled = false;
			delete window.__mmxDwfInternals;
		};
		cancelReady = whenDomReady(function () {
			if (stopped) return;
			ensureStyle();
			timer = window.setInterval(tick, POLL_MS);
			initialTick = window.setTimeout(tick, 400);
		});
	}

	// MiniMax Code has no module lifecycle; start immediately (once, thanks to the marker).
	start();

	// Read-only seam for the pending session-binding integration: an adapter can ask which
	// session a run belongs to (capability is NOT exposed, and neither is any mutator).
	// Bind/unbind exist ONLY as the result of a click inside our own modal — exposing them on a
	// writable global would let any page script mint a binding record that is indistinguishable
	// on disk from one the user actually made.
	window.__mmxDwfInternals = {
		identity: identity,
		currentSessionId: currentSessionId,
		bindingOf: bindingOf,
	};
})();
