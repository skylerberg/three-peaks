export const APP_NAME = 'Three Peaks Hub';
// Long enough to read a code off one screen and type it into another, short
// enough that a screenshot of it is worthless by the time anybody finds it.
export const CANVA_PAIRING_CODE_TTL_MINUTES = 10;

// Idle days, not absolute. Authentication slides a session's expiry forward
// once it is past the halfway mark, so this is what a session gets from its
// last use rather than from its creation, and the only ones that lapse are the
// ones nobody came back to. An absolute month signed out people who had used
// the app that morning, which costs a login and buys nothing: the token it
// ended was never idle.
export const SESSION_TTL_DAYS = 365;
