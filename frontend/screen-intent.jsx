/* ============================================================
   screen-intent.jsx — Q2: "WHAT'S <NAME>'S SONG ABOUT?" capture.
   Reuses the subject named in Q1 (window.__participantName) to
   personalize the prompt. The submitted string is emitted to ONE
   isolated handler (window.IntentSink) → backend as the `answer`.
   ============================================================ */

/* the single isolated sink for the typed intent */
const IntentSink = {
  value: null,
  history: [],
  listeners: new Set(),
  submit(str) {
    this.value = str;
    this.history.push({ text: str, ts: Date.now() });
    this.listeners.forEach((fn) => { try { fn(str); } catch (e) {} });
    return str;
  },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};
window.IntentSink = IntentSink;

const INTENT_MAX = 70;

function ScreenIntent({ active, onAdvance }) {
  const [val, setVal] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const taRef = React.useRef(null);
  const canvasRef = React.useRef(null);

  const len = val.length;
  const over = len > INTENT_MAX;
  const canSubmit = val.trim().length > 0 && !over && !submitting;

  // autofocus so the keyboard opens when this screen becomes active
  React.useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => { try { taRef.current && taRef.current.focus(); } catch (e) {} }, 140);
    return () => clearTimeout(id);
  }, [active]);

  // Lock-in countdown so this step has a hard, predictable time limit and the
  // phone stays in lockstep with the stage. The intent must be in before the
  // gather window closes and voting opens; when it closes we auto-submit whatever
  // is typed and advance to the vote — so your words still count and everyone
  // moves to voting together (no arriving at voting before others).
  const [secsLeft, setSecsLeft] = React.useState(null);
  const submittedRef = React.useRef(false);
  const valRef = React.useRef('');
  React.useEffect(() => { valRef.current = val; }, [val]);
  React.useEffect(() => {
    if (!active || !window.Net || !window.Net.on) return;
    submittedRef.current = false;
    const off = window.Net.on('tug', (m) => {
      if (!m) return;
      if (m.phase === 'gathering' && typeof m.timeRemaining === 'number') {
        setSecsLeft(Math.max(0, Math.ceil(m.timeRemaining)));
      } else if (m.phase === 'collecting' && !submittedRef.current) {
        submittedRef.current = true;
        setSecsLeft(0);
        const t = (valRef.current || '').trim();
        if (t) { try { window.IntentSink && window.IntentSink.submit(t); } catch (e) {} }
        onAdvance && onAdvance(); // lockstep: jump to the vote the instant it opens
      }
    });
    return off;
  }, [active]);

  // dissolve: emit neon particles drifting upward from the text
  const runParticles = () => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = r.width * dpr; cv.height = r.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    const ps = [];
    const n = Math.min(150, 50 + val.length * 4);
    for (let i = 0; i < n; i++) {
      ps.push({
        x: W * (0.12 + Math.random() * 0.76), y: H * (0.30 + Math.random() * 0.32),
        vx: (Math.random() - 0.5) * 1.6, vy: -(1.2 + Math.random() * 3.2),
        life: 1, decay: 0.008 + Math.random() * 0.016, size: 1.5 + Math.random() * 3.2,
        col: Math.random() < 0.5 ? '#00E5FF' : '#FF1A8C',
      });
    }
    let raf, frames = 0;
    const loop = () => {
      frames++;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]; p.x += p.vx; p.y += p.vy; p.vy *= 0.99; p.vx *= 0.98; p.life -= p.decay;
        if (p.life <= 0) { ps.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * p.life, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (ps.length && frames < 130) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  };

  const submit = () => {
    if (!canSubmit) return;
    submittedRef.current = true;          // claim the submit so auto-submit won't double-fire
    haptic([0, 30, 30, 60]);
    IntentSink.submit(val.trim());        // -> isolated handler (mock; swap for backend)
    setSubmitting(true);
    runParticles();
    setTimeout(() => {
      setSubmitting(false);
      setVal('');
      onAdvance && onAdvance();           // flow: Intent -> Name
    }, 1500);
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  // Personalize Q2 with the subject they named in Q1: "WHAT'S <NAME>'S SONG ABOUT?".
  const who = ((typeof window !== 'undefined' && window.__participantName) || '').trim();
  return (
    <div className="screen intent">
      <div className="intent-head">
        <span className="screen-kicker">JOIN THE ROOM{secsLeft != null && secsLeft > 0 ? ' · ' + secsLeft + 'S TO LOCK IN' : ''}</span>
        <h1 className="intent-title">{who
          ? <React.Fragment>WHAT'S <span className="accent">{who.toUpperCase()}</span>'S SONG ABOUT?</React.Fragment>
          : <React.Fragment>WHAT'S YOUR SONG ABOUT?</React.Fragment>}</h1>
      </div>

      <div className="intent-box-wrap">
        {!submitting ? (
          <textarea
            ref={taRef}
            className={'intent-input' + (val.trim() ? ' has' : '') + (over ? ' over' : '')}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKey}
            placeholder="a wild night, a secret talent, an inside joke…"
            rows={3}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <div className="intent-dissolve" aria-hidden="true">
            {val.trim().split('').map((ch, i) => (
              <span key={i} style={{ animationDelay: (i * 16) + 'ms' }}>{ch === ' ' ? '\u00A0' : ch}</span>
            ))}
          </div>
        )}
        <div className={'intent-counter' + (over ? ' over' : '')}>{len}/{INTENT_MAX}</div>
        <canvas ref={canvasRef} className="intent-canvas" />
      </div>

      <div className="intent-foot thumb">
        <button className="intent-send wide" disabled={!canSubmit} onClick={submit}>
          <span className="is-label">SEND IT</span>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </div>
  );
}

window.ScreenIntent = ScreenIntent;
