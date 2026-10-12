/**
 * Every Easy-Speak host the export runs on (#1047). Its own module, like
 * `basecamp-hosts.ts`, so `wxt.config.ts` can read the host list without
 * importing the bundle contract.
 */
export const EASY_SPEAK_MATCHES = ["https://easy-speak.org/*"] as const;

export const EASY_SPEAK_ORIGIN = "https://easy-speak.org";
