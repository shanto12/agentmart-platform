/* AgentMart web — runtime configuration.
   Production API base. Everything the site does goes through this URL. */
window.AGENTMART_API = "https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api";

/* Local development only: ?api=http://localhost:8787 overrides the base URL,
   but ONLY when the page itself is served from localhost / 127.0.0.1.
   On any other host the parameter is ignored. */
(function () {
  try {
    var host = window.location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return;
    var override = new URLSearchParams(window.location.search).get("api");
    if (override && /^https?:\/\/[^\s]+$/i.test(override)) {
      window.AGENTMART_API = override.replace(/\/+$/, "");
    }
  } catch (e) { /* keep production default */ }
})();

/* Sign in with Google (OpenID redirect, id_token flow: no client secret in the browser).
   Paste the OAuth *Web client ID* between the quotes to switch the button on;
   while it is empty the "Continue with Google" button is not rendered at all.
   AUTH_GOOGLE is derived from the API base (.../functions/v1/api -> .../functions/v1/auth-google),
   so the localhost-only ?api override above applies to it as well. */
window.AGENTMART_GOOGLE_CLIENT_ID = "520260006751-oaolv1vlcni9d8u5eo300hbrllclhlvn.apps.googleusercontent.com";
window.AGENTMART_AUTH_GOOGLE = String(window.AGENTMART_API).replace(/\/+$/, "").replace(/\/api$/, "") + "/auth-google";
