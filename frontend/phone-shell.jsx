/* ============================================================
   phone-shell.jsx — OUR linear walkthrough shell (replaces the partner's
   swipeable-tab app.jsx on the live page). Reuses the partner's screen
   components verbatim; we only sequence them like a form.

   Flow:
     NEW participant:       NAME -> VIBE -> INTENT -> VOTE -> (loading)
     RETURNING participant: VIBE -> VOTE -> (loading)
   When the collecting round buzzes (backend 'generating'/'round_result'),
   we show a LOADING screen ("your track is being made"). When the next
   collecting round begins, we restart the appropriate sequence.

   Screens advance via: NAME/VIBE -> a "Next" button (they don't self-advance);
   INTENT -> its own onAdvance (after the dissolve); VOTE -> round-driven.
   ============================================================ */
const { useState, useEffect, useRef, useCallback, useLayoutEffect } = React;

// Vibe ("Pick the Vibe") step removed from the flow for now (code kept, unused).
// EVERYONE walks the whole flow every round — name → intent → vote. Returning
// participants don't auto-skip the name screen; they re-confirm with a Continue
// tap (their join is idempotent, so no duplicate) before stating a fresh intent.
const MIN_PLAYERS = 2; // a show needs at least this many in the room to start
const SEQ_NEW = ['name', 'intent', 'vote'];
const SEQ_RETURNING = ['name', 'intent', 'vote'];

/* Map the backend `show_ended` payload (SavedSong[]) to the recap track shape
   ScreenRecap expects: {id,title,genre,by,dur,fileName,downloadUrl}. SavedSong
   carries no duration, so we use a sensible placeholder for the player ticker. */
function mapSavedSongs(songs) {
  if (!Array.isArray(songs)) return [];
  return songs.map((s) => ({
    id: s.id,
    title: (s.title || 'UNTITLED').toUpperCase(),
    genre: (s.genre || '').toUpperCase(),
    by: s.name || '—',
    dur: 200,
    fileName: s.fileName,
    downloadUrl: s.downloadUrl,
    lyrics: s.lyrics || '', // shown in the full-screen lyrics view when a track is tapped
  }));
}

