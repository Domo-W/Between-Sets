/* ============================================================
   screen-texture.jsx — Q1: "WHO'S YOUR SONG ABOUT?" (single subject)
   Each player names ONE subject for their track in a single field.
   Submitting joins them (idempotent) and that subject becomes their
   chant identity / seed.name. Editing after submit is intentionally
   not supported — you type, you send, you're locked in for the round.
   Layout: title + input live together as one centered group.
   ============================================================ */
function ScreenTexture({ active, onSubmitted }) {
  // Prefill with the current subject when changing it (joined players); empty for a
  // brand-new joiner.
  const [val, setVal] = useState((typeof window !== 'undefined' && window.__participantName) || '');
  const inputRef = useRef(null);

  // Keep the keyboard up when this screen becomes active.
  useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch (e) {} }, 140);
    return () => clearTimeout(id);
  }, [active]);

  const submit = (e) => {
    e && e.preventDefault();
    const t = val.trim();
    if (!t) return;
    if (window.submitSubject) window.submitSubject(t); // join (first time) or rename (already in)
    else if (window.submitName) window.submitName(t);
    try { haptic(16); } catch (e) {}
    setVal('');
    if (onSubmitted) onSubmitted(); // leave the "change name" editor → back to "locked in"
  };

  return (
    <div className="screen texture subjectq">
      <div className="subq-group">
        <div className="screen-kicker">WHO'S IT ABOUT</div>
        <h1 className="screen-title">WHO'S YOUR<br /><span className="accent">SONG ABOUT?</span></h1>
        <div className="dock">
          <form className="word-form" onSubmit={submit}>
            <input
              ref={inputRef}
              className="word-input"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder="Type a name…"
              maxLength={16}
              enterKeyHint="done"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="word-send" aria-label="lock in" disabled={!val.trim()}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
        </div>
        <p className="subq-hint">One name — they become the star of your track.</p>
      </div>
    </div>
  );
}

window.ScreenTexture = ScreenTexture;
