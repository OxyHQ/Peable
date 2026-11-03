import success from './assets/success.m4a';
import failure from './assets/failed.m4a';

/** Brand sound assets only. The host owns playback, mute preference and outcome authority. */
export const checkoutFeedbackSounds = { success, failure } as const;
