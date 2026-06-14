/* ============================================================
   screen-recap.jsx — phase: ended. "The set you made tonight."
   A playlist PLAYER: tap any track to play it inline (mocked
   playback with a progress ticker + auto-advance), a master
   PLAY ALL transport, a docked now-playing bar, and per-track
   download for saving specific songs.

   MERGED FROM design-handoff (reference only). Adapted for the live app:
     - the orb spinner class is `.recap-orb` (NOT `.ls-orb`) so it does
       not collide with the linear shell's existing `.ls-orb` loader.
     - `tracks` may be passed as a prop (the real `show_ended` payload,
       mapped to {id,title,genre,by,dur,downloadUrl}); falls back to the
       placeholder window.SetList when absent.
     - per-track + save-all downloads hit the real /api/songs/:id/download
       endpoint when a track carries a `downloadUrl`; otherwise they toast.
       Playback is still a simulated ticker (no inline audio yet).
   ============================================================ */
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5 V14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M7 10 L12 15 L17 10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19.5 H19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5 L10 17.5 L19.5 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlayIcon() {
  return (<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5 L19 12 L7 19.5 Z" /></svg>);
}
function PauseIcon() {
  return (<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4.4" height="15" rx="1.2" /><rect x="13.6" y="4.5" width="4.4" height="15" rx="1.2" /></svg>);
}
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.5 14.5 L14.5 9.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M13 7 L14.6 5.4 a3.4 3.4 0 0 1 4.8 4.8 L17.8 11.8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 16.2 L9.4 17.8 a3.4 3.4 0 0 1-4.8-4.8 L6.2 11.4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// trigger a real browser download for a saved song's audio file
function downloadFile(url, name) {
  try {
    const a = document.createElement('a');
    a.href = url;
    if (name) a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {}
}

function ScreenRecap({ onBack, tracks: propTracks, playlistUrl }) {
  const SL = window.SetList || { tracks: [], genreColor: () => '#00E5FF', fmtTime: () => '0:00' };
  const tracks = (Array.isArray(propTracks) && propTracks.length) ? propTracks : SL.tracks;
  const fmt = SL.fmtTime;

  const [stage, setStage] = useState('building');                       // building | ready | empty
  const [currentId, setCurrentId] = useState(tracks.length ? tracks[0].id : null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);                            // seconds into current track
  const [savedIds, setSavedIds] = useState({});
  const [allSaved, setAllSaved] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [toast, setToast] = useState({ msg: '', show: false });
  const toastTimer = useRef(null);
  const curRef = useRef(currentId); curRef.current = currentId;
  const audioRef = useRef(null);
  const [dur, setDur] = useState(0); // real duration from the loaded audio
  const [lyricsId, setLyricsId] = useState(null); // track whose lyrics fill the screen

  useEffect(() => {
    const id = setTimeout(() => setStage(tracks.length ? 'ready' : 'empty'), 1400);
    return () => clearTimeout(id);
  }, [tracks.length]);

  // Keep the audio element pointed at the current track (load on change; the
  // play() calls happen from user-gesture handlers so mobile lets them through).
  useEffect(() => {
    const a = audioRef.current;
    const cur = tracks.find((t) => t.id === currentId);
    if (!a || !cur) return;
    const src = cur.downloadUrl || '';
    if (src && a.getAttribute('src') !== src) { a.setAttribute('src', src); a.load(); }
    setDur(isFinite(a.duration) ? a.duration : 0);
  }, [currentId, tracks]);

  const ping = (msg) => {
    setToast({ msg, show: true }); haptic(12);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, show: false })), 1900);
  };

  const startTrack = (t) => {
    const a = audioRef.current; if (!a || !t) return;
    a.src = t.downloadUrl || '';
    // Surface a playback failure (e.g. an old device that can't decode the file)
    // instead of a silent dead button — tell the user download still works.
    a.play().catch(() => ping('Can’t play here — tap ⬇ to download'));
    curRef.current = t.id; setCurrentId(t.id); setElapsed(0);
  };
  const playTrack = (t) => {
    haptic(8);
    const a = audioRef.current; if (!a) return;
    if (t.id === currentId) { a.paused ? a.play().catch(() => {}) : a.pause(); return; }
    startTrack(t);
  };
  const masterToggle = () => {
    const a = audioRef.current; if (!a) return; haptic(10);
    const cur = tracks.find((t) => t.id === currentId) || tracks[0];
    if (!cur) return;
    if (a.paused) { if (curRef.current !== cur.id || !a.src) startTrack(cur); else a.play().catch(() => {}); }
    else a.pause();
  };
  // when a track finishes, roll into the next one (gesture-free; may be blocked on
  // some mobile browsers — tap-to-play always works, which is the reported bug).
  const onTrackEnded = () => {
    const idx = tracks.findIndex((t) => t.id === curRef.current);
    if (idx > -1 && idx < tracks.length - 1) startTrack(tracks[idx + 1]);
    else setPlaying(false);
  };

  // Tapping a track opens the full-screen lyrics view AND plays it, so you can
  // read along while it streams. Closing returns to the list (audio keeps going).
  const openLyrics = (t) => {
    haptic(10);
    setLyricsId(t.id);
    if (t.id !== currentId || (audioRef.current && audioRef.current.paused)) startTrack(t);
  };
  const closeLyrics = () => setLyricsId(null);

  const saveOne = (t) => {
    if (savedIds[t.id]) return;
    if (t.downloadUrl) downloadFile(t.downloadUrl, t.fileName);
    setSavedIds((s) => ({ ...s, [t.id]: true }));
    ping('Track saved ✓');
  };
  const saveAll = () => {
    // One .zip is the ONLY reliable "save all" on mobile — browsers allow just one
    // file per tap, so looping per-track downloads silently drops all but the first.
    let setId = null;
    try { setId = new URL(playlistUrl || location.href, location.origin).searchParams.get('set'); } catch (e) {}
    const markAll = () => setSavedIds(Object.fromEntries(tracks.map((t) => [t.id, true])));
    if (setId) {
      downloadFile('/api/playlist/' + encodeURIComponent(setId) + '/zip', 'between-sets-' + setId + '.zip');
      markAll(); setAllSaved(true); ping('Downloading the set ✓'); haptic([10, 40, 10]);
      return;
    }
    // Fallback (no set id yet): best-effort per-track.
    const all = {};
    tracks.forEach((t) => { all[t.id] = true; if (t.downloadUrl) downloadFile(t.downloadUrl, t.fileName); });
    setSavedIds(all); setAllSaved(true); ping('All tracks saved ✓'); haptic([10, 40, 10]);
  };
  const copyLink = () => {
    const url = playlistUrl || (location.origin + '/phone-live.html');
    try { navigator.clipboard && navigator.clipboard.writeText(url); } catch (e) {}
    setLinkCopied(true); ping('Link copied ✓');
  };

  const current = tracks.find((t) => t.id === currentId) || null;
  const effDur = dur || (current ? current.dur : 0); // real audio duration, fallback to placeholder
  const pct = effDur ? Math.min(100, (elapsed / effDur) * 100) : 0;
  const masterLabel = playing ? 'PAUSE' : (elapsed > 0 ? 'RESUME' : 'PLAY ALL');

  return (
    <React.Fragment>
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setElapsed(e.target.currentTime || 0)}
        onLoadedMetadata={(e) => setDur(isFinite(e.target.duration) ? e.target.duration : 0)}
        onEnded={onTrackEnded}
      />
      <div className="topbar">
        <span className="live-pill steady"><i className="live-dot" />SET COMPLETE</span>
        <span className="room-stat"><b>{tracks.length}</b>&nbsp;TRACKS</span>
      </div>

      <div className="screen recap">
        <div className="recap-hero">
          <div className="screen-kicker">THAT'S A WRAP</div>
          <h1 className="screen-title">THE SET YOU<br /><span className="accent">MADE TONIGHT</span></h1>

          {stage === 'ready' && (
            <div className="recap-actions">
              <button className="play-all" onClick={masterToggle}>
                {playing ? <PauseIcon /> : <PlayIcon />}{masterLabel}
              </button>
              <button className={'act-icon' + (allSaved ? ' saved' : '')} onClick={saveAll} aria-label="Download all tracks">
                {allSaved ? <CheckIcon /> : <DownloadIcon />}
              </button>
              <button className={'act-icon' + (linkCopied ? ' saved' : '')} onClick={copyLink} aria-label="Copy playlist link">
                <ShareIcon />
              </button>
            </div>
          )}
        </div>

        {stage === 'building' && (
          <div className="recap-mid">
            <div className="recap-orb" aria-hidden="true" />
            <p className="vibe-help">Gathering tonight's tracks…</p>
          </div>
        )}

        {stage === 'empty' && (
          <div className="recap-mid">
            <p className="vibe-help">No tracks finished this session</p>
            {onBack && <button className="recap-ghost" onClick={onBack}>BACK TO THE ROOM</button>}
          </div>
        )}

        {stage === 'ready' && (
          <div className="rc-list">
            {tracks.map((t, i) => {
              const gc = SL.genreColor(t.genre);
              const saved = !!savedIds[t.id];
              const isCur = t.id === currentId;
              return (
                <div className={'rc-row' + (isCur ? ' current' : '')} key={t.id}
                  role="button" tabIndex={0} onClick={() => openLyrics(t)}
                  aria-label={'Play ' + t.title + ' and read the lyrics'}>
                  {isCur && <span className="rc-prog" style={{ width: pct + '%' }} />}
                  <span className="rc-lead" aria-hidden="true">
                    {isCur && playing
                      ? <span className="eq" aria-hidden="true"><i /><i /><i /></span>
                      : isCur ? <PlayIcon /> : String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="rc-main">
                    <span className="rc-title">{t.title}</span>
                    <span className="rc-meta">
                      <span className="rc-genre" style={{ '--gc': gc }}>{t.genre}</span>
                      <span className="rc-by">by {t.by}</span>
                      <span className="rc-dur">{fmt(t.dur)}</span>
                    </span>
                  </div>
                  <button className={'rc-dl' + (saved ? ' saved' : '')}
                    onClick={(e) => { e.stopPropagation(); saveOne(t); }}
                    aria-label={saved ? 'Saved' : 'Download ' + t.title}>
                    {saved ? <CheckIcon /> : <DownloadIcon />}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {stage === 'ready' && current && (
          <div className="np-bar">
            <div className="np-prog"><i style={{ width: pct + '%' }} /></div>
            <div className="np-main">
              <button className="np-play" onClick={masterToggle} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <div className="np-info">
                <span className="np-title">{current.title}</span>
                <span className="np-sub">by {current.by} · {fmt(elapsed)} / {fmt(effDur)}</span>
              </div>
              <button className={'np-dl' + (savedIds[current.id] ? ' saved' : '')} onClick={() => saveOne(current)} aria-label="Download this track">
                {savedIds[current.id] ? <CheckIcon /> : <DownloadIcon />}
              </button>
            </div>
          </div>
        )}
      </div>

      {(() => {
        const lt = lyricsId ? tracks.find((t) => t.id === lyricsId) : null;
        if (!lt) return null;
        return (
          <div className="rc-lyrics" onClick={(e) => e.stopPropagation()}>
            <div className="rcl-top">
              <button className="rcl-back" onClick={closeLyrics} aria-label="Back to the set">‹ Back</button>
              <button className="rcl-play" onClick={masterToggle} aria-label={playing ? 'Pause' : 'Play'}>
                {playing && lt.id === currentId ? <PauseIcon /> : <PlayIcon />}
              </button>
            </div>
            <div className="rcl-head">
              <div className="rcl-title">{lt.title}</div>
              <div className="rcl-by">{lt.genre} · by {lt.by}</div>
            </div>
            <div className="rcl-prog"><i style={{ width: (lt.id === currentId ? pct : 0) + '%' }} /></div>
            <div className="rcl-body">{lt.lyrics ? lt.lyrics : 'No lyrics saved for this track.'}</div>
          </div>
        );
      })()}

      <div className="phone-toast" data-show={toast.show ? '1' : '0'}>{toast.msg}</div>
    </React.Fragment>
  );
}

window.ScreenRecap = ScreenRecap;
