/* ============================================================
   phone-net.js — phone glue. Loaded LAST (after app.jsx), so every
   partner global (window.IntentSink, window.CrowdSim) already exists.
   Wires the two seams that net-tug.js / net-crowd.js don't own:

     NAME (join)   -> Net.send({type:"join", name})
                      stores participantId from Net.on("joined")
                      into window.__participantId.
     INTENT (answer) -> wraps window.IntentSink.submit so it ALSO sends
                        Net.send({type:"answer", participantId, text}),
                        preserving the original behaviour.

   We never edit partner files; everything here is a window-global
   override / monkey-patch. Audience text is only ever passed as JSON
   over the wire (never written to the DOM here), so no innerHTML risk.
   ============================================================ */
(function () {
  'use strict';

  // ---- participant identity ----
  window.__participantId = window.__participantId || null;
  let joinSent = false;
  let pendingAnswer = null; // answer typed before join completes (see ordering note)

  // Room code + host token survive reloads via sessionStorage, so a phone that
  // refreshes (or re-joins each round) stays in the same room and keeps the crown.
  function ssGet(k) { try { return sessionStorage.getItem(k) || null; } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
  // Seed the code from the QR URL (?code=XXXX) on first load.
  (function seedCodeFromUrl() {
    try {
      var u = new URL(window.location.href);
      var c = u.searchParams.get("code");
      if (c) ssSet("bs_code", c.trim().toUpperCase());
    } catch (e) {}
  })();
  window.__roomCode = ssGet("bs_code");
  window.__isHost = false;
  window.__hostName = null;

  if (window.Net && window.Net.on) {
    window.Net.on('joined', function (msg) {
      if (msg && msg.participantId != null) {
        window.__participantId = msg.participantId;
        if (msg.isHost) window.__isHost = true;
        if (msg.hostToken) ssSet("bs_hostToken", msg.hostToken);
        if (msg.code) { window.__roomCode = msg.code; ssSet("bs_code", msg.code); }
        window.dispatchEvent(new CustomEvent("bs:hoststate"));
        // Flush any answer that was typed before the join completed, now bound.
        if (pendingAnswer != null) {
          window.Net.send({ type: 'answer', participantId: window.__participantId, text: pendingAnswer });
          pendingAnswer = null;
        }
      }
    });
  }

  // ---- NAME -> join. Idempotent: only the FIRST real name joins, so we
  //      keep ONE stable participantId (answer/pull must reference it). ----
  function submitName(name) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return;
    window.__participantName = n; // the song's subject — Q2 reuses it: "What's <NAME>'s song about?"
    if (joinSent) return;
    joinSent = true;
    if (window.Net) window.Net.send({ type: 'join', name: n, code: window.__roomCode || undefined, hostToken: ssGet("bs_hostToken") || undefined });
  }
  window.submitName = submitName;

  // A new round clears everyone on the backend, so the phone must re-join: forget
  // the old (now-invalid) id and allow the next name submit to register again.
  window.__resetJoinState = function () {
    joinSent = false;
    window.__participantId = null;
  };

  // ---- Best-effort auto-hook for the NAME screen (screen-texture.jsx).
  //      That screen's only outbound is CrowdSim.addWord(text); it fires
  //      for BOTH the form submit (a typed name) and emoji taps. We join
  //      on the first non-emoji word only. This is lossy by design — see
  //      the note below; the clean fix is a one-liner the lead can add. ----
  const EMOJI_RE = /^[\p{Extended_Pictographic}☀-➿️‍\s]+$/u;
  function looksLikeEmoji(t) {
    try { return EMOJI_RE.test(t); } catch (e) { return /^[^A-Za-z0-9]+$/.test(t); }
  }
  if (window.CrowdSim && typeof window.CrowdSim.addWord === 'function') {
    const origAddWord = window.CrowdSim.addWord.bind(window.CrowdSim);
    window.CrowdSim.addWord = function (text) {
      const r = origAddWord(text);
      try {
        const t = String(text || '').trim();
        // First real (non-emoji) name → join; the shell auto-advances on 'joined'.
        if (t && !joinSent && !looksLikeEmoji(t)) submitName(t);
      } catch (e) {}
      return r;
    };
  }

  // ---- INTENT -> answer. Wrap IntentSink.submit, keep original behaviour. ----
  function wrapIntent() {
    const sink = window.IntentSink;
    if (!sink || typeof sink.submit !== 'function' || sink.__netWrapped) return false;
    const orig = sink.submit.bind(sink);
    sink.submit = function (str) {
      const out = orig(str);                 // preserve dissolve/history/listeners
      try {
        const text = String(str || '').trim();
        if (text) {
          // NAME (join) comes AFTER INTENT in the tab order, so the
          // participantId may not exist yet. If it's here, bind now; otherwise
          // BUFFER the answer and the 'joined' handler flushes it bound to the
          // real id (resolves the ordering without editing partner files).
          if (window.__participantId != null) {
            window.Net.send({ type: 'answer', participantId: window.__participantId, text: text });
          } else {
            pendingAnswer = text;
          }
        }
      } catch (e) {}
      return out;
    };
    sink.__netWrapped = true;
    return true;
  }

  // IntentSink is defined when screen-intent.jsx runs (Babel-transpiled async),
  // so it may not exist yet at this script's first tick. Retry briefly.
  if (!wrapIntent()) {
    let tries = 0;
    const id = setInterval(function () {
      if (wrapIntent() || ++tries > 100) clearInterval(id);
    }, 50);
  }

  // ---- VIBE pick -> report the selected option index to the backend. ScreenVibe
  //      renders the DJ's options as ordered `.vibe-card` buttons; the clicked
  //      index IS the option index. Delegated so we never edit the partner screen.
  document.addEventListener('click', function (e) {
    const card = e.target && e.target.closest ? e.target.closest('.vibe-card') : null;
    if (!card) return;
    const cards = Array.prototype.slice.call(document.querySelectorAll('.vibe-card'));
    const index = cards.indexOf(card);
    if (index >= 0 && window.Net) window.Net.send({ type: 'vibe', index: index });
  });

  Net.on("join_rejected", function (m) {
    window.__joinRejected = (m && m.reason) || "bad_code";
    // The join guard was set when the name was submitted; clear it so the user
    // can fix the code and re-submit (otherwise submitName() no-ops forever).
    if (window.__resetJoinState) window.__resetJoinState();
    window.dispatchEvent(new CustomEvent("bs:joinrejected", { detail: window.__joinRejected }));
  });
  Net.on("host_granted", function (m) {
    if (m && m.hostToken) ssSet("bs_hostToken", m.hostToken);
    window.__isHost = true;
    window.dispatchEvent(new CustomEvent("bs:hoststate"));
  });
  Net.on("room_state", function (m) {
    if (!m) return;
    window.__hostName = m.hostName;
    window.__roomCrowd = m.crowd;
    // SELF-HEAL: this backend has exactly one room, and the server tells every
    // phone its current code on connect + on every change. So always sync to the
    // room that is actually open/live — never depend on the QR carrying a code or
    // on a cached one. This makes a bare phone-live.html link join the current
    // room, and a tab left open across a host restart re-join the NEW room.
    if ((m.lobbyState === "open" || m.lobbyState === "live") && m.code) {
      if (window.__roomCode !== m.code) {
        var hadJoined = !!window.__participantId || joinSent;
        window.__roomCode = m.code;
        ssSet("bs_code", m.code);
        if (hadJoined) {
          // We were in a now-defunct room — drop stale identity and re-join the
          // new one with the name we already have.
          ssSet("bs_hostToken", null);
          window.__isHost = false;
          if (window.__resetJoinState) window.__resetJoinState();
          if (window.__participantName && window.Net) {
            joinSent = true;
            window.Net.send({ type: "join", name: window.__participantName, code: m.code });
          }
          window.dispatchEvent(new CustomEvent("bs:hoststate"));
        }
      }
    }
    window.dispatchEvent(new CustomEvent("bs:roomstate", { detail: m }));
  });
  window.PhoneRoom = {
    setCode: function (c) { window.__roomCode = (c || "").trim().toUpperCase(); ssSet("bs_code", window.__roomCode); },
    hasCode: function () { return !!window.__roomCode; },
    code: function () { return window.__roomCode; },
    isHost: function () { return !!window.__isHost; },
    hostName: function () { return window.__hostName; },
    crowd: function () { return window.__roomCrowd || 0; },
    startShow: function () { if (window.Net) window.Net.send({ type: "host_start", hostToken: ssGet("bs_hostToken") || undefined }); },
    advance: function () { if (window.Net) window.Net.send({ type: "advance", hostToken: ssGet("bs_hostToken") || undefined }); },
    endShow: function () { if (window.Net) window.Net.send({ type: "host_end", hostToken: ssGet("bs_hostToken") || undefined }); },
    addSimPlayers: function (n) { if (window.Net) window.Net.send({ type: "add_sim_players", count: n || 4 }); },
  };

  /* ============================================================
     SEAM NOTE FOR THE LEAD (flagged, not silently patched):

     1) NAME join hook is best-effort. The clean one-line fix lives in
        screen-texture.jsx's form `submit` (around line 37 — NOT tapEmoji):
            window.submitName && window.submitName(val);
        That guarantees the join uses the typed name and never an emoji.

     2) TAB ORDER (RESOLVED by buffering, no partner edit): MODES order is
        VIBE -> INTENT -> NAME -> TUG, so the INTENT `answer` is typed BEFORE
        the NAME `join`. We buffer the answer (pendingAnswer) and the 'joined'
        handler flushes it bound to the real participantId. Works regardless of
        screen order. (If a user answers but never enters a name, the answer is
        simply never sent — the backend falls back to a sample seed.)
     ============================================================ */
})();
