/* ============================================================
   audioEngine.js — gapless crossfade between streaming Suno songs.
   Plays each song from its progressive stream URL via a plain <audio>
   element and crossfades by ramping .volume (CORS-proof; desktop Chrome).
   The CURRENT element always loops, so there is never dead air while the
   next song is still generating (the "not-ready" fallback).
   Exposes window.AudioEngine.
   ============================================================ */
(function () {
  "use strict";

  // A song plays at least `minPlaySec`, then crossfades to the next AS SOON AS it
  // is ready — so the loop stays tight (brief loading, then the next song plays and
  // everyone returns to voting). If the next isn't ready yet, the current keeps
  // looping (never dead air) and crosses the moment it arrives.
  let minPlaySec = 22;
  let fadeSec = 6;
  let onPlaying = () => {};

  const voices = new Map(); // id -> { song, el, durationSec, startedAt }
  let current = null;
  let pending = null;
  let crossTimer = null;
  let fadeTimer = null;
  let crossing = false;
  let paused = false;
  let pausedAt = null;
  let onState = () => {};

  const now = () => performance.now() / 1000;

  function buildVoice(song) {
    const el = new Audio();
    el.src = song.streamUrl;
    el.preload = "auto";
    // NO crossOrigin: we only ramp .volume (no Web Audio / no sample reads), so a
    // plain no-cors <audio> plays cross-origin media fine. Setting crossOrigin here
    // would demand CORS headers the Suno /stream endpoint does NOT send → the element
    // errors and the stage goes silent. Keep it off (matches this file's "CORS-proof").
    el.loop = true; // never gap; crossfade replaces it
    el.volume = 0;
    // Mirror the REAL element state to the dashboard the instant it changes — by
    // any cause (control, autoplay unblock, crossfade). These fire even when the
    // stage tab is backgrounded (where the 1s polling timer throttles), so the
    // dashboard's play/pause readout never goes stale.
    el.addEventListener("play", emitState);
    el.addEventListener("pause", emitState);
    el.addEventListener("playing", emitState);
    const voice = { song, el, durationSec: null, startedAt: null };
    voices.set(song.id, voice);
    return voice;
  }

  // Start an element and only report onPlaying once playback ACTUALLY began.
  // If the browser blocks autoplay (no user gesture yet) the show must not
  // advance on a silent stage — unblock() retries on the first click.
  function startPlayback(voice) {
    const p = voice.el.play();
    if (p && p.then) {
      p.then(function () { onPlaying(voice.song.id); })
        .catch(function (e) { console.warn("play() blocked:", e.message); });
    } else {
      onPlaying(voice.song.id);
    }
  }

  function makeCurrent(voice) {
    voice.el.volume = 1;
    voice.startedAt = now();
    current = voice;
    startPlayback(voice);
    emitState();
    log(`▶ playing ${voice.song.id} — ${voice.song.name} · ${voice.song.genre}`);
  }

  // Crossfade as soon as the next song is ready, after the current has played a
  // short minimum. (Called when `pending` arrives.) If pending shows up after the
  // minimum, wait is 0 → crossfade immediately, no long gap.
  function maybeCross() {
    if (!current || !pending || crossing || paused) return;
    const elapsed = now() - current.startedAt;
    const wait = Math.max(0, minPlaySec - elapsed);
    if (crossTimer) clearTimeout(crossTimer);
    crossTimer = setTimeout(crossfade, wait * 1000);
    log(`⤬ crossfade ${current.song.id}→next in ${wait.toFixed(1)}s`);
  }

  // Force the crossfade now (dashboard "Next song" / testing).
  function forceCross() {
    if (current && pending && !crossing && !paused) {
      if (crossTimer) clearTimeout(crossTimer);
      crossfade();
    }
  }

  function crossfade() {
    if (!current || !pending || crossing) return;
    crossing = true;
    const from = current;
    const to = pending;
    pending = null;
    if (crossTimer) { clearTimeout(crossTimer); crossTimer = null; }
    log(`⤬ transitioning ${from.song.id} → ${to.song.id}`);

    // Time-based fade on a setInterval — NOT requestAnimationFrame. rAF is paused
    // for hidden/background tabs, which would leave the swap (and onPlaying)
    // hanging and `crossing` stuck, freezing the whole show on the current song.
    // setInterval still fires when backgrounded (throttled to ~1s), and volume is
    // derived from wall-clock time, so the swap always completes.
    const halfMs = Math.max(150, fadeSec * 500);
    const t0 = performance.now();
    let swapped = false;
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = setInterval(function () {
      const t = performance.now() - t0;
      if (!swapped) {
        from.el.volume = Math.max(0, 1 - Math.min(1, t / halfMs));
        if (t >= halfMs) {
          // SWAP — the must-happen transition (fires even when backgrounded).
          from.el.pause();
          from.el.src = "";
          voices.delete(from.song.id);
          current = to;
          to.el.volume = 0;
          to.startedAt = now();
          startPlayback(to);
          emitState();
          swapped = true;
        }
      } else {
        to.el.volume = Math.min(1, (t - halfMs) / halfMs);
        if (t >= halfMs * 2) {
          to.el.volume = 1;
          clearInterval(fadeTimer);
          fadeTimer = null;
          crossing = false;
          log(`✓ now playing ${to.song.id}`);
          maybeCross(); // in case the next one is already queued
        }
      }
    }, 50);
  }

  const AudioEngine = {
    init(opts) {
      fadeSec = opts.fadeSec ?? fadeSec;
      minPlaySec = opts.minPlaySec ?? opts.segmentSec ?? minPlaySec;
      onPlaying = opts.onPlaying ?? onPlaying;
      onState = opts.onState ?? onState;
      emitState();
    },

    // Force the next song in now (testing / dashboard "Next song").
    forceNext() { forceCross(); },

    pause() {
      if (paused || !current) return;
      paused = true;
      pausedAt = now();
      if (crossTimer) clearTimeout(crossTimer);
      crossTimer = null;
      voices.forEach((voice) => voice.el.pause());
      emitState();
      log(`Ⅱ paused ${current.song.id}`);
    },

    play() {
      // Always (re)start the current song — don't gate on the internal `paused`
      // flag. The flag can drift from reality (e.g. the browser blocked the first
      // autoplay so the element is paused while the flag says "not paused"); the
      // dashboard PLAY button must recover from that, not no-op.
      if (!current) return;
      const pauseDuration = pausedAt == null ? 0 : now() - pausedAt;
      current.startedAt += pauseDuration;
      paused = false;
      pausedAt = null;
      startPlayback(current);
      emitState();
      maybeCross();
      log(`▶ resumed ${current.song.id}`);
    },

    // Retry playback that the browser blocked before any user gesture existed.
    // Called from the stage's first-click audio unlock. Does nothing while the
    // DJ has intentionally paused, or when audio is already running.
    unblock() {
      if (!current || paused || !current.el.paused) return;
      log(`▶ retrying blocked playback of ${current.song.id}`);
      startPlayback(current);
      emitState();
    },

    // Remove a skipped song if it is queued. Never stop the current song here.
    cancel(id) {
      if (!pending || pending.song.id !== id) return;
      if (crossTimer) clearTimeout(crossTimer);
      crossTimer = null;
      pending.el.pause();
      pending.el.src = "";
      voices.delete(id);
      pending = null;
      emitState();
      log(`× cancelled queued ${id}`);
    },

    // Full show reset: stop playback and clear every buffered voice.
    reset() {
      if (crossTimer) clearTimeout(crossTimer);
      crossTimer = null;
      if (fadeTimer) clearInterval(fadeTimer);
      fadeTimer = null;
      voices.forEach((voice) => {
        voice.el.pause();
        voice.el.src = "";
      });
      voices.clear();
      current = null;
      pending = null;
      crossing = false;
      paused = false;
      pausedAt = null;
      emitState();
      log("■ audio reset");
    },

    // A song's streaming URL is ready to play.
    ready(song) {
      if (voices.has(song.id)) return; // dedupe
      const voice = buildVoice(song);
      if (!current) makeCurrent(voice); // cold start
      else {
        pending = voice;
        emitState();
        maybeCross();
      }
    },

    // The clean CDN url arrived. Pacing no longer depends on it (segment-based),
    // so this is just a hook — a future upgrade could swap a long-looping
    // current voice from the stream to the seekable m4a for fidelity.
    final(id, finalUrl) {
      const voice = voices.get(id);
      if (voice) voice.finalUrl = finalUrl;
      log(`⏱ ${id} final m4a ready`);
    },
  };

  function emitState() {
    const el = current ? current.el : null;
    const dur = el && isFinite(el.duration) ? el.duration : 0;
    onState({
      // Report whether audio is ACTUALLY producing sound (the element's own
      // state), not our internal intent flag — so the dashboard mirrors reality.
      playing: !!el && !el.paused,
      canSkip: !!pending,
      song: current ? current.song : null,
      nextSong: pending ? pending.song : null,
      position: el ? el.currentTime || 0 : 0,
      duration: dur,
    });
  }

  // Re-emit ~1×/s so the dashboard's progress bar + time stay live as the song plays.
  setInterval(function () { if (current) emitState(); }, 1000);

  function log(msg) {
    if (window.__spineLog) window.__spineLog(msg);
    console.log("[engine]", msg);
  }

  window.AudioEngine = AudioEngine;
})();
