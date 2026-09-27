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