function PhoneShell() {
  const crowd = useCrowdState();
  const [joined, setJoined] = useState(!!window.__participantId);
  const [participated, setParticipated] = useState(false); // completed one full pass
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(null); // {name, genre, answer} from round_result
  const [scale, setScale] = useState(1);
  // On a real phone, drop the simulated-iPhone frame and fill the screen; keep the
  // framed preview only on wider (desktop) viewports.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  const [ended, setEnded] = useState(false);   // show over -> ScreenRecap (merged from design-handoff)
  const [recapTracks, setRecapTracks] = useState([]);
  const [round, setRound] = useState(0);       // current backend round (drives per-round re-join)
  // ?set=<id> → open straight to the persistent playlist recap for that set.
  const [playlistView] = useState(() => { try { return new URL(location.href).searchParams.get('set'); } catch (e) { return null; } });
  const [playlistUrl, setPlaylistUrl] = useState(() => (typeof location !== 'undefined' ? location.href : ''));
  const [needCode, setNeedCode] = useState(() => { try { if (new URL(location.href).searchParams.get('set')) return false; } catch (e) {} return !window.PhoneRoom || (!window.PhoneRoom.hasCode() && !window.__participantId); });
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [isHost, setIsHost] = useState(() => !!(window.PhoneRoom && window.PhoneRoom.isHost()));
  const [hostName, setHostName] = useState(null);
  const [started, setStarted] = useState(false); // reactive show-started flag (drives host buttons)
  const [roomCount, setRoomCount] = useState(0); // live crowd size, for the waiting room
  const [endArmed, setEndArmed] = useState(false); // two-tap End show (no native confirm)
  const endArmTimer = useRef(null);

  const seq = participated ? SEQ_RETURNING : SEQ_NEW;
  const screen = seq[Math.min(step, seq.length - 1)];

  // refs for use inside the (once-bound) Net listeners
  const formedRound = useRef(0);
  const loadingRef = useRef(false);
  loadingRef.current = loading;

  // ---- start the networked sims (app.jsx did this on mount) ----
  useEffect(() => {
    try { window.CrowdSim.start && window.CrowdSim.start(); } catch (e) {}
    try { window.Tug.start && window.Tug.start('follower'); } catch (e) {}
  }, []);

  // ---- static CSS vars + per-frame energy color (app.jsx did this via tweaks) ----
  useLayoutEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--magenta', '#FF1A8C');
    r.setProperty('--cyan', '#00E5FF');
    r.setProperty('--glow', '1');
    r.setProperty('--grain', '0.07');
    r.setProperty('--disp', "'Space Grotesk', system-ui, sans-serif");
  }, []);
  useEffect(() => window.CrowdSim.on('frame', (s) => {
    const r = document.documentElement.style;
    r.setProperty('--energy', (s.energy || 0).toFixed(4));
    r.setProperty('--ecolor', s.color || '#FF1A8C');
  }), []);

  // ---- responsive: scale the framed preview (desktop) + detect real mobile ----
  useEffect(() => {
    const fit = () => {
      setScale(Math.min(window.innerWidth / 402, window.innerHeight / 874, 1));
      setIsMobile(window.matchMedia('(max-width: 600px)').matches);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // ---- backend-driven transitions ----
  useEffect(() => {
    const offJoined = window.Net.on('joined', () => setJoined(true));
    const toLoading = () => { setLoading(true); setParticipated(true); };
    const offGen = window.Net.on('generating', toLoading);
    const offRR = window.Net.on('round_result', (m) => setReveal(m));
    // SET COMPLETE: the DJ ended the show. Flip to the recap playlist built from
    // the real saved songs in the broadcast payload (falls back to setlist.js).
    const offEnded = window.Net.on('show_ended', (m) => {
      const songs = (m && m.songs) || [];
      setRecapTracks(mapSavedSongs(songs));
      setEnded(true);
      setLoading(false);
      // A shareable link to THIS set's persistent playlist (its first song's time
      // is the set id) so the recap can be revisited after the show / a refresh.
      if (songs.length && songs[0].createdAt) {
        setPlaylistUrl(location.origin + '/phone-live.html?set=' + Date.parse(songs[0].createdAt));
      }
    });
    // a fresh show (reset / "start a new show") clears the recap AND the old join
    // so the phone is ready to join the NEW session cleanly from the name screen.
    const offReset = window.Net.on('show_reset', () => {
      setEnded(false); setRecapTracks([]);
      setStarted(false); setJoined(false); setStep(0);
      if (window.__resetJoinState) window.__resetJoinState();
    });
    // Authoritative backend flow state — drives loading/reveal/walkthrough.
    const offShow = window.Net.on('show_state', (m) => {
      if (!m) return;
      setStarted(!!(m && m.started));
      if (m.phase === 'idle') {
        formedRound.current = 0;
        setRound(0);
        setLoading(false);
        setReveal(null);
        setStep(0);
        return;
      }
      if (m.phase === 'generating') {
        setLoading(true);
        setParticipated(true);
        if (m.seed) setReveal(m.seed);
        return;
      }
      // 'gathering' (name-cloud window) is the START of a round — same reset as
      // collecting: drop the loading screen and put the user into name/intent.
      if (m.phase === 'gathering' || m.phase === 'collecting') {
        const changedRound = m.round !== formedRound.current;
        formedRound.current = m.round;
        setRound(m.round);
        // A new round means a new set is live again — leave the recap.
        setEnded(false);
        if (loadingRef.current || changedRound) {
          setLoading(false);
          setReveal(null);
          setStep(0);
        }
      }
    });
    const offTug = window.Net.on('tug', (m) => {
      if (m && m.phase === 'idle') {
        formedRound.current = 0;
        setRound(0);
        setLoading(false);
        setReveal(null);
      } else if (m && (m.phase === 'gathering' || m.phase === 'collecting') && m.round !== formedRound.current) {
        formedRound.current = m.round;
        setRound(m.round);
        // A new collecting round means a new set is live again — leave the recap.
        setEnded(false);
        // Only RESET the walkthrough for a brand-new song round (i.e. we were
        // waiting on the loading screen). A pre-start cold-start round must NOT
        // wipe progress the user already made.
        if (loadingRef.current) {
          setLoading(false);
          setReveal(null);
          setStep(0);
        }
      }
    });
    return () => { offJoined(); offGen(); offRR(); offEnded(); offReset(); offShow(); offTug(); };
  }, []);

  const next = useCallback(() => setStep((s) => Math.min(s + 1, seq.length - 1)), [seq.length]);

  // ?set=<id> — open straight to that set's persistent playlist recap (no join).
  useEffect(() => {
    if (!playlistView) return;
    fetch('/api/playlist/' + encodeURIComponent(playlistView))
      .then((r) => r.json())
      .then((d) => { setRecapTracks(mapSavedSongs((d && d.songs) || [])); setEnded(true); })
      .catch(() => {});
  }, [playlistView]);

  // A new round (>1) clears everyone on the backend — re-join: forget the old id
  // and drop to the NAME screen so the user re-types their name into the mix.
  useEffect(() => {
    if (round > 1) {
      if (window.__resetJoinState) window.__resetJoinState();
      setJoined(false);
      setStep(0);
    }
  }, [round]);

  // ---- host/room/rejection event subscriptions ----
  useEffect(() => {
    const onHost = () => setIsHost(!!(window.PhoneRoom && window.PhoneRoom.isHost()));
    const onRoom = (e) => {
      const m = e.detail;
      setHostName(m ? m.hostName : null);
      if (m && typeof m.crowd === 'number') setRoomCount(m.crowd);
      // Self-heal: a room is open/live → phone-net has adopted its code, so skip
      // the manual code screen and let the user join the current room.
      if (m && (m.lobbyState === 'open' || m.lobbyState === 'live') && m.code) {
        setCodeError('');
        setNeedCode(false);
      }
    };
    const onRej = (e) => { setNeedCode(true); setCodeError(e.detail === 'busy' ? 'A show is already running' : 'Wrong code — try again'); };
    window.addEventListener('bs:hoststate', onHost);
    window.addEventListener('bs:roomstate', onRoom);
    window.addEventListener('bs:joinrejected', onRej);
    return () => {
      window.removeEventListener('bs:hoststate', onHost);
      window.removeEventListener('bs:roomstate', onRoom);
      window.removeEventListener('bs:joinrejected', onRej);
    };
  }, []);

  // NAME step (Q1 "Who's your song about?") auto-advances the moment the join
  // registers — naming the subject moves you to Q2 "What's <NAME>'s song about?".
  // `joined` is reset every round, so this
  // fires fresh each time (no instant-skip) for everyone, new or returning.
  useEffect(() => {
    // Auto-advance name → intent ONLY once the show has started. Before the host
    // presses START, the name screen IS the lobby: the user shouts a name and
    // waits, and the host needs their START button (which lives on this screen) to
    // stay put. Advancing pre-show would strand the host on intent/vote with no
    // way to start, and intent/vote do nothing while no round is running.
    if (!loading && screen === 'name' && joined && started) {
      const id = setTimeout(() => setStep((s) => (seq[s] === 'name' ? Math.min(s + 1, seq.length - 1) : s)), 400);
      return () => clearTimeout(id);
    }
  }, [loading, screen, joined, seq, started]);

  // INTENT step: focus the field as soon as it shows so the keyboard is up
  // (desktop). iOS needs a tap to open the soft keyboard — unavoidable there.
  useEffect(() => {
    if (!loading && screen === 'intent') {
      const id = setTimeout(() => { const el = document.querySelector('.intent-input'); if (el) { try { el.focus(); } catch (e) {} } }, 200);
      return () => clearTimeout(id);
    }
  }, [loading, screen]);

  // ---- code gate: show before the name flow if no code is cached/from URL ----
  if (needCode) {
    return (
      <div className="screen code-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, padding: 20 }}>
        <div className="screen-kicker" style={{ letterSpacing: '0.2em', opacity: 0.6 }}>ENTER ROOM CODE</div>
        <input
          value={codeInput}
          onChange={(e) => { setCodeInput(e.target.value.toUpperCase().slice(0, 4)); setCodeError(''); }}
          placeholder="CODE"
          maxLength={4}
          autoCapitalize="characters"
          style={{ width: 160, textAlign: 'center', fontFamily: 'monospace', fontSize: 34, letterSpacing: '0.3em', padding: '12px 0', borderRadius: 12, border: '1px solid #333', background: '#15151F', color: '#00E5FF' }}
        />
        {codeError ? <div style={{ color: '#FF7A9F', fontSize: 13 }}>{codeError}</div> : null}
        <button
          onClick={() => {
            if (codeInput.length !== 4) { setCodeError('4 letters'); return; }
            window.PhoneRoom.setCode(codeInput);
            setNeedCode(false);
          }}
          style={{ padding: '12px 30px', borderRadius: 999, border: 'none', background: '#00E5FF', color: '#0A0A0F', fontWeight: 700, letterSpacing: '0.06em' }}
        >JOIN</button>
      </div>
    );
  }

  // ---- waiting room: you're in, before the host starts the show ----
  // Shown once joined and before the show starts. Confirms the join, shows the
  // live room count, and gives the host the START button (others see a waiting
  // status). Auto-replaced by the name→intent→vote flow the moment the show starts.
  if (joined && !started && !ended && !loading) {
    const myName = (window.__participantName || '').toUpperCase();
    const waitInner = (
      <div className="phone">
        <Background />
        <div className="screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: '70px 26px 40px', textAlign: 'center', boxSizing: 'border-box' }}>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.3em', color: '#8C8C9C' }}>YOU'RE IN</div>
          <div style={{ fontFamily: "'Space Grotesk',system-ui,sans-serif", fontWeight: 800, fontSize: 38, lineHeight: 1.04, background: 'linear-gradient(90deg,#00E5FF,#FF1A8C)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', wordBreak: 'break-word' }}>{myName || 'YOU'}</div>
          <div className="bs-countpulse" style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'JetBrains Mono',monospace", fontSize: 14, letterSpacing: '0.08em', color: '#B48CFF' }}>
            <span className="bs-livedot" />
            <span><b style={{ color: '#fff', fontSize: 18 }}>{roomCount}</b> in the room</span>
          </div>
          <div style={{ marginTop: 18, width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {isHost ? (
              roomCount >= MIN_PLAYERS ? (
                <button
                  onClick={() => window.PhoneRoom.startShow()}
                  style={{ width: '100%', padding: '16px 20px', borderRadius: 999, border: 'none', background: '#FF1A8C', color: '#0A0A0F', fontFamily: "'Space Grotesk',system-ui,sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: '0.05em', boxShadow: '0 0 40px rgba(255,26,140,0.4)' }}
                >👑 EVERYBODY'S IN — START</button>
              ) : (
                <div style={{ fontFamily: "'Space Grotesk',system-ui,sans-serif", fontSize: 15, color: '#8C8C9C' }}>
                  you're the host — waiting for at least 1 more player to join<span className="bs-dots">…</span>
                </div>
              )
            ) : (
              <div style={{ fontFamily: "'Space Grotesk',system-ui,sans-serif", fontSize: 15, color: '#8C8C9C' }}>
                waiting for {hostName || 'the host'} to start the show<span className="bs-dots">…</span>
              </div>
            )}
            {isHost ? (
              <button
                onClick={() => window.PhoneRoom.addSimPlayers(4)}
                style={{ width: '100%', padding: '11px 16px', borderRadius: 999, border: '1px solid rgba(0,229,255,0.4)', background: 'transparent', color: '#7fdfff', fontFamily: "'Space Grotesk',system-ui,sans-serif", fontWeight: 600, fontSize: 12.5, letterSpacing: '0.04em' }}
              >＋ Add test players</button>
            ) : null}
          </div>
        </div>
        <style>{"@keyframes bsdots{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}} .bs-dots{animation:bsdots 1.4s ease-in-out infinite}" +
          "@keyframes bspulse{0%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.04)}100%{opacity:.55;transform:scale(1)}} .bs-countpulse{animation:bspulse 1.8s ease-in-out infinite}" +
          "@keyframes bsdot{0%{box-shadow:0 0 0 0 rgba(45,211,111,.5)}70%{box-shadow:0 0 0 7px rgba(45,211,111,0)}100%{box-shadow:0 0 0 0 rgba(45,211,111,0)}} .bs-livedot{width:8px;height:8px;border-radius:50%;background:#2dd36f;display:inline-block;animation:bsdot 1.6s ease-out infinite}"}</style>
      </div>
    );
    return isMobile ? (
      <div id="stage" className="stage-bare">{waitInner}</div>
    ) : (
      <div id="stage">
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}>
          <IOSDevice dark width={402} height={874}>{waitInner}</IOSDevice>
        </div>
      </div>
    );
  }

  // ---- render ----
  // The actual app surface. On real mobile it fills the screen directly; on desktop
  // it sits inside the simulated-iPhone preview frame.
  const phoneInner = (
    <div className="phone">
      <Background />

      {ended ? (
        <ScreenRecap tracks={recapTracks} onBack={() => setEnded(false)} playlistUrl={playlistUrl} />
      ) : (
      <React.Fragment>
      <ShellProgress seq={seq} step={step} loading={loading} />

      <div className="deck shell-deck">
        <div className="deck-pane">
          {loading ? (
            <LoadingScreen reveal={reveal} />
          ) : screen === 'name' ? (
            <ScreenTexture active />
          ) : screen === 'vibe' ? (
            <ScreenVibe active />
          ) : screen === 'intent' ? (
            <ScreenIntent active onAdvance={next} />
          ) : (
            <VoteScreen />
          )}
        </div>
      </div>

      {/* (Pre-show host START / waiting status now live on the dedicated waiting
          room screen, shown once joined and before the show starts.) */}

      {/* footer Next — only VIBE needs it (name auto-advances on join;
          intent self-advances on send; vote is round-driven) */}
      {!loading && screen === 'vibe' && (
        <div className="shell-foot">
          <button className="shell-next" onClick={next}>NEXT →</button>
        </div>
      )}

      {/* End show — host only. Two-tap to confirm (no native confirm() dialog,
          which is unreliable on mobile). Top-right; the vote countdown is
          left-aligned (see .vs-timer-head) so it never sits under this. */}
      {started && isHost ? (
        <button
          onClick={() => {
            if (endArmed) { if (endArmTimer.current) clearTimeout(endArmTimer.current); setEndArmed(false); window.PhoneRoom.endShow(); }
            else { setEndArmed(true); if (endArmTimer.current) clearTimeout(endArmTimer.current); endArmTimer.current = setTimeout(() => setEndArmed(false), 3000); }
          }}
          style={{ position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 10px)', right: 12, padding: '7px 13px', borderRadius: 999, border: '1px solid ' + (endArmed ? '#FF1A8C' : 'rgba(255,26,140,0.5)'), background: endArmed ? '#FF1A8C' : 'rgba(10,10,16,0.72)', backdropFilter: 'blur(6px)', color: endArmed ? '#0A0A0F' : '#FF7A9F', fontWeight: endArmed ? 700 : 400, fontSize: 11, letterSpacing: '0.05em', zIndex: 40 }}
        >{endArmed ? 'Tap again to end' : 'End show'}</button>
      ) : null}
      </React.Fragment>
      )}
    </div>
  );

  // A shared playlist link (?set=) opened on a desktop/laptop should read as a real
  // web page — full-bleed brand backdrop + a centered column — not the simulated
  // iPhone preview (fake status bar + bezel) that the live join flow uses.
  if (playlistView && !isMobile) {
    return (
      <div id="stage" className="playlist-web">
        <div className="playlist-web-col">{phoneInner}</div>
      </div>
    );
  }

  // Real phone → fill the screen (no fake device frame). Desktop → framed preview.
  const Stage = isMobile ? (
    <div id="stage" className="stage-bare">{phoneInner}</div>
  ) : (
    <div id="stage">
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}>
        <IOSDevice dark width={402} height={874}>{phoneInner}</IOSDevice>
      </div>
    </div>
  );
  return Stage;
}

/* tiny step indicator (dots) */
function ShellProgress({ seq, step, loading }) {
  return (
    <div className="shell-steps">
      {seq.map((s, i) => (
        <i key={s} className={'shell-dot' + (!loading && i === step ? ' on' : '') + (!loading && i < step ? ' done' : '')} />
      ))}
    </div>
  );
}

/* loading / "awaiting the next song" screen */
function LoadingScreen({ reveal }) {
  return (
    <div className="screen loading-screen">
      <div className="screen-kicker">HANG TIGHT</div>
      <h1 className="screen-title">THE NEXT TRACK<br /><span className="accent">IS COOKING</span></h1>
      <div className="ls-orb" aria-hidden="true"><span /><span /><span /></div>
      {reveal ? (
        <div className="ls-next">
          <span className="ls-next-k">NEXT UP</span>
          <span className="ls-next-name">{reveal.name}</span>
          <span className="ls-next-genre">{reveal.genre}</span>
          {reveal.answer ? <span className="ls-next-line">“{reveal.answer}”</span> : null}
        </div>
      ) : (
        <p className="vibe-help">Cooking the next drop from the crowd…</p>
      )}
    </div>
  );
}

/* VOTE: two big genre buttons — tap or hold either one to pull for that genre.
   Replaces the partner's pick-a-side ScreenTug (no side-select, no localStorage,
   no white-screen). Genre names + live % come from the networked window.Tug. */
function VoteScreen() {
  const [, force] = useState(0);
  const tugRef = useRef(window.Tug.getState());
  useEffect(() => {
    let raf = null;
    const off = window.Tug.on('tug', (s) => {
      tugRef.current = s;
      if (!raf) raf = requestAnimationFrame(() => { raf = null; force((n) => n + 1); });
    });
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // TAP ONLY — one pull per tap. Holding is intentionally NOT auto-fired: a held
  // finger used to rapid-pull (setInterval) which is overpowered. Each discrete
  // tap = one pull, so spamming distinct taps is the only way to push your genre.
  const fire = (side) => { try { window.Tug.pull(side, 0.62); } catch (e) {} if (navigator.vibrate) navigator.vibrate(12); };
  const down = (side) => (e) => { e.preventDefault(); fire(side); };
  const up = () => {};

  const t = tugRef.current;
  const G = window.Tug.GENRES;
  const aPct = Math.round((1 - t.p) * 100);
  const pct = { A: aPct, B: 100 - aPct };

  const btn = (side) => {
    const g = G[side] || { name: side, color: side === 'A' ? '#00E5FF' : '#FF1A8C' };
    return (
      <button
        className={'vs-btn vs-' + side.toLowerCase() + (pct[side] >= 50 ? ' lead' : '')}
        style={{ '--c': g.color }}
        onPointerDown={down(side)}
        onPointerUp={up}
        onPointerLeave={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="vs-fill" style={{ height: pct[side] + '%' }} />
        <span className="vs-genre">{g.name}</span>
        <span className="vs-pct">{pct[side]}<i>%</i></span>
        <span className="vs-cta"><i className="vs-dot" />TAP TO WIN</span>
      </button>
    );
  };

  const tr = t.timeRemaining || 0;
  const tt = t.timeTotal || 0;
  const collecting = !!t.collecting;
  const timeFrac = tt > 0 ? Math.max(0, Math.min(1, tr / tt)) : 0;

  // Lockstep: the battle is only LIVE while the big screen is collecting votes.
  // Until then (the gather window, right after locking in your intent) hold on a
  // "you're in" screen so the phone never jumps to voting ahead of the stage.
  if (!collecting) {
    const ga = (G.A && G.A.name) || '', gb = (G.B && G.B.name) || '';
    const ca = (G.A && G.A.color) || '#00E5FF', cb = (G.B && G.B.color) || '#FF1A8C';
    return (
      <div className="screen votescreen vs-hold">
        <div className="vs-hold-k"><i className="vs-dot" />YOU'RE LOCKED IN</div>
        <div className="vs-hold-title">GENRE BATTLE<br />STARTING<span className="bs-dots">…</span></div>
        {ga && gb ? (
          <div className="vs-hold-vs">
            <span style={{ color: ca }}>{ga}</span>
            <em>vs</em>
            <span style={{ color: cb }}>{gb}</span>
          </div>
        ) : null}
        <div className="vs-hold-sub">get ready to tap</div>
      </div>
    );
  }

  return (
    <div className="screen votescreen">
      <div className="vs-timer">
        <div className="vs-timer-head">
          <span>{collecting ? 'VOTE ENDS IN' : 'GET READY'}</span>
          {collecting && <span className="vs-timer-num">{Math.ceil(tr)}s</span>}
        </div>
        <div className="vs-timer-bar"><i style={{ width: (timeFrac * 100) + '%' }} /></div>
      </div>
      <div className="vs-kicker">TAP YOUR GENRE — LOUDEST WINS THE NEXT SONG</div>
      <div className="vs-grid">{btn('A')}{btn('B')}</div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<PhoneShell />);
