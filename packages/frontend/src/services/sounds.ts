/**
 * Notification sound service.
 *
 * Wraps `expo-audio` to play short transaction sound effects from
 * `assets/sounds/`. Audio sources are loaded once and cached. If the asset
 * file is missing the service silently no-ops so the rest of the app keeps
 * working.
 */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

type SoundKind = 'sent' | 'received' | 'unlocked';

let initialized = false;

const players: Partial<Record<SoundKind, AudioPlayer>> = {};

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await setAudioModeAsync({
      // Play even when the device is on silent mode (iOS only flag).
      playsInSilentMode: true,
      // Local short SFX; we never want background media playback.
      shouldPlayInBackground: false,
      // Mix with other apps — these are UI feedback sounds, not media.
      interruptionMode: 'mixWithOthers',
    });
  } catch {
    // setAudioModeAsync can fail on web / electron where the native audio
    // module is not linked. That's fine — player.play() will still work on
    // platforms that do support it, or no-op cleanly otherwise.
  }
}

function loadSource(kind: SoundKind): number | null {
  // `require()` is wrapped in try/catch so a missing asset file or a
  // platform that cannot resolve the asset doesn't break the import graph.
  try {
    if (kind === 'sent') return require('../../assets/sounds/sent.mp3');
    if (kind === 'received') return require('../../assets/sounds/received.mp3');
    return require('../../assets/sounds/unlocked.mp3');
  } catch {
    // Asset not bundled or platform cannot resolve — graceful no-op.
    return null;
  }
}

function getPlayer(kind: SoundKind): AudioPlayer | null {
  const existing = players[kind];
  if (existing) return existing;

  const source = loadSource(kind);
  if (source === null) return null;

  try {
    const player = createAudioPlayer(source, { downloadFirst: true });
    players[kind] = player;
    return player;
  } catch {
    // Native audio module unavailable (web/electron without the module,
    // or constructor threw for any other reason) — graceful no-op.
    return null;
  }
}

async function play(kind: SoundKind): Promise<void> {
  await init();
  const player = getPlayer(kind);
  if (!player) return;
  try {
    // Rewind to the start so rapid consecutive triggers restart the sound
    // instead of being ignored.
    await player.seekTo(0);
    player.play();
  } catch {
    // Player error (e.g. already disposed, race on teardown) — ignore.
  }
}

export function playSent(): void {
  void play('sent');
}

export function playReceived(): void {
  void play('received');
}

export function playUnlocked(): void {
  void play('unlocked');
}
