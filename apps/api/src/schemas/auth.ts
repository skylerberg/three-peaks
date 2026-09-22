import { type } from 'arktype';
import { PERSONAL_ACCESS_TOKEN_NAME_LIMITS } from '@three-peaks/shared';
import { email, password, stringWithLength, uuid } from './common.ts';

export const signupRequestSchema = type({
  // Client-supplied so the UI can act optimistically; a duplicate answers 409.
  'id?': uuid,
  email,
  password,
  name: stringWithLength(1, 100),
});

export const loginRequestSchema = type({ email, password });

export const userSchema = type({
  id: 'string',
  email: 'string',
  name: 'string',
  email_verified: 'boolean',
});

export const authResponseSchema = type({
  token: 'string',
  expires_at: 'string',
  user: userSchema,
});

export const sessionSchema = type({
  id: 'string',
  user_agent: 'string | null',
  created_at: 'string',
  expires_at: 'string',
  current: 'boolean',
});

export const sessionListSchema = type({ sessions: sessionSchema.array() });

export const forgotPasswordRequestSchema = type({ email });
export const resetPasswordRequestSchema = type({ token: 'string', password });
export const changePasswordRequestSchema = type({
  current_password: 'string',
  new_password: password,
});

// The secret is never part of this row: it is shown once, in the response that
// created it, and only its hash is stored.
export const personalAccessTokenSchema = type({
  id: 'string',
  name: 'string',
  created_at: 'string',
  last_used_at: 'string | null',
});

export const personalAccessTokenListSchema = type({
  personal_access_tokens: personalAccessTokenSchema.array(),
});

export const createPersonalAccessTokenRequestSchema = type({
  'id?': uuid,
  name: stringWithLength(...PERSONAL_ACCESS_TOKEN_NAME_LIMITS),
});

export const createdPersonalAccessTokenSchema = type({
  token: 'string',
  personal_access_token: personalAccessTokenSchema,
});
